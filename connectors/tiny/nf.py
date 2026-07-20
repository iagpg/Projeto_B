"""
connectors/tiny/nf.py
----------------------
Notas Fiscais de entrada do Tiny ERP v3.
Mapeia SKU → custo real de compra com valores absolutos de impostos por unidade.

Fluxo de API:
  GET /notas?tipo=E&limit=100&offset=0       → lista NFs de entrada
  GET /notas/{id}                             → detalhe com itens[] (idItem, codigo, qty, valor)
  GET /notas/{id}/itens/{idItem}              → impostos por item (valorImposto de IPI/ICMS/PIS/COFINS)

Uso:
    from connectors.tiny.nf import build_sku_cost_map, CustoData
    cost_map = build_sku_cost_map()
    custo = cost_map.get("42")
"""

import time
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent.parent))
from connectors.tiny.client import get as tiny_get


# ── Estrutura de custo por SKU ─────────────────────────────────────────────────

@dataclass
class CustoData:
    sku:            str
    descricao:      str
    custo_base:     float   # valorUnitario da NF (sem IPI), por unidade
    ipi_valor:      float   # ipi.valorImposto / quantidade, por unidade
    icms_credito:   float   # icms.valorImposto / quantidade, por unidade (0 se ST)
    pis_credito:    float   # pis.valorImposto / quantidade, por unidade
    cofins_credito: float   # cofins.valorImposto / quantidade, por unidade
    nf_numero:      str
    nf_data:        str     # YYYY-MM-DD
    nf_id:          int     # ID interno Tiny (usado para sync incremental)

    @property
    def custo_com_ipi(self) -> float:
        return round(self.custo_base + self.ipi_valor, 4)

    @property
    def imposto_recuperavel(self) -> float:
        return round(self.icms_credito + self.pis_credito + self.cofins_credito, 4)

    def to_dict(self) -> dict:
        return {
            "sku":            self.sku,
            "descricao":      self.descricao,
            "custo_base":     self.custo_base,
            "ipi_valor":      self.ipi_valor,
            "icms_credito":   self.icms_credito,
            "pis_credito":    self.pis_credito,
            "cofins_credito": self.cofins_credito,
            "custo_com_ipi":  self.custo_com_ipi,
            "imposto_recuperavel": self.imposto_recuperavel,
            "nf_numero":      self.nf_numero,
            "nf_data":        self.nf_data,
            "nf_id":          self.nf_id,
        }

    @staticmethod
    def from_dict(d: dict) -> "CustoData":
        return CustoData(
            sku=d.get("sku", ""),
            descricao=d.get("descricao", ""),
            custo_base=d.get("custo_base", 0.0),
            ipi_valor=d.get("ipi_valor", 0.0),
            icms_credito=d.get("icms_credito", 0.0),
            pis_credito=d.get("pis_credito", 0.0),
            cofins_credito=d.get("cofins_credito", 0.0),
            nf_numero=d.get("nf_numero", ""),
            nf_data=d.get("nf_data", ""),
            nf_id=int(d.get("nf_id", 0)),
        )


# ── Helpers ────────────────────────────────────────────────────────────────────

def _float(val, default=0.0) -> float:
    try:
        return float(str(val).replace(",", ".").strip())
    except (TypeError, ValueError):
        return default


def _int(val, default=0) -> int:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


# ── Listagem de NFs ────────────────────────────────────────────────────────────

def _list_nf_page(offset: int, data_inicio: str, data_fim: str) -> dict:
    """
    GET /notas?tipo=E&limit=100&offset=N
    Parâmetros corretos da API v3: limit/offset, datas YYYY-MM-DD, situacao como int.
    situacao=4 = Autorizada. Omitida para capturar todas (incluindo em processamento).
    """
    params = {
        "tipo":        "E",
        "dataInicial": data_inicio,
        "dataFinal":   data_fim,
        "limit":       100,
        "offset":      offset,
    }
    return tiny_get("/notas", params)


def _extract_nf_list(resp: dict) -> list:
    """Extrai a lista de NFs da resposta paginada."""
    itens = resp.get("itens")
    if isinstance(itens, list):
        return itens
    inner = resp.get("data") or {}
    if isinstance(inner, list):
        return inner
    for key in ("itens", "notas", "items", "results"):
        v = inner.get(key) if isinstance(inner, dict) else None
        if isinstance(v, list):
            return v
    return []


def _extract_pagination(resp: dict) -> dict:
    pag = resp.get("paginacao") or resp.get("pagination") or {}
    if not pag:
        inner = resp.get("data") or {}
        pag = inner.get("paginacao") or inner.get("pagination") or {}
    return pag if isinstance(pag, dict) else {}


# ── Detalhe da NF ──────────────────────────────────────────────────────────────

def _get_nf_detail(nf_id: int) -> dict:
    """GET /notas/{id} → retorna a NF com itens[] contendo idItem."""
    resp = tiny_get(f"/notas/{nf_id}")
    # Resposta pode ser direta ou encapsulada em data/nota
    if "id" in resp:
        return resp
    inner = resp.get("data") or resp
    if "nota" in inner:
        return inner["nota"]
    return inner if isinstance(inner, dict) else {}


