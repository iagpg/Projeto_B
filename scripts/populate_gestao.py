"""
scripts/populate_gestao.py
----------------------------
Popula a planilha Google Sheets "BouwObra - Plataforma de Gestão" com:
  - Aba Precificação: custo real (via NF Tiny), encargos e margem por produto
  - Aba Dashboard:    KPIs de vendas do ML

Pré-requisito:
  1. python connectors/google_sheets/auth.py   (uma vez)
  2. python connectors/tiny/auth.py            (uma vez, se necessário)

Uso:
    python scripts/populate_gestao.py

    # Pular a varredura de NFs (usa taxa_ml e custo zero para teste rápido):
    python scripts/populate_gestao.py --skip-nf

    # Pular a busca de pedidos (não atualiza Dashboard):
    python scripts/populate_gestao.py --skip-orders
"""

import json
import sys
import time
import argparse
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

with open(Path(__file__).parent.parent / "config.json") as _f:
    _cfg = json.load(_f)

SHEET_ID       = _cfg.get("gestao_sheet_id", "")
ICMS_VENDA_PCT = float(_cfg.get("icms_venda_pct", 12.0)) / 100
ML_TAXA_DEFAULT = float(_cfg.get("ml_taxa_default_pct", 12.0))

from connectors.google_sheets.client import get_worksheet, clear_and_write, write_dashboard
from connectors.tiny.client          import get as tiny_get
from connectors.tiny.nf              import build_sku_cost_map
from connectors.mercadolivre.orders  import (
    build_sku_mlb_map,
    get_vendas_mes,
    get_pedidos_hoje,
    get_anuncios_status,
    get_item_fees,
    get_taxa_bonus,
    get_frete_envio,
)
from connectors.mercadolivre.client  import get_current_price
from services.precificacao_service import (
    calcular_linha,
    HEADERS_PRECIFICACAO,
    MARGEM_PCT_COL_INDEX,
    CREDITO_COLS,
    DEBITO_COLS,
    MARGEM_COLS,
    STATUS_COL_INDEX,
    STATUS_OPTIONS,
)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _now_str() -> str:
    return datetime.now().strftime("%d/%m/%Y %H:%M")


def _get_all_tiny_products() -> list:
    """Retorna todos os produtos ativos do Tiny (situacao=A), com paginação."""
    print("\n[Tiny] Buscando produtos ativos...")
    all_products = []
    pagina       = 1

    while True:
        data  = tiny_get("/produtos", {"situacao": "A", "pagina": pagina, "limite": 100})
        inner = data.get("data") or data
        items = (
            inner.get("itens")
            or inner.get("produtos")
            or inner.get("items")
            or (inner if isinstance(inner, list) else [])
        )
        if not items:
            break
        all_products.extend(items)

        pag       = inner.get("paginacao") or inner.get("pagination") or {}
        total_pag = int(pag.get("totalPaginas", pag.get("totalPages", 1)) or 1)
        print(f"  Página {pagina}/{total_pag} — {len(all_products)} produtos")
        if pagina >= total_pag:
            break
        pagina += 1
        time.sleep(0.15)

    print(f"  Total de produtos Tiny: {len(all_products)}")
    return all_products


def _extract_sku(produto: dict) -> str:
    return str(
        produto.get("codigo")
        or produto.get("sku")
        or produto.get("code")
        or ""
    ).strip()


