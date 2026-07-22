"""
dashboard_vendas/server.py
---------------------------
Servidor local (só biblioteca padrão, sem dependências novas) para o painel
de análise de vendas por produto/família do Mercado Livre.

Uso:
    python dashboard_vendas/server.py
    (abre automaticamente http://localhost:8765)

Aceita, na busca:
  - um MLB ID (anúncio individual) -> busca vendas só desse item
  - um Family ID / group_id (14+ dígitos) -> resolve todas as variações
    (user_products_ids) e, para cada uma, busca vendas em TODOS os item_ids
    associados (o ativo e qualquer fechado/migrado) -- o histórico de venda
    muitas vezes fica no anúncio antigo, não no atual (confirmado: variação
    MLBU3076710630 tinha 0 vendas no item ativo e 113 no fechado).
"""

import io
import json
import re
import sys
import time
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import openpyxl
from openpyxl.styles import Font, PatternFill

from connectors.mercadolivre.client import ml_get, get_item, extract_seller_sku, ML_USER_ID

_BASE = "https://api.mercadolibre.com"
_PORT = 8765
_HTML_PATH = Path(__file__).parent / "index.html"
_MAX_WORKERS = 8   # concorrência das chamadas ao ML -- uma busca de família (dezenas
                    # de variações x múltiplos item_ids cada) é lenta demais em série
                    # (146s medido pra 64 itens) pro navegador aguentar sem cair a conexão
_MESES_MAX = 3      # limite de meses pra trás permitido no filtro "mês específico"


# ── Filtro de período ──────────────────────────────────────────────────────────
#
# Empurra o filtro pra dentro da própria chamada ML (order.date_created.from/to)
# em vez de buscar tudo e filtrar depois -- pra um item bem vendido isso é a
# diferença entre 1 chamada e várias páginas de pedidos que a gente ia jogar fora.

