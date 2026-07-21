"""
connectors/tiny/nf.py
----------------------
Notas Fiscais de entrada do Tiny ERP v3.
Mapeia SKU → custo real de compra com valores absolutos de impostos por unidade.

Fluxo de API:
  GET /notas?tipo=E&limit=100&offset=0       → lista NFs de entrada
  GET /notas/{id}                             → detalhe com itens[] (idItem, idProduto, codigo, qty, valor)
  GET /notas/{id}/itens/{idItem}              → impostos por item (valorImposto de IPI/ICMS/PIS/COFINS)
  GET /produtos?pagina=N&limite=100           → id + sku de todo o catálogo, usado pra resolver o SKU
                                                 atual via idProduto (o "codigo" do item pode ser um
                                                 código antigo/do fornecedor, diferente do SKU atual)

Uso:
    from connectors.tiny.nf import build_sku_cost_map, CustoData
    cost_map = build_sku_cost_map()
    custo = cost_map.get("42")
"""

import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

import sys as _sys
from pathlib import Path as _Path

_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent.parent))
from connectors.tiny.client import get as tiny_get

_MAX_WORKERS = 5  # concorrência das fases de busca — client.get() já trata 429 com backoff


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

def _list_nf_page(offset: int, data_inicio: str, data_fim: str,
                   numero: Optional[str] = None) -> dict:
    """
    GET /notas?tipo=E&limit=100&offset=N
    Parâmetros corretos da API v3: limit/offset, datas YYYY-MM-DD, situacao como int.
    situacao=4 = Autorizada. Omitida para capturar todas (incluindo em processamento).

    Se `numero` for passado, busca só essa NF específica (ignora o intervalo de datas).
    """
    params = {
        "tipo":  "E",
        "limit": 100,
        "offset": offset,
    }
    if numero:
        params["numero"] = numero
    else:
        params["dataInicial"] = data_inicio
        params["dataFinal"]   = data_fim
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


# ── Mapa idProduto → SKU atual ──────────────────────────────────────────────────
#
# O campo "codigo" de um item de NF pode ser o código usado NA NOTA (às vezes
# o código do fornecedor, ou um código antigo/descontinuado) — diferente do
# SKU atual do produto no Tiny. O item da NF também traz "idProduto" (ID
# interno, estável), que é a forma confiável de achar o SKU real: GET
# /produtos/{idProduto} devolve o produto direto, sem precisar varrer o
# catálogo. Exemplo real: NF 213583, item código "WPSRESENOINP46" →
# idProduto 991633087 → produto atual tem sku "10034034168445".

def _get_produto_sku(id_produto: int) -> Optional[str]:
    """GET /produtos/{id} → SKU atual desse produto (None se falhar/não achar)."""
    try:
        resp = tiny_get(f"/produtos/{id_produto}")
        produto = resp if ("id" in resp or "sku" in resp or "codigo" in resp) else (resp.get("data") or resp)
        sku = str(produto.get("sku") or produto.get("codigo") or "").strip()
        return sku or None
    except Exception:
        return None


def _resolve_id_produto_sku(id_produtos: set, verbose: bool = True) -> dict:
    """Resolve idProduto -> SKU atual, um GET /produtos/{id} por ID, em paralelo."""
    id_produtos = {p for p in id_produtos if p}
    if not id_produtos:
        return {}

    if verbose:
        print(f"  Resolvendo {len(id_produtos)} idProduto -> SKU...")
    mapa: dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = {pool.submit(_get_produto_sku, pid): pid for pid in id_produtos}
        for futuro in as_completed(futuros):
            pid = futuros[futuro]
            sku = futuro.result()
            if sku:
                mapa[pid] = sku
    return mapa


# ── Mapa SKU → custo ──────────────────────────────────────────────────────────

