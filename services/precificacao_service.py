"""
services/precificacao_service.py
----------------------------------
Fórmulas de precificação para o regime Lucro Real.

Lógica:
  - IPI é sempre ADICIONADO ao custo (aumenta o custo de compra)
  - ICMS, PIS e COFINS nas compras geram CRÉDITO (reduzem custo líquido)
  - ICMS, PIS e COFINS nas vendas são DÉBITOS sobre a receita
  - Comissão ML + frete de venda também geram CRÉDITO de PIS/COFINS (confirmado
    com a contadora em 12/06/2026 — despesa de venda no Lucro Real)
  - Margem líquida = Receita − Encargos ML − Débitos fiscais venda − Custo
                      + Créditos compra + Créditos PIS/COFINS s/ comissão+frete

Uso:
    from services.precificacao_service import calcular_linha, HEADERS_PRECIFICACAO

    row = calcular_linha(sku, ml_data, custo_data, icms_venda_pct=0.12)
"""

import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent))
from typing import Optional
from connectors.tiny.nf import CustoData

# ── Constantes Lucro Real ──────────────────────────────────────────────────────

PIS_VENDA    = 0.0165   # 1,65% sobre receita (não-cumulativo)
COFINS_VENDA = 0.076    # 7,60% sobre receita (não-cumulativo)

# ── Cabeçalhos da aba Precificação ─────────────────────────────────────────────

HEADERS_PRECIFICACAO = [
    "ID ML",                         # A  0
    "SKU",                           # B  1
    "Nome",                          # C  2
    "Categoria",                     # D  3
    "Preço Base (R$)",               # E  4  — preço "cheio" do anúncio, sem promoção
    "Preço Praticado (R$)",          # F  5  — preço vigente agora (com promoção, se houver); usado no cálculo da margem
    "Taxa ML (%)",                   # G  6
    "RT (R$)",                       # H  7  — Redução de Tarifa: parte da comissão bancada pela Meli em promoções SMART
    "Frete (R$)",                    # I  8
    "ICMS Venda (R$)",               # J  9
    "PIS Venda (R$)",                # K  10
    "COFINS Venda (R$)",             # L  11
    "Comissão + Frete ML (R$)",      # M  12
    "PIS Crédito s/ Comissão+Frete (R$)",    # N  13 — confirmado com a contadora (12/06/2026)
    "COFINS Crédito s/ Comissão+Frete (R$)", # O  14 — idem
    "Custo NF c/ IPI (R$)",          # P  15
    "ICMS Compra — crédito (R$)",    # Q  16
    "PIS Compra — crédito (R$)",     # R  17
    "COFINS Compra — crédito (R$)",  # S  18
    "Imposto Recuperável (R$)",      # T  19
    "Margem Líquida (R$)",           # U  20
    "Margem Líquida (%)",            # V  21  ← usado para coloração
    "Status Anúncio",                # W  22
    "Última Atualização",            # X  23
]

# Índice da coluna Margem Líquida (%) — usado pelo client.py para coloração
MARGEM_PCT_COL_INDEX = 21

# Colunas para coloração fixa (independente da margem), usadas pelo client.py:
#   crédito — valores que BENEFICIAM a margem (créditos fiscais + bônus RT) → verde claro
#   débito  — valores que REDUZEM a margem (encargos de venda e custo)      → vermelho claro
#   margem  — R$ e % da margem líquida, coloridas pelo desempenho          → cor por faixa
CREDITO_COLS = [7, 13, 14, 16, 17, 18, 19]  # RT, PIS/COFINS créd. s/ comissão+frete, ICMS/PIS/COFINS créd. compra, Imposto Recuperável
DEBITO_COLS  = [8, 9, 10, 11, 12, 15]        # Frete, ICMS/PIS/COFINS venda, Comissão+Frete, Custo NF
MARGEM_COLS  = [20, MARGEM_PCT_COL_INDEX]    # Margem Líquida (R$) e (%)

# Status Anúncio (W) — vira dropdown + cor fixa por valor (ver client.py)
STATUS_COL_INDEX = 22
STATUS_OPTIONS    = ["Ativo", "Pausado", "Fechado", "Migrado", "—"]


def _r(v: float, dec: int = 2) -> float:
    return round(v, dec)


def _status_br(status: str) -> str:
    return {
        "active": "Ativo",
        "paused": "Pausado",
        "closed": "Fechado",
        "migrated": "Migrado",
    }.get(str(status).lower(), status or "—")


