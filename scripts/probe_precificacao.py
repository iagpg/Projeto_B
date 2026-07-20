"""
scripts/probe_precificacao.py
------------------------------
Testa e calcula a precificacao completa de um produto.

Passos verificados:
  1. NF cost cache (cache/nf_custo.json) tem o SKU
  2. Anuncio ML existe e tem seller_sku correto
  3. Preco praticado agora (menor promocao ativa, ou preco base se nenhuma)
  4. Taxa de comissao ML via API, sobre o preco praticado
  5. Frete (Mercado Envios / Full) pago pelo vendedor
  6. RT (reducao de tarifa) — bonus Meli em promocoes SMART
  7. Calculo Lucro Real completo (mesma formula do Apps Script)

Uso:
    python scripts/probe_precificacao.py MLB3633227036 AM27
    python scripts/probe_precificacao.py MLB3633227036        (so inspeciona anuncio)
    python scripts/probe_precificacao.py --sku AM27           (busca por SKU)
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from connectors.mercadolivre.client import ml_get, ML_USER_ID, _BASE, _ATTRS, extract_seller_sku, get_current_price
from connectors.mercadolivre.orders import get_item_fees, get_taxa_bonus, get_frete_envio
from services.custo_service import load_cache

# ── Constantes Lucro Real (espelham 01_Config.gs) ─────────────────────────────
ICMS_VENDA   = 0.18
PIS_VENDA    = 0.0165
COFINS_VENDA = 0.076

SEP = "-" * 60


def _r2(v: float) -> float:
    return round(v * 100) / 100


def _brl(v) -> str:
    return f"R$ {float(v or 0):>10.2f}"


def _pct(v) -> str:
    return f"{float(v or 0):>7.2f}%"


# ── 1. Cache NF ───────────────────────────────────────────────────────────────

def checar_cache_nf(sku: str):
    print(f"\n[1] Cache NF - SKU: {sku}")
    cache = load_cache()
    if not cache:
        print("    AVISO: cache/nf_custo.json vazio ou inexistente.")
        print("    Execute: python scripts/sincronizar_custo.py --full")
        return None
    custo = cache.get(sku)
    if not custo:
        print(f"    SKU '{sku}' NAO encontrado no cache.")
        print(f"    Cache tem {len(cache)} SKUs: {', '.join(list(cache.keys())[:10])}...")
        print("    Execute: python scripts/sincronizar_custo.py --full")
        return None
    print(f"    Descricao   : {custo.descricao}")
    print(f"    Custo base  : {_brl(custo.custo_base)}")
    print(f"    IPI (R$)    : {_brl(custo.ipi_valor)}")
    print(f"    Custo c/IPI : {_brl(custo.custo_com_ipi)}")
    print(f"    ICMS cred.  : {_brl(custo.icms_credito)}")
    print(f"    PIS cred.   : {_brl(custo.pis_credito)}")
    print(f"    COFINS cred.: {_brl(custo.cofins_credito)}")
    print(f"    Imp.recup.  : {_brl(custo.imposto_recuperavel)}")
    print(f"    NF numero   : {custo.nf_numero}  |  NF data: {custo.nf_data}")
    return custo


# ── 2. Anuncio ML ─────────────────────────────────────────────────────────────

def checar_anuncio_ml(mlb_id: str, sku_esperado: str | None = None):
    print(f"\n[2] Anuncio ML - {mlb_id}")
    data = ml_get(
        f"{_BASE}/items/{mlb_id}",
        {"attributes": _ATTRS + ",price,category_id,shipping"},
    )
    if not data or not data.get("id"):
        print(f"    ERRO: Anuncio {mlb_id} nao encontrado (HTTP 404 ou sem id).")
        return None

    seller_sku = extract_seller_sku(data)
    price      = float(data.get("price") or 0)
    status     = data.get("status", "")
    title      = data.get("title", "")
    category   = data.get("category_id", "")

    print(f"    Titulo      : {title}")
    print(f"    Status      : {status}")
    print(f"    Preco       : {_brl(price)}")
    print(f"    Categoria   : {category}")
    print(f"    seller_sku  : {seller_sku or '(vazio)'}")

    if not seller_sku:
        print("    AVISO: seller_sku vazio no ML.")
        print("    O Apps Script nao vai mapear este anuncio automaticamente.")
        print("    Acesse o anuncio no ML e preencha o campo 'Codigo' (SKU).")
        if sku_esperado:
            print(f"    SKU esperado: {sku_esperado}")
    elif sku_esperado and seller_sku != sku_esperado:
        print(f"    AVISO: SKU no ML e '{seller_sku}', esperado '{sku_esperado}'.")
    else:
        print(f"    SKU OK: '{seller_sku}'")

    return {"mlbId": mlb_id, "price": price, "status": status,
            "categoryId": category, "title": title, "seller_sku": seller_sku}


# ── 3. Preco praticado (promocao) + Taxas ML ──────────────────────────────────

def checar_preco_praticado(mlb_id: str, preco_base: float):
    print(f"\n[3] Preco praticado (promocoes) - {mlb_id}")
    promo = get_current_price(mlb_id, preco_base)
    if promo["incerto"]:
        print("    AVISO: falha ao consultar /items/{id}/prices, usando preco base.")
    elif promo["promo_ativa"]:
        print(f"    Promocao ATIVA agora: {_brl(promo['preco_praticado'])} "
              f"(base {_brl(preco_base).strip()})")
    else:
        print(f"    Sem promocao ativa. Preco praticado = preco base ({_brl(preco_base).strip()}).")
    return promo


def checar_taxas_ml(mlb_id: str, price: float):
    print(f"\n[4] Taxas ML - {mlb_id}  (preco praticado={_brl(price).strip()})")
    fees = get_item_fees(mlb_id, price)
    if fees["incerto"]:
        print("    AVISO: API de taxas indisponivel, usando fallback de config.json.")
    print(f"    Comissao    : {_brl(fees['taxa_R$'])}  ({_pct(fees['taxa_pct']).strip()})")
    return {"taxaRs": fees["taxa_R$"], "taxaPct": fees["taxa_pct"]}


def checar_frete(mlb_id: str):
    print(f"\n[5] Frete (Mercado Envios / Full) - {mlb_id}")
    frete = get_frete_envio(mlb_id)
    if frete["incerto"]:
        print("    AVISO: nao foi possivel consultar shipping_options/free, frete = 0.")
    else:
        print(f"    Custo de frete pago pelo vendedor: {_brl(frete['frete_R$'])}")
    return frete


def checar_rt(mlb_id: str, preco_base: float, preco_praticado: float):
    print(f"\n[6] RT (reducao de tarifa) - {mlb_id}")
    bonus = get_taxa_bonus(mlb_id, preco_base, preco_praticado)
    if bonus["rt_valor"]:
        print(f"    Bonus Meli encontrado: {_brl(bonus['rt_valor'])} "
              "(estimado a partir do % arredondado da promocao, pode variar centavos)")
    else:
        print("    Sem bonus RT (promocao atual nao e do tipo SMART, ou nenhuma promocao ativa).")
    return bonus


# ── 5. Calculo Lucro Real ─────────────────────────────────────────────────────

def calcular_margem(ml_data: dict, fees: dict, custo, preco_praticado: float,
                     rt_valor: float = 0.0, frete_rs: float = 0.0):
    preco_base = ml_data["price"]
    preco      = preco_praticado
    taxa_rs    = fees["taxaRs"]
    taxa_pct   = fees["taxaPct"]

    comissao_frete = _r2(taxa_rs - rt_valor + frete_rs)

    icms_venda   = _r2(preco * ICMS_VENDA)
    # No Lucro Real, PIS/COFINS de venda incidem sobre a receita já líquida de ICMS
    base_pis_cofins = preco - icms_venda
    pis_venda    = _r2(base_pis_cofins * PIS_VENDA)
    cofins_venda = _r2(base_pis_cofins * COFINS_VENDA)

    if custo:
        custo_nf    = _r2(custo.custo_base + custo.ipi_valor)
        icms_cred   = _r2(custo.icms_credito)
        pis_cred    = _r2(custo.pis_credito)
        cofins_cred = _r2(custo.cofins_credito)
        imp_recup   = _r2(icms_cred + pis_cred + cofins_cred)
    else:
        custo_nf = icms_cred = pis_cred = cofins_cred = imp_recup = 0.0

    margem_rs  = _r2(preco - comissao_frete - icms_venda - pis_venda - cofins_venda - custo_nf + imp_recup)
    margem_pct = _r2(margem_rs / preco * 100) if preco else 0.0

    print(f"\n[7] Calculo Lucro Real (sobre o preco praticado)")
    print(SEP)
    print(f"  Preco base              : {_brl(preco_base)}")
    print(f"  Preco praticado (venda) : {_brl(preco)}")
    print(f"  (-) Comissao ML         : {_brl(taxa_rs)}  ({_pct(taxa_pct).strip()})")
    print(f"  (+) RT (bonus Meli)     : {_brl(rt_valor)}")
    print(f"  (-) Frete ML            : {_brl(frete_rs)}")
    print(f"  (-) ICMS venda          : {_brl(icms_venda)}  (18%)")
    print(f"  (-) PIS venda           : {_brl(pis_venda)}  (1,65%)")
    print(f"  (-) COFINS venda        : {_brl(cofins_venda)}  (7,6%)")
    print(f"  (-) Custo NF c/ IPI     : {_brl(custo_nf)}")
    print(f"  (+) ICMS credito compra : {_brl(icms_cred)}")
    print(f"  (+) PIS credito compra  : {_brl(pis_cred)}")
    print(f"  (+) COFINS cred. compra : {_brl(cofins_cred)}")
    print(f"  (+) Imp. recuperavel    : {_brl(imp_recup)}")
    print(SEP)
    print(f"  MARGEM LIQUIDA          : {_brl(margem_rs)}  ({_pct(margem_pct).strip()})")
    print(SEP)

    if not custo:
        print("  AVISO: custo NF ausente, margem calculada sem custo.")

    return margem_pct


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    mlb_id = None
    sku    = None

    # Parse args
    i = 0
    while i < len(args):
        if args[i] == "--sku" and i + 1 < len(args):
            sku = args[i + 1]; i += 2
        elif args[i].upper().startswith("MLB"):
            mlb_id = args[i].upper(); i += 1
        else:
            sku = args[i]; i += 1

    # Defaults para o exemplo pedido
    if not mlb_id and not sku:
        mlb_id = "MLB3633227036"
        sku    = "AM27"

    print("\n" + "=" * 60)
    print("  BouwObra - Probe Precificacao")
    print("=" * 60)
    if mlb_id:
        print(f"  MLB ID : {mlb_id}")
    if sku:
        print(f"  SKU    : {sku}")

    # Se so tem SKU, tenta descobrir MLB ID
    if sku and not mlb_id:
        from connectors.mercadolivre.client import search_by_sku
        ids = search_by_sku(sku)
        if ids:
            mlb_id = ids[0]
            print(f"  MLB ID encontrado via SKU: {mlb_id}")
        else:
            print(f"  SKU '{sku}' nao encontrado no ML. Verifique o campo Codigo no anuncio.")

    custo   = checar_cache_nf(sku) if sku else None
    ml_data = checar_anuncio_ml(mlb_id, sku) if mlb_id else None

    if ml_data and ml_data["price"] > 0:
        promo = checar_preco_praticado(mlb_id, ml_data["price"])
        fees  = checar_taxas_ml(mlb_id, promo["preco_praticado"])
        frete = checar_frete(mlb_id)
        bonus = checar_rt(mlb_id, ml_data["price"], promo["preco_praticado"])
        margem = calcular_margem(ml_data, fees, custo, promo["preco_praticado"],
                                  bonus["rt_valor"], frete["frete_R$"])

        print()
        if custo and ml_data:
            status = "PRONTO para precificacao"
        elif ml_data and not custo:
            status = "FALTA: executar sincronizar_custo.py --full para obter custo NF"
        elif custo and not ml_data:
            status = "FALTA: verificar anuncio ML"
        else:
            status = "INCOMPLETO"
        print(f"  Status: {status}")
    else:
        print("\n  Nao foi possivel calcular margem (preco ou anuncio ausente).")

    print()


if __name__ == "__main__":
    main()