# ── Pipeline principal ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-nf",     action="store_true", help="Não varrer NFs (custo = 0)")
    parser.add_argument("--skip-orders", action="store_true", help="Não buscar pedidos ML")
    args = parser.parse_args()

    if not SHEET_ID:
        print("ERRO: gestao_sheet_id não configurado em config.json")
        sys.exit(1)

    timestamp = _now_str()
    print(f"\n{'='*60}")
    print(f"  BouwObra — Plataforma de Gestão")
    print(f"  Sincronização: {timestamp}")
    print(f"{'='*60}")

    # ── 1. Mapa de custo via NFs ──────────────────────────────────────────────
    cost_map = {}
    if not args.skip_nf:
        print("\n[NF] Construindo mapa de custos...")
        try:
            cost_map = build_sku_cost_map(months_back=12)
        except Exception as e:
            print(f"  Aviso: erro ao buscar NFs — {e}")
            print("  Continuando sem dados de custo (coluna M ficará zerada).")

    # ── 2. Mapa SKU → MLB ────────────────────────────────────────────────────
    print("\n[ML] Mapeando anúncios por SKU...")
    try:
        sku_mlb_map = build_sku_mlb_map()
    except Exception as e:
        print(f"  Aviso: erro ao mapear ML — {e}")
        sku_mlb_map = {}

    # ── 3. Produtos do Tiny ──────────────────────────────────────────────────
    print("\n[Tiny] Carregando produtos...")
    try:
        tiny_products = _get_all_tiny_products()
    except Exception as e:
        print(f"  Erro ao carregar produtos Tiny: {e}")
        sys.exit(1)

    # ── 4. Calcular linhas de precificação ───────────────────────────────────
    print("\n[Precificação] Calculando margens...")
    rows        = []
    uncertain   = []
    sem_custo   = 0
    sem_anuncio = 0
    fees_cache  = {}
    promo_cache = {}
    bonus_cache = {}
    frete_cache = {}

    for produto in tiny_products:
        sku = _extract_sku(produto)
        if not sku:
            continue

        # Dados ML
        ml_entry = sku_mlb_map.get(sku)
        ml_data  = None
        if ml_entry:
            mlb_id          = ml_entry.get("mlb_id", "")
            price           = ml_entry.get("price", 0.0)
            category_id     = ml_entry.get("category_id", "")
            listing_type_id = ml_entry.get("listing_type_id", "")

            # Preço praticado (promoção) — específico do anúncio, sem cache possível
            if mlb_id not in promo_cache:
                promo_cache[mlb_id] = get_current_price(mlb_id, price)
                time.sleep(0.05)
            promo = promo_cache[mlb_id]

            # Taxa ML — a % de comissão é estável por categoria+tipo de anúncio,
            # então cacheia por esse par em vez de por mlb_id (evita reconsultar
            # /sites/MLB/listing_prices para cada SKU da mesma categoria)
            fees_key = (category_id, listing_type_id)
            if fees_key not in fees_cache:
                fees_cache[fees_key] = get_item_fees(promo["preco_praticado"], category_id, listing_type_id)
                time.sleep(0.05)
            fees = fees_cache[fees_key]

            if mlb_id not in bonus_cache:
                bonus_cache[mlb_id] = get_taxa_bonus(mlb_id, price, promo.get("preco_praticado", price))
                time.sleep(0.05)
            bonus = bonus_cache[mlb_id]

            if mlb_id not in frete_cache:
                frete_cache[mlb_id] = get_frete_envio(mlb_id)
                time.sleep(0.05)
            frete = frete_cache[mlb_id]

            ml_data = {
                "mlb_id":     mlb_id,
                "title":      ml_entry.get("title", ""),
                "price":      price,
                "preco_praticado": promo.get("preco_praticado", price),
                "promo_ativa":     promo.get("promo_ativa", False),
                "promo_incerto":   promo.get("incerto", False),
                "status":     ml_entry.get("status", ""),
                "category_id": ml_entry.get("category_id", ""),
                "taxa_pct":   fees.get("taxa_pct", ML_TAXA_DEFAULT),
                "taxa_R$":    fees.get("taxa_R$", 0.0),
                "frete_R$":   frete.get("frete_R$", 0.0),
                "frete_incerto": frete.get("incerto", False),
                "fees_incerto": fees.get("incerto", False),
                "rt_valor":   bonus.get("rt_valor", 0.0),
                "rt_incerto": bonus.get("incerto", False),
            }
        else:
            sem_anuncio += 1

        # Dados de custo (NF)
        custo_data = cost_map.get(sku)
        if custo_data is None:
            sem_custo += 1

        # Calcular linha
        row, uncertain_cols = calcular_linha(
            sku=sku,
            ml_data=ml_data,
            custo_data=custo_data,
            icms_venda_pct=ICMS_VENDA_PCT,
            timestamp=timestamp,
        )
        rows.append(row)
        uncertain.append(uncertain_cols)

    print(f"  Linhas calculadas: {len(rows)}")
    print(f"  Sem anúncio ML:    {sem_anuncio}")
    print(f"  Sem custo NF:      {sem_custo}")

    # ── 5. KPIs Dashboard ───────────────────────────────────────────────────
    dashboard_kpis = []
    if not args.skip_orders:
        print("\n[Dashboard] Buscando KPIs de vendas...")
        try:
            vendas  = get_vendas_mes()
            hoje    = get_pedidos_hoje()
            status  = get_anuncios_status()

            margem_media = 0.0
            if rows:
                margens = [r[MARGEM_PCT_COL_INDEX] for r in rows if isinstance(r[MARGEM_PCT_COL_INDEX], (int, float))]
                margem_media = round(sum(margens) / len(margens), 2) if margens else 0.0

            dashboard_kpis = [
                {"label": "Vendas Brutas do Mês (R$)",    "value": vendas["total_R$"]},
                {"label": "Pedidos Hoje (#)",              "value": hoje["count"]},
                {"label": "Ticket Médio do Mês (R$)",     "value": vendas["ticket_medio"]},
                {"label": "Anúncios Ativos (#)",           "value": status["active"]},
                {"label": "Anúncios Sem Estoque (#)",      "value": status["paused"]},
                {"label": "Margem Média dos Produtos (%)", "value": margem_media},
                {"label": "Produtos sem Custo NF (#)",     "value": sem_custo},
                {"label": "Última Sincronização",          "value": timestamp},
            ]
        except Exception as e:
            print(f"  Aviso: erro ao buscar KPIs — {e}")
            dashboard_kpis = [{"label": "Última Sincronização", "value": timestamp}]
    else:
        dashboard_kpis = [{"label": "Última Sincronização", "value": timestamp}]

    # ── 6. Escrever Google Sheets ────────────────────────────────────────────
    print("\n[Google Sheets] Escrevendo na planilha...")

    # Aba Precificação
    try:
        ws_prec = get_worksheet(SHEET_ID, "Precificação")
        clear_and_write(
            ws_prec,
            headers=HEADERS_PRECIFICACAO,
            rows=rows,
            margin_col_index=MARGEM_PCT_COL_INDEX,
            uncertain_cols_per_row=uncertain,
            credito_cols=CREDITO_COLS,
            debito_cols=DEBITO_COLS,
            margem_cols=MARGEM_COLS,
            status_col_index=STATUS_COL_INDEX,
            status_options=STATUS_OPTIONS,
        )
        print(f"  ✓ Aba Precificação atualizada ({len(rows)} produtos)")
    except Exception as e:
        print(f"  ERRO ao escrever Precificação: {e}")

    # Aba Dashboard
    if dashboard_kpis:
        try:
            ws_dash = get_worksheet(SHEET_ID, "Dashboard")
            write_dashboard(ws_dash, dashboard_kpis)
            print("  ✓ Aba Dashboard atualizada")
        except Exception as e:
            print(f"  ERRO ao escrever Dashboard: {e}")

    print(f"\n{'='*60}")
    print(f"  Sincronização concluída: {_now_str()}")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