def _iso_ml(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000-03:00")


def _calcular_intervalo(filtro: str, mes: str = ""):
    """Retorna (date_from_iso, date_to_iso) pro filtro pedido, ou (None, None)
    pra 'todos' (sem filtro). Levanta ValueError se o mês específico estiver
    fora da janela permitida (últimos _MESES_MAX meses, incluindo o atual)."""
    agora = datetime.now()

    if filtro == "dia":
        inicio = agora.replace(hour=0, minute=0, second=0, microsecond=0)
        return _iso_ml(inicio), _iso_ml(agora)

    if filtro == "semana":
        inicio = (agora - timedelta(days=7)).replace(hour=0, minute=0, second=0, microsecond=0)
        return _iso_ml(inicio), _iso_ml(agora)

    if filtro == "mes":
        inicio = agora.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return _iso_ml(inicio), _iso_ml(agora)

    if filtro == "3meses":
        # 3 meses calendário cheios: mês atual + os 2 anteriores, desde o dia 1.
        mes_alvo, ano_alvo = agora.month - 2, agora.year
        while mes_alvo <= 0:
            mes_alvo += 12
            ano_alvo -= 1
        inicio = datetime(ano_alvo, mes_alvo, 1)
        return _iso_ml(inicio), _iso_ml(agora)

    if filtro == "especifico":
        try:
            ano, m = (int(x) for x in mes.split("-"))
            inicio = datetime(ano, m, 1)
        except Exception:
            raise ValueError('Mês inválido -- use o formato "AAAA-MM".')

        meses_atras = (agora.year - ano) * 12 + (agora.month - m)
        if meses_atras < 0 or meses_atras >= _MESES_MAX:
            raise ValueError(f"Escolha um mês dentro dos últimos {_MESES_MAX} meses.")

        fim = datetime(ano + 1, 1, 1) if m == 12 else datetime(ano, m + 1, 1)
        fim -= timedelta(seconds=1)
        return _iso_ml(inicio), _iso_ml(min(fim, agora))

    return None, None  # "todos" (ou valor desconhecido -- sem filtro)


# ── Resolução de entrada (MLB individual x Family ID) ──────────────────────────

def _normalizar_entrada(bruto: str):
    bruto = bruto.strip()
    digitos = re.sub(r"\D", "", bruto)
    if bruto.upper().startswith("MLB"):
        return ("item", bruto.upper())
    if len(digitos) >= 14:
        return ("familia", digitos)
    return ("item", "MLB" + digitos)


def _buscar_itens_do_up(up: str) -> list:
    resp = ml_get(f"{_BASE}/users/{ML_USER_ID}/items/search", {"user_product_id": up})
    return [
        {"item_id": item_id, "user_product_id": up}
        for item_id in (resp.get("results", []) if isinstance(resp, dict) else [])
    ]


def _coletar_itens_da_familia(family_id: str) -> list:
    """Retorna [{item_id, user_product_id}] -- TODOS os item_ids de cada
    user_product_id (ativo + fechados/migrados), pra não perder histórico.
    Resolve os user_products_ids em paralelo (uma família com 30+ variações,
    em série, é o principal motivo da busca demorar minutos)."""
    fam = ml_get(f"{_BASE}/sites/MLB/user-products-families/{family_id}")
    ups = fam.get("user_products_ids", []) if isinstance(fam, dict) else []

    itens = []
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = [pool.submit(_buscar_itens_do_up, up) for up in ups]
        for futuro in as_completed(futuros):
            itens.extend(futuro.result())
    return itens


# ── Pedidos ────────────────────────────────────────────────────────────────────

def _buscar_pedidos_item(item_id: str, date_from: str = None, date_to: str = None,
                          limite_seguranca: int = 5000) -> list:
    pedidos = []
    offset = 0
    while True:
        params = {"seller": ML_USER_ID, "item": item_id, "limit": 51, "offset": offset}
        if date_from:
            params["order.date_created.from"] = date_from
        if date_to:
            params["order.date_created.to"] = date_to
        resp = ml_get(f"{_BASE}/orders/search", params)
        if not isinstance(resp, dict):
            break
        resultados = resp.get("results", [])
        if not resultados:
            break
        pedidos.extend(resultados)
        total = (resp.get("paging") or {}).get("total", 0)
        offset += 51
        if offset >= total or offset >= limite_seguranca:
            break
        time.sleep(0.1)
    return pedidos


# ── Tarifa de envio (Mercado Envios "por sua conta") ───────────────────────────
#
# NÃO vem em /orders/search nem em /orders/{id} -- só a referência shipping.id.
# O valor real cobrado do vendedor está em GET /shipments/{id}/costs, campo
# senders[].cost (confirmado contra a tela de detalhe do pedido do próprio ML:
# "Tarifa do Mercado Envios (por sua conta)"). 1 chamada extra por pedido.

def _buscar_custo_envio(shipping_id) -> float:
    try:
        resp = ml_get(f"{_BASE}/shipments/{shipping_id}/costs")
        senders = resp.get("senders", []) if isinstance(resp, dict) else []
        for s in senders:
            if str(s.get("user_id")) == str(ML_USER_ID):
                return float(s.get("cost", 0) or 0)
        return float(senders[0].get("cost", 0) or 0) if senders else 0.0
    except Exception:
        return 0.0


# "venda total" abaixo desse valor + frete acima desse outro valor = frete
# desproporcional ao tamanho da venda (indício de frete acima do normal pra
# esse produto). Confirmado com um caso real: 3 un. x R$78,99 = R$236,97 de
# venda, R$24,15 de frete -- ok pra esse volume; mas 1 un. sozinha a R$78,99
# com o mesmo frete de R$24,15 já seria desproporcional.
_LIMITE_VENDA_FRETE_ALTO = 78.99
_LIMITE_FRETE_ALTO = 9.0


def _linhas_de_pedido(pedido: dict, item_id_alvo: str, custo_envio_por_shipping: dict) -> list:
    linhas = []
    shipping_id = (pedido.get("shipping") or {}).get("id")
    tarifa_envio = custo_envio_por_shipping.get(shipping_id, 0.0) if shipping_id else 0.0

    for oi in pedido.get("order_items", []) or []:
        item = oi.get("item", {}) or {}
        if item.get("id") != item_id_alvo:
            continue
        var_attrs = item.get("variation_attributes") or []
        variacao = ", ".join(f"{a.get('name')}: {a.get('value_name')}" for a in var_attrs)

        # unit_price/sale_fee são POR UNIDADE (confirmado: 3un. x 78,99 =
        # 236,97 = total_amount do pedido; 9,36 x 3 = 28,08 = tarifa de 12%
        # mostrada no detalhe do pedido no próprio ML) -- multiplica pela
        # quantidade pra refletir o valor real movimentado nessa linha.
        quantidade = oi.get("quantity", 0) or 0
        venda_total = round((oi.get("unit_price", 0) or 0) * quantidade, 2)
        taxa_total = round((oi.get("sale_fee", 0) or 0) * quantidade, 2)

        linhas.append({
            "order_id": pedido.get("id"),
            "pack_id": pedido.get("pack_id"),  # varios pedidos podem compartilhar 1 pacote/envio
            "shipping_id": shipping_id,        # chave real pra deduplicar frete na soma
            "data": pedido.get("date_created"),
            "status": pedido.get("status"),
            "fulfilled": bool(pedido.get("fulfilled")),
            "mlb_id": item_id_alvo,
            "titulo": item.get("title", ""),
            "variacao": variacao,
            "quantidade": quantidade,
            "preco_unitario": oi.get("unit_price", 0),
            "taxa_ml": oi.get("sale_fee", 0),
            "venda_total": venda_total,
            "taxa_total": taxa_total,
            "tarifa_envio": tarifa_envio,
            "frete_alto": venda_total < _LIMITE_VENDA_FRETE_ALTO and tarifa_envio > _LIMITE_FRETE_ALTO,
            "listing_type_id": oi.get("listing_type_id", ""),
            "total_pedido": pedido.get("total_amount", 0),
        })
    return linhas


# ── Handler principal da busca ─────────────────────────────────────────────────

def buscar_vendas_produto(produto_bruto: str, filtro: str = "todos", mes: str = "") -> dict:
    date_from, date_to = _calcular_intervalo(filtro, mes)  # pode levantar ValueError

    tipo, valor = _normalizar_entrada(produto_bruto)

    if tipo == "familia":
        itens_info = _coletar_itens_da_familia(valor)
        if not itens_info:
            return {"ok": False, "erro": f"Nenhuma variação encontrada para o Family ID {valor}."}
    else:
        itens_info = [{"item_id": valor, "user_product_id": None}]

    item_ids = [i["item_id"] for i in itens_info]

    sku_por_item = {}
    titulo_por_item = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = {pool.submit(get_item, item_id): item_id for item_id in item_ids}
        for futuro in as_completed(futuros):
            item_id = futuros[futuro]
            item = futuro.result() or {}
            sku_por_item[item_id] = extract_seller_sku(item)
            titulo_por_item[item_id] = item.get("title", "")

    pedidos_por_item = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = {
            pool.submit(_buscar_pedidos_item, item_id, date_from, date_to): item_id
            for item_id in item_ids
        }
        for futuro in as_completed(futuros):
            item_id = futuros[futuro]
            pedidos_por_item[item_id] = futuro.result()

    # Tarifa de envio ("por sua conta") -- 1 chamada por pedido (via shipping.id),
    # deduplicada por shipping_id e paralelizada (senão vira o novo gargalo).
    shipping_ids = {
        (pedido.get("shipping") or {}).get("id")
        for pedidos in pedidos_por_item.values()
        for pedido in pedidos
        if (pedido.get("shipping") or {}).get("id")
    }
    custo_envio_por_shipping = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = {pool.submit(_buscar_custo_envio, sid): sid for sid in shipping_ids}
        for futuro in as_completed(futuros):
            sid = futuros[futuro]
            custo_envio_por_shipping[sid] = futuro.result()

    vendas = []
    for item_id in item_ids:
        for pedido in pedidos_por_item.get(item_id, []):
            for linha in _linhas_de_pedido(pedido, item_id, custo_envio_por_shipping):
                linha["sku"] = sku_por_item.get(item_id, "")
                if not linha["titulo"]:
                    linha["titulo"] = titulo_por_item.get(item_id, "")
                linha["produto_buscado"] = produto_bruto
                vendas.append(linha)

    return {
        "ok": True,
        "produto_buscado": produto_bruto,
        "tipo": tipo,
        "itens_consultados": [i["item_id"] for i in itens_info],
        "vendas": vendas,
        "filtro_aplicado": {"filtro": filtro, "date_from": date_from, "date_to": date_to},
    }


# ── Exportar Excel ──────────────────────────────────────────────────────────────

_COLUNAS_EXPORT = [
    ("Data",              "data"),
    ("Pedido",            "order_id"),
    ("Pacote",            "pack_id"),
    ("Busca de origem",   "produto_buscado"),
    ("MLB",               "mlb_id"),
    ("SKU",               "sku"),
    ("Variação",          "variacao"),
    ("Título",            "titulo"),
    ("Qtd",               "quantidade"),
    ("Venda Total (R$)",  "venda_total"),
    ("Taxa ML (R$)",      "taxa_total"),
    ("Tarifa Envio (R$)", "tarifa_envio"),
    ("Frete Alto?",       "frete_alto"),
    ("Tipo Anúncio",      "listing_type_id"),
    ("Status",            "status"),
    ("Full",              "fulfilled"),
]
_CHAVES_MOEDA = {"venda_total", "taxa_total", "tarifa_envio"}
_COR_FRETE_ALTO = "FCE4CC"  # laranja claro -- mesma leitura visual da tabela web


def gerar_xlsx(vendas: list) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Vendas"

    ws.append([titulo for titulo, _ in _COLUNAS_EXPORT])
    for cell in ws[1]:
        cell.font = Font(bold=True)

    for v in vendas:
        linha = []
        for _, chave in _COLUNAS_EXPORT:
            valor = v.get(chave, "")
            if chave in ("fulfilled", "frete_alto"):
                valor = "Sim" if valor else "Não"
            linha.append(valor)
        ws.append(linha)

    idx_moeda = [i for i, (_, k) in enumerate(_COLUNAS_EXPORT) if k in _CHAVES_MOEDA]
    preenchimento = PatternFill(start_color=_COR_FRETE_ALTO, end_color=_COR_FRETE_ALTO, fill_type="solid")
    for i, v in enumerate(vendas):
        row = ws[i + 2]
        for idx in idx_moeda:
            row[idx].number_format = '"R$"#,##0.00'
        if v.get("frete_alto"):
            for cell in row:
                cell.fill = preenchimento

    for col_cells in ws.columns:
        largura = max((len(str(c.value)) for c in col_cells if c.value is not None), default=10)
        ws.column_dimensions[col_cells[0].column_letter].width = min(largura + 2, 45)

    ws.freeze_panes = "A2"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ── Servidor HTTP ──────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # silencia o log padrão no console

    def _json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/":
            html = _HTML_PATH.read_text(encoding="utf-8")
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path == "/api/vendas":
            qs = parse_qs(parsed.query)
            produto = (qs.get("produto") or [""])[0].strip()
            filtro = (qs.get("filtro") or ["todos"])[0].strip()
            mes = (qs.get("mes") or [""])[0].strip()
            if not produto:
                self._json({"ok": False, "erro": "Informe um MLB ID ou Family ID."}, 400)
                return
            try:
                resultado = buscar_vendas_produto(produto, filtro, mes)
                self._json(resultado)
            except ValueError as e:
                self._json({"ok": False, "erro": str(e)}, 400)
            except Exception as e:
                self._json({"ok": False, "erro": str(e)}, 500)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path == "/api/exportar":
            length = int(self.headers.get("Content-Length", 0) or 0)
            corpo = self.rfile.read(length) if length else b""
            try:
                vendas = json.loads(corpo.decode("utf-8")) if corpo else []
                if not isinstance(vendas, list):
                    raise ValueError("formato inválido")
                xlsx_bytes = gerar_xlsx(vendas)
            except Exception as e:
                self._json({"ok": False, "erro": f"Erro ao gerar Excel: {e}"}, 400)
                return

            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", 'attachment; filename="vendas_bouwobra.xlsx"')
            self.send_header("Content-Length", str(len(xlsx_bytes)))
            self.end_headers()
            self.wfile.write(xlsx_bytes)
            return

        self.send_response(404)
        self.end_headers()


def main():
    server = ThreadingHTTPServer(("localhost", _PORT), Handler)
    url = f"http://localhost:{_PORT}"
    print(f"Dashboard de Vendas rodando em {url}  (Ctrl+C pra parar)")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrado.")


if __name__ == "__main__":
    main()
