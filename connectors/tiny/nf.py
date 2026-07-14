"""
connectors/tiny/nf.py
----------------------
Acesso às Notas Fiscais de entrada do Tiny ERP v3.
Mapeia SKU → custo real de compra (com IPI, ICMS, PIS, COFINS).

Uso:
    from connectors.tiny.nf import build_sku_cost_map, CustoData

    cost_map = build_sku_cost_map(months_back=12)
    custo = cost_map.get("800202C")
    if custo:
        print(custo.custo_base, custo.ipi_pct, custo.nf_numero)
"""

import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent.parent))
from connectors.tiny.client import get as tiny_get


# ── Estrutura de custo por SKU ─────────────────────────────────────────────────

@dataclass
class CustoData:
    custo_base:      float   # valor unitário (sem IPI)
    ipi_pct:         float   # % IPI da nota (ex: 9.75)
    icms_compra_pct: float   # % ICMS da nota (ex: 12.0) — 0 se ST
    nf_numero:       str
    nf_data:         str
    sku:             str     = ""
    descricao:       str     = ""

    @property
    def ipi_valor(self) -> float:
        return round(self.custo_base * self.ipi_pct / 100, 4)

    @property
    def custo_com_ipi(self) -> float:
        return round(self.custo_base + self.ipi_valor, 4)

    @property
    def icms_credito(self) -> float:
        return round(self.custo_base * self.icms_compra_pct / 100, 4)

    @property
    def pis_credito(self) -> float:
        return round(self.custo_base * 0.0165, 4)

    @property
    def cofins_credito(self) -> float:
        return round(self.custo_base * 0.076, 4)

    @property
    def imposto_recuperavel(self) -> float:
        return round(self.icms_credito + self.pis_credito + self.cofins_credito, 4)


# ── Helpers de extração de campos ─────────────────────────────────────────────

def _float(val, default=0.0) -> float:
    try:
        return float(str(val).replace(",", ".").strip())
    except (TypeError, ValueError):
        return default


def _pick(d: dict, *keys, default=None):
    """Tenta múltiplas chaves em um dict, retorna o primeiro não-None encontrado."""
    for k in keys:
        v = d.get(k)
        if v is not None:
            return v
    return default


def _extract_item_sku(item: dict) -> str:
    """Extrai o SKU/código do produto no item da NF."""
    # Tiny v3 pode retornar o produto como sub-objeto ou campos diretos
    produto = item.get("produto") or {}
    sku = (
        _pick(produto, "codigo", "sku", "code")
        or _pick(item, "codigo", "codigoProduto", "sku", "code")
        or ""
    )
    return str(sku).strip()


def _extract_item_descricao(item: dict) -> str:
    produto = item.get("produto") or {}
    return (
        _pick(produto, "nome", "descricao", "name")
        or _pick(item, "descricao", "nome", "description")
        or ""
    )


def _extract_item_quantidade(item: dict) -> float:
    return _float(_pick(item, "quantidade", "qty", "qtd", default=1))


def _extract_item_valor_unitario(item: dict) -> float:
    # Tenta valorUnitario primeiro, depois calcula de valorTotal/quantidade
    unit = _pick(item, "valorUnitario", "valor_unitario", "unitValue", "preco", "valor")
    if unit is not None:
        return _float(unit)
    total = _float(_pick(item, "valorTotal", "valor_total", "totalValue", default=0))
    qty   = _extract_item_quantidade(item)
    return round(total / qty, 4) if qty else 0.0


def _extract_ipi_pct(item: dict) -> float:
    # IPI pode vir como sub-objeto {percentual: x} ou campo direto
    ipi_obj = item.get("ipi") or item.get("impostoIpi") or {}
    if isinstance(ipi_obj, dict):
        v = _pick(ipi_obj, "percentual", "aliquota", "pct")
        if v is not None:
            return _float(v)
    return _float(_pick(item, "percentualIpi", "ipi_pct", "aliquotaIpi", default=0))


def _extract_icms_pct(item: dict) -> float:
    icms_obj = item.get("icms") or item.get("impostoIcms") or {}
    if isinstance(icms_obj, dict):
        v = _pick(icms_obj, "percentual", "aliquota", "pct")
        if v is not None:
            return _float(v)
    return _float(_pick(item, "percentualIcms", "icms_pct", "aliquotaIcms", default=0))


# ── Listagem de NFs ────────────────────────────────────────────────────────────

def _list_nf_page(pagina: int, data_inicio: str, data_fim: str) -> dict:
    """
    GET /notas-fiscais
    Retorna a resposta bruta da página.
    Parâmetros testados: tipo=E (entrada), situacao=A (autorizada).
    """
    return tiny_get("/notas-fiscais", {
        "tipo":        "E",
        "situacao":    "A",
        "dataInicio":  data_inicio,
        "dataFim":     data_fim,
        "pagina":      pagina,
        "limite":      100,
    })


