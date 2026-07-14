"""
services/precificacao_service.py
----------------------------------
Fórmulas de precificação para o regime Lucro Real.

Lógica:
  - IPI é sempre ADICIONADO ao custo (aumenta o custo de compra)
  - ICMS, PIS e COFINS nas compras geram CRÉDITO (reduzem custo líquido)
  - ICMS, PIS e COFINS nas vendas são DÉBITOS sobre a receita
  - Margem líquida = Receita − Encargos ML − Débitos fiscais venda − Custo + Créditos compra

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
    "ID ML",                    # A  0
    "SKU",                      # B  1
    "Nome",                     # C  2
    "Categoria",                # D  3
    "Preço de Venda (R$)",      # E  4
    "Taxa ML (%)",              # F  5
    "RT (%)",                   # G  6
    "Frete (R$)",               # H  7
    "ICMS Venda (R$)",          # I  8
    "PIS Venda (R$)",           # J  9
    "COFINS Venda (R$)",        # K  10
    "Comissão + Frete ML (R$)", # L  11
    "Custo NF c/ IPI (R$)",     # M  12
    "ICMS Compra — crédito (R$)",   # N  13
    "PIS Compra — crédito (R$)",    # O  14
    "COFINS Compra — crédito (R$)", # P  15
    "Imposto Recuperável (R$)", # Q  16
    "Margem Líquida (R$)",      # R  17
    "Margem Líquida (%)",       # S  18  ← usado para coloração
    "Status Anúncio",           # T  19
    "Última Atualização",       # U  20
]

# Índice da coluna Margem Líquida (%) — usado pelo client.py para coloração
MARGEM_PCT_COL_INDEX = 18


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
    rt_pct:         float = 0.0,
    timestamp:      str   = "",
) -> list:
    """
    Calcula uma linha completa da aba Precificação.

    Parâmetros:
        sku            — código do produto
        ml_data        — dict com mlb_id, title, price, status, category_id, taxa_pct, taxa_R$, frete_R$
        custo_data     — CustoData (pode ser None se NF não encontrada)
        icms_venda_pct — alíquota de ICMS sobre vendas (padrão 12%)
        rt_pct         — redução de tarifa ML (padrão 0%)
        timestamp      — string de data/hora da sincronização

    Retorna lista com os valores nas colunas definidas por HEADERS_PRECIFICACAO.
    """
    mlb_id      = ml_data.get("mlb_id", "")      if ml_data else ""
    title       = ml_data.get("title", "")        if ml_data else ""
    category    = ml_data.get("category_id", "")  if ml_data else ""
    preco       = float(ml_data.get("price", 0) or 0) if ml_data else 0.0
    taxa_pct    = float(ml_data.get("taxa_pct", 0) or 0) if ml_data else 0.0
    taxa_R      = float(ml_data.get("taxa_R$", 0) or 0)  if ml_data else 0.0
    frete_R     = float(ml_data.get("frete_R$", 0) or 0) if ml_data else 0.0
    status      = ml_data.get("status", "")       if ml_data else ""

    # Encargos sobre vendas
    comissao_ml = _r(preco * (taxa_pct / 100 - rt_pct / 100))
    comissao_frete = _r(comissao_ml + frete_R)
    icms_venda  = _r(preco * icms_venda_pct)
    pis_venda   = _r(preco * PIS_VENDA)
    cofins_venda = _r(preco * COFINS_VENDA)

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
    )
    margem_pct = _r(margem_R / preco * 100, 2) if preco else 0.0

    return [
        mlb_id or sku,      # A — ID ML (usa SKU se sem MLB)
        sku,                # B
        title or sku,       # C
        category,           # D
        _r(preco),          # E
        _r(taxa_pct, 2),    # F
        _r(rt_pct, 2),      # G
        _r(frete_R),        # H
        _r(icms_venda),     # I
        _r(pis_venda),      # J
        _r(cofins_venda),   # K
        _r(comissao_frete), # L
        _r(custo_nf),       # M
        _r(icms_credito),   # N
        _r(pis_credito),    # O
        _r(cofins_credito), # P
        _r(imp_recuperavel),# Q
        _r(margem_R),       # R
        _r(margem_pct, 2),  # S — usado para coloração de linha
        _status_br(status), # T
        timestamp,          # U
    ]
