"""
connectors/mercadolivre/client.py
----------------------------------
Camada HTTP do Mercado Livre: autenticação OAuth2, retry e todas as
chamadas de baixo nível. Não contém lógica de negócio.

Uso direto (baixo nível):
    from connectors.mercadolivre.client import lookup
    result = lookup("MLB4097684635")
    result = lookup("10034034168089")
"""

import json
import time
import sys
from pathlib import Path
import requests

# ── Config ────────────────────────────────────────────────────────────────────

_ROOT   = Path(__file__).parent.parent.parent   # d:/backend
_CONFIG = _ROOT / "config.json"
_BASE   = "https://api.mercadolibre.com"

with open(_CONFIG) as _f:
    _cfg = json.load(_f)

ML_CLIENT_ID     = _cfg["ml_client_id"]
ML_CLIENT_SECRET = _cfg["ml_client_secret"]
ML_USER_ID       = _cfg["ml_user_id"]

_ml_access_token  = _cfg.get("ml_access_token", "")
_ml_refresh_token = _cfg.get("ml_refresh_token", "")


# ── Token management ──────────────────────────────────────────────────────────

def _save_tokens() -> None:
    _cfg["ml_access_token"]  = _ml_access_token
    _cfg["ml_refresh_token"] = _ml_refresh_token
    with open(_CONFIG, "w") as f:
        json.dump(_cfg, f, indent=2)


def refresh_token() -> None:
    global _ml_access_token, _ml_refresh_token
    r = requests.post(f"{_BASE}/oauth/token", data={
        "grant_type":    "refresh_token",
        "client_id":     ML_CLIENT_ID,
        "client_secret": ML_CLIENT_SECRET,
        "refresh_token": _ml_refresh_token,
    }, timeout=15)
    d = r.json()
    if "access_token" not in d:
        raise RuntimeError(f"ML token refresh failed: {d}")
    _ml_access_token  = d["access_token"]
    _ml_refresh_token = d.get("refresh_token", _ml_refresh_token)
    _save_tokens()


# ── HTTP ──────────────────────────────────────────────────────────────────────

def ml_get(url: str, params: dict | None = None, *, _retry: bool = True):
    """GET com access_token como query param, refresh no 401, back-off no 429.
    Retorna JSON parseado (dict ou list), ou {} em 404."""
    p = dict(params or {})
    p["access_token"] = _ml_access_token
    r = requests.get(url, params=p, timeout=15)
    if r.status_code == 401 and _retry:
        refresh_token()
        return ml_get(url, params, _retry=False)
    if r.status_code == 429:
        time.sleep(3)
        return ml_get(url, params, _retry=_retry)
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    return r.json()


# ── Endpoints ─────────────────────────────────────────────────────────────────

_ATTRS = "id,status,tags,item_group_id,catalog_product_id,title,seller_sku,attributes"


def extract_seller_sku(item: dict) -> str:
    """
    O ML guarda o SKU em dois lugares possíveis:
      - campo direto 'seller_sku' (legado, nem sempre preenchido)
      - dentro de attributes[] com id 'SELLER_SKU' (ficha técnica do anúncio)
    Retorna o primeiro valor não vazio encontrado.
    """
    direct = str(item.get("seller_sku") or "").strip()
    if direct:
        return direct
    for attr in item.get("attributes") or []:
        if attr.get("id") == "SELLER_SKU":
            val = attr.get("value_name") or ""
            if not val and attr.get("values"):
                val = attr["values"][0].get("name") or ""
            return str(val).strip()
    return ""


def get_item(item_id: str) -> dict:
    """Busca um item pelo MLB ID. Retorna {} se não encontrado."""
    data = ml_get(f"{_BASE}/items/{item_id}", {"attributes": _ATTRS})
    return data if isinstance(data, dict) else {}


def get_items_batch(ids: list) -> list:
    """Busca até 20 items em uma chamada. Retorna lista de dicts."""
    if not ids:
        return []
    data = ml_get(f"{_BASE}/items", {
        "ids":        ",".join(ids[:20]),
        "attributes": _ATTRS,
    })
    if not isinstance(data, list):
        return []
    return [
        entry["body"]
        for entry in data
        if isinstance(entry, dict) and entry.get("code") == 200 and entry.get("body", {}).get("id")
    ]


def search_by_sku(sku: str) -> list:
    """Busca por seller_sku. Retorna lista de MLB IDs."""
    data = ml_get(f"{_BASE}/users/{ML_USER_ID}/items/search", {"seller_sku": sku})
    return data.get("results", []) if isinstance(data, dict) else []


def search_by_group(item_group_id: str) -> list:
    """Busca por item_group_id. Retorna lista de MLB IDs ativos no grupo."""
    if not item_group_id:
        return []
    data = ml_get(f"{_BASE}/users/{ML_USER_ID}/items/search", {"item_group_id": item_group_id})
    return data.get("results", []) if isinstance(data, dict) else []


