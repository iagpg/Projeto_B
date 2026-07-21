"""
services/custo_service.py
--------------------------
Gerencia o cache local de custo de produtos a partir das Notas Fiscais do Tiny.

Cache persistido em cache/nf_custo.json.
Suporta varredura completa e incremental (só NFs novas desde o último sync).
Detecta mudanças de custo e retorna alertas.

Uso:
    from services.custo_service import build_cache, load_cache, detect_changes
"""

import json
from datetime import datetime
from pathlib import Path
from typing import Optional

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from connectors.tiny.nf import build_sku_cost_map, CustoData

_ROOT       = Path(__file__).parent.parent
_CACHE_FILE = _ROOT / "cache" / "nf_custo.json"
_CACHE_DIR  = _ROOT / "cache"

ALERTA_THRESHOLD_PCT = 2.0  # variação mínima (%) para gerar alerta


# ── Persistência ───────────────────────────────────────────────────────────────

def _load_raw() -> dict:
    if not _CACHE_FILE.exists():
        return {}
    try:
        with open(_CACHE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_raw(data: dict) -> None:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with open(_CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


# ── API pública ────────────────────────────────────────────────────────────────

def load_cache() -> dict[str, CustoData]:
    """
    Carrega cache/nf_custo.json e retorna dict sku → CustoData.
    Retorna {} se o cache não existir.
    """
    raw = _load_raw()
    skus = raw.get("skus", {})
    return {sku: CustoData.from_dict(data) for sku, data in skus.items()}


def build_cache(force_full: bool = False, months_back: int = 12,
                data_inicio: Optional[str] = None, data_fim: Optional[str] = None,
                numero_nf: Optional[str] = None,
                verbose: bool = True) -> dict[str, CustoData]:
    """
    Constrói ou atualiza o cache de custo NF.

    - force_full=True: varre os últimos `months_back` meses (ignora checkpoint)
    - force_full=False: varredura incremental — só NFs com id > last_nf_id
    - data_inicio/data_fim: varre esse intervalo exato em vez de months_back —
      útil pra preencher um período histórico específico (ex: um trecho de 2025
      anterior ao que a varredura incremental já cobre)
    - numero_nf: busca só essa NF específica

    data_inicio/data_fim/numero_nf ignoram o checkpoint incremental (since_nf_id)
    — um backfill de datas antigas não pode ser filtrado por "id > last_nf_id",
    já que NFs mais antigas têm ids menores. Por segurança, o merge com o cache
    existente só SOBRESCREVE um SKU se a NF nova for igual ou mais recente que
    a já cacheada (evita que um backfill antigo derrube um custo mais atual).

    Salva resultado em cache/nf_custo.json e retorna dict sku → CustoData.
    """
    raw = _load_raw()
    custom_range = bool(data_inicio or data_fim or numero_nf)
    since_nf_id: Optional[int] = None

    if not force_full and not custom_range and raw:
        since_nf_id = raw.get("last_nf_id")
        if verbose and since_nf_id:
            print(f"  Modo incremental: buscando NFs com id > {since_nf_id}")

    new_map = build_sku_cost_map(
        months_back=months_back,
        since_nf_id=since_nf_id,
        data_inicio=data_inicio,
        data_fim=data_fim,
        numero_nf=numero_nf,
        verbose=verbose,
    )

    # Merge: mantém a NF mais recente por SKU (nf_data em "YYYY-MM-DD" ordena como string)
    existing_skus = raw.get("skus", {})
    for sku, custo in new_map.items():
        atual = existing_skus.get(sku)
        if not atual or str(custo.nf_data) >= str(atual.get("nf_data", "")):
            existing_skus[sku] = custo.to_dict()

    last_nf_id = raw.get("last_nf_id", 0)
    if new_map and not custom_range:
        last_nf_id = max(last_nf_id, max(v.nf_id for v in new_map.values() if v.nf_id))

    _save_raw({
        "version":     datetime.now().isoformat(timespec="seconds"),
        "last_nf_id":  last_nf_id,
        "total_skus":  len(existing_skus),
        "skus":        existing_skus,
    })

    if verbose:
        if new_map:
            print(f"  Cache atualizado: {len(new_map)} SKU(s) novos/atualizados, "
                  f"{len(existing_skus)} total.")
        else:
            print("  Nenhuma NF nova encontrada. Cache já está atualizado.")

    return {sku: CustoData.from_dict(d) for sku, d in existing_skus.items()}


def detect_changes(old_cache: dict[str, CustoData],
                   new_cache: dict[str, CustoData],
                   threshold_pct: float = ALERTA_THRESHOLD_PCT) -> list[dict]:
    """
    Compara dois caches e retorna lista de mudanças relevantes.

    Cada item retornado:
        {sku, descricao, custo_antigo, custo_novo, variacao_pct, tipo}
        tipo: "aumento" | "reducao" | "novo"
    """
    alertas = []

    for sku, novo in new_cache.items():
        antigo = old_cache.get(sku)
        if antigo is None:
            alertas.append({
                "sku":          sku,
                "descricao":    novo.descricao,
                "custo_antigo": None,
                "custo_novo":   round(novo.custo_com_ipi, 2),
                "variacao_pct": None,
                "tipo":         "novo",
                "nf_numero":    novo.nf_numero,
                "nf_data":      novo.nf_data,
            })
            continue

        custo_antigo = antigo.custo_com_ipi
        custo_novo   = novo.custo_com_ipi

        if custo_antigo == 0:
            continue

        variacao_pct = (custo_novo - custo_antigo) / custo_antigo * 100

        if abs(variacao_pct) >= threshold_pct:
            alertas.append({
                "sku":          sku,
                "descricao":    novo.descricao or antigo.descricao,
                "custo_antigo": round(custo_antigo, 2),
                "custo_novo":   round(custo_novo, 2),
                "variacao_pct": round(variacao_pct, 1),
                "tipo":         "aumento" if variacao_pct > 0 else "reducao",
                "nf_numero":    novo.nf_numero,
                "nf_data":      novo.nf_data,
            })

    return sorted(alertas, key=lambda x: abs(x.get("variacao_pct") or 0), reverse=True)


def cache_info() -> dict:
    """Retorna metadados do cache atual sem carregar todos os SKUs."""
    raw = _load_raw()
    return {
        "exists":      _CACHE_FILE.exists(),
        "version":     raw.get("version"),
        "last_nf_id":  raw.get("last_nf_id"),
        "total_skus":  raw.get("total_skus", len(raw.get("skus", {}))),
        "cache_path":  str(_CACHE_FILE),
    }