def _extract_nf_list(data: dict) -> list:
    """
    Tiny v3 pode encapsular a lista em diferentes chaves.
    Tenta: data.itens, data.notas, data.data.itens, etc.
    """
    if not isinstance(data, dict):
        return []
    inner = data.get("data") or data
    if isinstance(inner, list):
        return inner
    for key in ("itens", "notas", "items", "results"):
        v = inner.get(key)
        if isinstance(v, list):
            return v
    return []


def _extract_pagination(data: dict) -> dict:
    inner = data.get("data") or data
    for key in ("paginacao", "pagination", "paginator"):
        v = inner.get(key)
        if isinstance(v, dict):
            return v
    return {}


def _get_nf_detail(nf_id) -> dict:
    """GET /notas-fiscais/{id}"""
    data = tiny_get(f"/notas-fiscais/{nf_id}")
    inner = data.get("data") or data
    # pode ser nota diretamente ou dentro de 'nota'
    if "nota" in inner:
        return inner["nota"]
    if "id" in inner:
        return inner
    return {}


def _extract_nf_items(nf_detail: dict) -> list:
    for key in ("itens", "items", "produtos", "products"):
        v = nf_detail.get(key)
        if isinstance(v, list):
            return v
    return []


# ── Mapa SKU → custo ──────────────────────────────────────────────────────────

def build_sku_cost_map(months_back: int = 12) -> dict:
    """
    Varre todas as NFs de entrada dos últimos `months_back` meses,
    constrói e retorna dict[sku_str → CustoData] com a nota mais recente.

    Notas com ST (ICMS zerado na NF) são tratadas corretamente:
    icms_credito = 0 automaticamente.
    """
    hoje = datetime.today()
    data_inicio = (hoje - timedelta(days=30 * months_back)).strftime("%d/%m/%Y")
    data_fim    = hoje.strftime("%d/%m/%Y")

    print(f"  Buscando NFs de entrada de {data_inicio} a {data_fim}...")

    # Fase 1: listar todas as NFs de entrada
    nf_headers = []  # lista de {id, numero, data}
    pagina = 1
    while True:
        resp = _list_nf_page(pagina, data_inicio, data_fim)
        nf_list = _extract_nf_list(resp)
        if not nf_list:
            break
        nf_headers.extend(nf_list)
        pag = _extract_pagination(resp)
        total_pag = int(_pick(pag, "totalPaginas", "totalPages", "total_paginas", default=1) or 1)
        print(f"  Página {pagina}/{total_pag} — {len(nf_headers)} NFs carregadas")
        if pagina >= total_pag or len(nf_list) < 100:
            break
        pagina += 1
        time.sleep(0.15)

    print(f"  Total de NFs encontradas: {len(nf_headers)}")

    # Fase 2: para cada NF, buscar detalhes e mapear SKU → custo mais recente
    sku_map: dict[str, CustoData] = {}

    for idx, nf_hdr in enumerate(nf_headers, 1):
        nf_id     = _pick(nf_hdr, "id")
        nf_numero = str(_pick(nf_hdr, "numero", "number", default="") or "").strip()
        nf_data   = str(_pick(nf_hdr, "dataEmissao", "data", "date", default="") or "").strip()

        if not nf_id:
            continue

        if idx % 10 == 0:
            print(f"  Processando NF {idx}/{len(nf_headers)}...")

        try:
            detail = _get_nf_detail(nf_id)
            items  = _extract_nf_items(detail)
        except Exception as e:
            print(f"  Aviso: erro ao buscar NF {nf_id}: {e}")
            time.sleep(0.2)
            continue

        for item in items:
            sku = _extract_item_sku(item)
            if not sku:
                continue

            qty   = _extract_item_quantidade(item)
            unit  = _extract_item_valor_unitario(item)
            ipi   = _extract_ipi_pct(item)
            icms  = _extract_icms_pct(item)
            desc  = _extract_item_descricao(item)

            if unit <= 0 or qty <= 0:
                continue

            # Mantém apenas a NF mais recente por SKU
            # Como NFs vêm em ordem decrescente de data, a primeira encontrada é a mais recente
            if sku not in sku_map:
                sku_map[sku] = CustoData(
                    sku=sku,
                    descricao=desc,
                    custo_base=round(unit, 4),
                    ipi_pct=round(ipi, 4),
                    icms_compra_pct=round(icms, 4),
                    nf_numero=nf_numero,
                    nf_data=nf_data,
                )

        time.sleep(0.1)

    print(f"  SKUs com custo mapeado: {len(sku_map)}")
    return sku_map