def get_migration(item_id: str) -> list:
    """Mapeia item migrado → novos itens.
    Retorna new_items: [{variation_id, new_item_id, migration_status}]"""
    data = ml_get(f"{_BASE}/items/{item_id}/migration_live_listing")
    return data.get("new_items", []) if isinstance(data, dict) else []


def get_user_product(item_id: str) -> dict:
    """Busca user product para item ATIVO. Retorna {} para closed/migrados."""
    data = ml_get(f"{_BASE}/users/{ML_USER_ID}/user_products", {"item_id": item_id})
    if isinstance(data, dict):
        results = data.get("results", [])
        return results[0] if results else {}
    return {}


# ── MLResult ──────────────────────────────────────────────────────────────────

class MLResult:
    """Resultado de uma busca no Mercado Livre."""

    __slots__ = (
        "identifier", "found", "status", "is_migrated",
        "item_id", "title", "seller_sku", "tags",
        "item_group_id", "catalog_product_id",
        "migration_ids", "raw",
    )

    def __init__(self):
        self.identifier: str   = ""
        self.found: bool       = False
        self.status: str       = ""  # active | paused | closed | migrated | not_found
        self.is_migrated: bool = False
        self.item_id: str      = ""
        self.title: str        = ""
        self.seller_sku: str   = ""
        self.tags: list        = []
        self.item_group_id: str      = ""
        self.catalog_product_id: str = ""
        self.migration_ids: list     = []
        self.raw: dict               = {}

    def __repr__(self) -> str:
        if not self.found:
            return f"MLResult(not_found, identifier={self.identifier!r})"
        parts = [f"MLResult(status={self.status!r}, item_id={self.item_id!r}"]
        if self.is_migrated:
            parts.append(f"migration_ids={self.migration_ids!r}")
        return ", ".join(parts) + ")"

    def summary(self) -> str:
        if not self.found:
            return f"não encontrado: {self.identifier}"
        line = f"{self.item_id} | {self.status}"
        if self.seller_sku:
            line += f" | sku={self.seller_sku}"
        if self.is_migrated and self.migration_ids:
            ids_str = ", ".join(self.migration_ids[:3])
            if len(self.migration_ids) > 3:
                ids_str += f" (+{len(self.migration_ids) - 3})"
            line += f" | migrado → {ids_str}"
        return line


def _build_result(raw: dict) -> MLResult:
    r = MLResult()
    r.raw                = raw
    r.item_id            = raw.get("id", "")
    r.status             = raw.get("status", "")
    r.title              = raw.get("title", "")
    r.seller_sku         = extract_seller_sku(raw)
    r.tags               = raw.get("tags") or []
    r.item_group_id      = raw.get("item_group_id") or ""
    r.catalog_product_id = raw.get("catalog_product_id") or ""
    r.found              = bool(r.item_id)

    if r.status == "closed" and "variations_migration_source" in r.tags:
        r.is_migrated = True
        r.status = "migrated"
        new_items = get_migration(r.item_id)
        created = [n["new_item_id"] for n in new_items if n.get("migration_status") == "created" and n.get("new_item_id")]
        r.migration_ids = list(dict.fromkeys(created or [n["new_item_id"] for n in new_items if n.get("new_item_id")]))

    return r


# ── lookup (entry point) ──────────────────────────────────────────────────────

def lookup(identifier) -> MLResult:
    """
    Busca um anúncio no ML por MLB ID ou SKU.

    - MLB ID (começa com 'MLB'): busca direta via /items/{id}
    - SKU: busca via seller_sku, retorna melhor resultado (active > paused > migrated > closed)

    Detecta migração automaticamente.
    Aceita float do Excel (10034034168089.0 → '10034034168089').
    """
    if isinstance(identifier, float) and identifier == int(identifier):
        identifier = int(identifier)
    identifier = str(identifier).strip()
    if identifier.endswith(".0") and identifier[:-2].isdigit():
        identifier = identifier[:-2]

    empty = MLResult()
    empty.identifier = identifier
    empty.status = "not_found"

    if not identifier:
        return empty

    # MLB ID path
    if identifier.upper().startswith("MLB"):
        raw = get_item(identifier)
        if not raw.get("id"):
            return empty
        result = _build_result(raw)
        result.identifier = identifier
        return result

    # SKU path
    mlb_ids = search_by_sku(identifier)
    time.sleep(0.15)
    if not mlb_ids:
        return empty

    raw_list = [get_item(mlb_ids[0])] if len(mlb_ids) == 1 else get_items_batch(mlb_ids)
    time.sleep(0.15)

    results = [_build_result(r) for r in raw_list if r.get("id")]
    if not results:
        return empty

    order = {"active": 0, "paused": 1, "migrated": 2, "closed": 3}
    results.sort(key=lambda r: order.get(r.status, 9))
    best = results[0]
    best.identifier = identifier
    return best