def _get_nf_item_detail(nf_id: int, id_item: int) -> dict:
    """GET /notas/{idNota}/itens/{idItem} → retorna impostos detalhados do item."""
    try:
        resp = tiny_get(f"/notas/{nf_id}/itens/{id_item}")
        if "id" in resp or "idItem" in resp or "codigo" in resp:
            return resp
        inner = resp.get("data") or resp
        return inner if isinstance(inner, dict) else {}
    except Exception:
        return {}


# ── Extração de valores de imposto ─────────────────────────────────────────────

def _extract_imposto_valor(obj) -> float:
    """Extrai valorImposto de um sub-objeto de imposto {valorImposto: x}."""
    if isinstance(obj, dict):
        for key in ("valorImposto", "valor", "value"):
            v = obj.get(key)
            if v is not None:
                return _float(v)
    return 0.0


# ── Mapa SKU → custo ──────────────────────────────────────────────────────────

def build_sku_cost_map(months_back: int = 12,
                       since_nf_id: Optional[int] = None,
                       verbose: bool = True) -> dict:
    """
    Varre NFs de entrada e retorna dict[sku → CustoData].

    Se since_nf_id for passado, busca apenas NFs com id > since_nf_id (incremental).
    Mantém apenas a NF mais recente por SKU.

    Retorna:
        dict[str, CustoData]  — somente SKUs com custo encontrado
        O chamador pode verificar o maior nf_id processado via max(v.nf_id for v in result.values())
    """
    hoje        = datetime.today()
    data_inicio = (hoje - timedelta(days=30 * months_back)).strftime("%Y-%m-%d")
    data_fim    = hoje.strftime("%Y-%m-%d")

    if verbose:
        modo = f"incremental (since_nf_id={since_nf_id})" if since_nf_id else "completo"
        print(f"  Buscando NFs de entrada [{modo}]: {data_inicio} -> {data_fim}")

    # ── Fase 1: listar todas as NFs de entrada ──────────────────
    nf_headers = []
    offset = 0
    while True:
        resp = _list_nf_page(offset, data_inicio, data_fim)
        page = _extract_nf_list(resp)
        if not page:
            break

        # Filtragem incremental: ignora NFs com id <= since_nf_id
        if since_nf_id:
            page = [nf for nf in page if _int(nf.get("id", 0)) > since_nf_id]
            if not page:
                break  # NFs mais antigas que o checkpoint — pode parar

        nf_headers.extend(page)
        pag = _extract_pagination(resp)
        total = _int(pag.get("total", 0))

        offset += 100
        if offset >= total or len(_extract_nf_list(resp)) < 100:
            break
        time.sleep(0.1)

    if verbose:
        print(f"  NFs encontradas: {len(nf_headers)}")

    if not nf_headers:
        return {}

    # ── Fase 2: para cada NF, buscar detalhes e custo por item ──
    sku_map: dict[str, CustoData] = {}

    for idx, nf_hdr in enumerate(nf_headers, 1):
        nf_id     = _int(nf_hdr.get("id", 0))
        nf_numero = str(nf_hdr.get("numero") or "").strip()
        nf_data   = str(nf_hdr.get("dataEmissao") or "").strip()

        if not nf_id:
            continue

        if verbose and idx % 20 == 0:
            print(f"  Processando NF {idx}/{len(nf_headers)}...")

        try:
            detail = _get_nf_detail(nf_id)
        except Exception as e:
            if verbose:
                print(f"  Aviso: erro ao buscar NF {nf_id}: {e}")
            time.sleep(0.3)
            continue

        items = detail.get("itens") or []
        if not isinstance(items, list):
            time.sleep(0.1)
            continue

        for item in items:
            sku = str(item.get("codigo") or "").strip()
            if not sku:
                continue

            id_item  = _int(item.get("idItem") or item.get("id") or 0)
            qty      = _float(item.get("quantidade") or 1) or 1
            unit     = _float(item.get("valorUnitario") or 0)
            descricao = str(item.get("descricao") or "").strip()

            if unit <= 0:
                continue

            # Busca impostos detalhados por item
            ipi_val = icms_val = pis_val = cofins_val = 0.0
            if id_item:
                item_detail = _get_nf_item_detail(nf_id, id_item)
                ipi_val    = _extract_imposto_valor(item_detail.get("ipi"))    / qty
                icms_val   = _extract_imposto_valor(item_detail.get("icms"))   / qty
                pis_val    = _extract_imposto_valor(item_detail.get("pis"))    / qty
                cofins_val = _extract_imposto_valor(item_detail.get("cofins")) / qty
                time.sleep(0.5)  # respeita rate limit Tiny (~60 req/min)

            # Mantém apenas a NF mais recente por SKU
            if sku not in sku_map:
                sku_map[sku] = CustoData(
                    sku=sku,
                    descricao=descricao,
                    custo_base=round(unit, 4),
                    ipi_valor=round(ipi_val, 4),
                    icms_credito=round(icms_val, 4),
                    pis_credito=round(pis_val, 4),
                    cofins_credito=round(cofins_val, 4),
                    nf_numero=nf_numero,
                    nf_data=nf_data,
                    nf_id=nf_id,
                )

        time.sleep(0.1)

    if verbose:
        print(f"  SKUs com custo mapeado: {len(sku_map)}")

    return sku_map