def calcular_linha(
    sku:           str,
    ml_data:       Optional[dict],
    custo_data:    Optional[CustoData],
    icms_venda_pct: float = 0.12,
    timestamp:      str   = "",
) -> tuple[list, list[int]]:
    """
    Calcula uma linha completa da aba Precificação.

    Parâmetros:
        sku            — código do produto
        ml_data        — dict com mlb_id, title, price (preço base), preco_praticado (preço
                          vigente agora, com promoção se houver), promo_ativa, promo_incerto,
                          status, category_id, taxa_pct, taxa_R$, frete_R$, fees_incerto
                          (True se a taxa ML veio de fallback), rt_valor (bônus RT em R$),
                          rt_incerto (True se rt_valor foi estimado a partir de percentual
                          arredondado pela API)
        custo_data     — CustoData (pode ser None se NF não encontrada)
        icms_venda_pct — alíquota de ICMS sobre vendas (padrão 12%)
        timestamp      — string de data/hora da sincronização

    Retorna (row, uncertain_col_indices):
        row                   — lista de valores nas colunas definidas por HEADERS_PRECIFICACAO
        uncertain_col_indices — índices de colunas com valor estimado/não confirmado (marcar laranja)
    """
    mlb_id       = ml_data.get("mlb_id", "")      if ml_data else ""
    title        = ml_data.get("title", "")        if ml_data else ""
    category     = ml_data.get("category_id", "")  if ml_data else ""
    preco_base   = float(ml_data.get("price", 0) or 0) if ml_data else 0.0
    preco        = float(ml_data.get("preco_praticado", preco_base) or 0) if ml_data else 0.0
    taxa_pct     = float(ml_data.get("taxa_pct", 0) or 0) if ml_data else 0.0
    frete_R      = float(ml_data.get("frete_R$", 0) or 0) if ml_data else 0.0
    rt_valor     = float(ml_data.get("rt_valor", 0) or 0) if ml_data else 0.0
    status       = ml_data.get("status", "")       if ml_data else ""

    # Encargos sobre vendas — calculados sobre o preço praticado (vigente agora)
    # RT é um bônus da Meli que reduz a comissão diretamente em R$ (não é ponto percentual)
    comissao_ml = _r(preco * taxa_pct / 100 - rt_valor)
    comissao_frete = _r(comissao_ml + frete_R)
    icms_venda  = _r(preco * icms_venda_pct)
    # No Lucro Real, PIS/COFINS de venda incidem sobre a receita já líquida de ICMS
    base_pis_cofins = preco - icms_venda
    pis_venda    = _r(base_pis_cofins * PIS_VENDA)
    cofins_venda = _r(base_pis_cofins * COFINS_VENDA)

    # Crédito de PIS/COFINS sobre comissão+frete — confirmado com a contadora
    # (12/06/2026): despesas de venda (comissão de intermediação + frete na
    # operação de venda) geram crédito no Lucro Real, mesma alíquota da venda.
    credito_pis_com_frete    = _r(comissao_frete * PIS_VENDA)
    credito_cofins_com_frete = _r(comissao_frete * COFINS_VENDA)

    # Custo de compra e créditos fiscais
    if custo_data:
        custo_nf        = _r(custo_data.custo_com_ipi)
        icms_credito    = _r(custo_data.icms_credito)
        pis_credito     = _r(custo_data.pis_credito)
        cofins_credito  = _r(custo_data.cofins_credito)
        imp_recuperavel = _r(custo_data.imposto_recuperavel)
    else:
        custo_nf        = 0.0
        icms_credito    = 0.0
        pis_credito     = 0.0
        cofins_credito  = 0.0
        imp_recuperavel = 0.0

    # Margem
    margem_R = _r(
        preco
        - comissao_frete
        - icms_venda
        - pis_venda
        - cofins_venda
        - custo_nf
        + imp_recuperavel
        + credito_pis_com_frete
        + credito_cofins_com_frete
    )
    margem_pct = _r(margem_R / preco * 100, 2) if preco else 0.0

    row = [
        mlb_id or sku,      # A — ID ML (usa SKU se sem MLB)
        sku,                # B
        title or sku,       # C
        category,           # D
        _r(preco_base),     # E — preço cheio, sem promoção
        _r(preco),          # F — preço praticado agora (usado no cálculo abaixo)
        _r(taxa_pct, 2),    # G
        _r(rt_valor),       # H
        _r(frete_R),        # I
        _r(icms_venda),     # J
        _r(pis_venda),      # K
        _r(cofins_venda),   # L
        _r(comissao_frete), # M
        _r(credito_pis_com_frete),    # N
        _r(credito_cofins_com_frete), # O
        _r(custo_nf),       # P
        _r(icms_credito),   # Q
        _r(pis_credito),    # R
        _r(cofins_credito), # S
        _r(imp_recuperavel),# T
        _r(margem_R),       # U
        _r(margem_pct, 2),  # V — usado para coloração de linha
        _status_br(status), # W
        timestamp,          # X
    ]

    uncertain_cols = []
    if ml_data and ml_data.get("promo_incerto"):
        uncertain_cols.append(5)   # F — Preço Praticado (R$): falha ao consultar promoções, usou preço base
    if ml_data and ml_data.get("fees_incerto"):
        uncertain_cols.append(6)   # G — Taxa ML (%): fallback, não confirmada pela API
        uncertain_cols.append(12)  # M — Comissão + Frete ML (R$): depende da taxa acima
        uncertain_cols.append(13)  # N — PIS crédito s/ comissão+frete: depende da taxa acima
        uncertain_cols.append(14)  # O — COFINS crédito s/ comissão+frete: depende da taxa acima
    if ml_data and ml_data.get("rt_incerto"):
        uncertain_cols.append(7)   # H — RT (R$): estimado a partir de percentual arredondado pela API
    if ml_data and ml_data.get("frete_incerto"):
        uncertain_cols.append(8)   # I — Frete (R$): falha ao consultar shipping_options/free
        uncertain_cols.append(12)  # M — Comissão + Frete ML (R$): depende do frete acima
        uncertain_cols.append(13)  # N — PIS crédito s/ comissão+frete: depende do frete acima
        uncertain_cols.append(14)  # O — COFINS crédito s/ comissão+frete: depende do frete acima
    if custo_data is None:
        uncertain_cols.append(15)  # P — Custo NF c/ IPI (R$): sem NF encontrada, custo = 0

    return row, uncertain_cols