def build_sku_cost_map(months_back: int = 12,
                       since_nf_id: Optional[int] = None,
                       data_inicio: Optional[str] = None,
                       data_fim: Optional[str] = None,
                       numero_nf: Optional[str] = None,
                       verbose: bool = True) -> dict:
    """
    Varre NFs de entrada e retorna dict[sku → CustoData].

    Se since_nf_id for passado, busca apenas NFs com id > since_nf_id (incremental).
    Se data_inicio/data_fim forem passados, usa esse intervalo exato em vez de
    months_back (útil pra preencher um período histórico específico).
    Se numero_nf for passado, busca só essa NF (ignora datas e since_nf_id).
    Mantém apenas a NF mais recente por SKU (dentro desta varredura).

    Retorna:
        dict[str, CustoData]  — somente SKUs com custo encontrado
        O chamador pode verificar o maior nf_id processado via max(v.nf_id for v in result.values())
    """
    hoje = datetime.today()
    if not numero_nf:
        data_inicio = data_inicio or (hoje - timedelta(days=30 * months_back)).strftime("%Y-%m-%d")
        data_fim    = data_fim or hoje.strftime("%Y-%m-%d")

    if verbose:
        if numero_nf:
            print(f"  Buscando NF específica: numero={numero_nf}")
        else:
            modo = f"incremental (since_nf_id={since_nf_id})" if since_nf_id else "completo"
            print(f"  Buscando NFs de entrada [{modo}]: {data_inicio} -> {data_fim}")

    # ── Fase 1: listar todas as NFs de entrada ──────────────────
    nf_headers = []
    offset = 0
    while True:
        resp = _list_nf_page(offset, data_inicio, data_fim, numero=numero_nf)
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

    # ── Fase 2: buscar o DETALHE de TODAS as NFs (concorrente) ──────────────────
    # Busca tudo primeiro; o cálculo (fase 5) é só aritmética em memória depois,
    # sem nenhuma chamada de API — evita ficar alternando 1 chamada / 1 cálculo /
    # 1 chamada..., que é o que fazia o rate limit da API estourar com mais
    # facilidade (cada chamada isolada carrega overhead de rede fixo).
    nf_ids = [_int(h.get("id", 0)) for h in nf_headers if _int(h.get("id", 0))]
    if verbose:
        print(f"  Buscando detalhes de {len(nf_ids)} NFs (até {_MAX_WORKERS} em paralelo)...")

    detalhes_por_nf: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = {pool.submit(_get_nf_detail, nf_id): nf_id for nf_id in nf_ids}
        for i, futuro in enumerate(as_completed(futuros), 1):
            nf_id = futuros[futuro]
            try:
                detalhes_por_nf[nf_id] = futuro.result()
            except Exception as e:
                if verbose:
                    print(f"  Aviso: erro ao buscar NF {nf_id}: {e}")
            if verbose and i % 50 == 0:
                print(f"  NFs: {i}/{len(nf_ids)}")

    # ── Fase 3: resolver idProduto -> SKU só p/ os IDs citados nestas NFs ───────
    id_produtos_citados = {
        _int(item.get("idProduto") or 0)
        for detail in detalhes_por_nf.values()
        for item in (detail.get("itens") or [])
    }
    id_produto_sku = _resolve_id_produto_sku(id_produtos_citados, verbose=verbose)

    # ── Fase 3b: montar a lista de itens pendentes (ainda sem impostos) ─────────
    pendentes = []  # {nf_id, nf_numero, nf_data, id_item, sku, qty, unit, descricao}
    for nf_hdr in nf_headers:
        nf_id = _int(nf_hdr.get("id", 0))
        detail = detalhes_por_nf.get(nf_id)
        if not detail:
            continue
        nf_numero = str(nf_hdr.get("numero") or "").strip()
        nf_data   = str(nf_hdr.get("dataEmissao") or "").strip()

        items = detail.get("itens") or []
        if not isinstance(items, list):
            continue

        for item in items:
            id_produto = _int(item.get("idProduto") or 0)
            sku = id_produto_sku.get(id_produto) or str(item.get("codigo") or "").strip()
            if not sku:
                continue
            unit = _float(item.get("valorUnitario") or 0)
            if unit <= 0:
                continue
            pendentes.append({
                "nf_id": nf_id, "nf_numero": nf_numero, "nf_data": nf_data,
                "id_item": _int(item.get("idItem") or item.get("id") or 0),
                "sku": sku,
                "qty": _float(item.get("quantidade") or 1) or 1,
                "unit": unit,
                "descricao": str(item.get("descricao") or "").strip(),
            })

    # ── Fase 4: buscar os impostos de TODOS os itens (concorrente) ─────────────
    com_id_item = [p for p in pendentes if p["id_item"]]
    if verbose:
        print(f"  Buscando impostos de {len(com_id_item)} itens (até {_MAX_WORKERS} em paralelo)...")

    impostos_por_item: dict[tuple, dict] = {}
    with ThreadPoolExecutor(max_workers=_MAX_WORKERS) as pool:
        futuros = {pool.submit(_get_nf_item_detail, p["nf_id"], p["id_item"]): p for p in com_id_item}
        for i, futuro in enumerate(as_completed(futuros), 1):
            p = futuros[futuro]
            impostos_por_item[(p["nf_id"], p["id_item"])] = futuro.result()
            if verbose and i % 50 == 0:
                print(f"  Itens: {i}/{len(com_id_item)}")

    # ── Fase 5: cálculo final — puro em memória, nenhuma chamada de API aqui ───
    sku_map: dict[str, CustoData] = {}
    for p in pendentes:
        sku = p["sku"]
        if sku in sku_map:
            continue  # mantém a NF mais recente por SKU (primeira encontrada, mesma ordem de nf_headers)

        taxes = impostos_por_item.get((p["nf_id"], p["id_item"]), {}) if p["id_item"] else {}
        qty = p["qty"]
        sku_map[sku] = CustoData(
            sku=sku,
            descricao=p["descricao"],
            custo_base=round(p["unit"], 4),
            ipi_valor=round(_extract_imposto_valor(taxes.get("ipi")) / qty, 4),
            icms_credito=round(_extract_imposto_valor(taxes.get("icms")) / qty, 4),
            pis_credito=round(_extract_imposto_valor(taxes.get("pis")) / qty, 4),
            cofins_credito=round(_extract_imposto_valor(taxes.get("cofins")) / qty, 4),
            nf_numero=p["nf_numero"],
            nf_data=p["nf_data"],
            nf_id=p["nf_id"],
        )

    if verbose:
        print(f"  SKUs com custo mapeado: {len(sku_map)}")

    return sku_map
