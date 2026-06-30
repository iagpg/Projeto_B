"""
ml_finder.py
------------
Ferramenta de rastreamento de anúncios no Mercado Livre.
Busca por MLB ID ou SKU; detecta status, migração e variações.

Uso como módulo:
    import ml_finder as ml
    result = ml.lookup("MLB4097684635")
    result = ml.lookup("10034034168089")

Uso no terminal:
    python ml_finder.py MLB4097684635
    python ml_finder.py 10034034168089
"""

import json
import time
import sys
from pathlib import Path
import requests

# ── Config ────────────────────────────────────────────────────────────────────

_DIR        = Path(__file__).parent.parent
_CONFIG     = _DIR / "config.json"
_BASE       = "https://api.mercadolibre.com"

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


def _refresh_token() -> None:
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


def ml_get(url: str, params: dict | None = None, *, _retry: bool = True):
    """GET with access_token param, 401 refresh, and 429 back-off.
    Returns parsed JSON (dict or list), or {} on 404."""
    p = dict(params or {})
    p["access_token"] = _ml_access_token
    r = requests.get(url, params=p, timeout=15)
    if r.status_code == 401 and _retry:
        _refresh_token()
        return ml_get(url, params, _retry=False)
    if r.status_code == 429:
        time.sleep(3)
        return ml_get(url, params, _retry=_retry)
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    return r.json()


# ── Item endpoints ────────────────────────────────────────────────────────────

_ATTRS = "id,status,tags,item_group_id,catalog_product_id,title,seller_sku"


def get_item(item_id: str) -> dict:
    """Fetch a single item by MLB ID. Returns {} if not found."""
    data = ml_get(f"{_BASE}/items/{item_id}", {"attributes": _ATTRS})
    return data if isinstance(data, dict) else {}


def get_items_batch(ids: list) -> list:
    """Fetch up to 20 items in one call. Returns list of item body dicts."""
    if not ids:
        return []
    data = ml_get(f"{_BASE}/items", {
        "ids":        ",".join(ids[:20]),
        "attributes": _ATTRS,
    })
    if not isinstance(data, list):
        return []
    bodies = []
    for entry in data:
        if isinstance(entry, dict) and entry.get("code") == 200:
            body = entry.get("body") or {}
            if body.get("id"):
                bodies.append(body)
    return bodies


def search_by_sku(sku: str) -> list:
    """Search by seller_sku. Returns list of MLB ID strings."""
    data = ml_get(
        f"{_BASE}/users/{ML_USER_ID}/items/search",
        {"seller_sku": sku},
    )
    if isinstance(data, dict):
        return data.get("results", [])
    return []


def search_by_group(item_group_id: str) -> list:
    """Search by item_group_id. Returns list of MLB ID strings."""
    if not item_group_id:
        return []
    data = ml_get(
        f"{_BASE}/users/{ML_USER_ID}/items/search",
        {"item_group_id": item_group_id},
    )
    if isinstance(data, dict):
        return data.get("results", [])
    return []


def get_migration(item_id: str) -> list:
    """Fetch migration_live_listing for a migrated item.
    Returns new_items list: [{variation_id, new_item_id, migration_status}]"""
    data = ml_get(f"{_BASE}/items/{item_id}/migration_live_listing")
    if isinstance(data, dict):
        return data.get("new_items", [])
    return []


def get_user_product(item_id: str) -> dict:
    """Fetch user product for an ACTIVE item.
    Returns {} for closed/migrated items (endpoint limitation)."""
    data = ml_get(
        f"{_BASE}/users/{ML_USER_ID}/user_products",
        {"item_id": item_id},
    )
    if isinstance(data, dict):
        results = data.get("results", [])
        return results[0] if results else {}
    return {}


# ── Result ────────────────────────────────────────────────────────────────────

class MLResult:
    """Result of a Mercado Livre listing lookup."""

    __slots__ = (
        "identifier", "found", "status", "is_migrated",
        "item_id", "title", "seller_sku", "tags",
        "item_group_id", "catalog_product_id",
        "migration_ids", "raw",
    )

    def __init__(self):
        self.identifier: str       = ""
        self.found: bool           = False
        self.status: str           = ""       # active | paused | closed | migrated | not_found
        self.is_migrated: bool     = False
        self.item_id: str          = ""
        self.title: str            = ""
        self.seller_sku: str       = ""
        self.tags: list            = []
        self.item_group_id: str    = ""
        self.catalog_product_id: str = ""
        self.migration_ids: list   = []       # new MLB IDs when migrated
        self.raw: dict             = {}

    def __repr__(self) -> str:
        if not self.found:
            return f"MLResult(not_found, identifier={self.identifier!r})"
        parts = [f"MLResult(status={self.status!r}, item_id={self.item_id!r}"]
        if self.is_migrated:
            parts.append(f"migration_ids={self.migration_ids!r}")
        return ", ".join(parts) + ")"

    def summary(self) -> str:
        """One-line human-readable summary."""
        if not self.found:
            return f"não encontrado: {self.identifier}"
        line = f"{self.item_id} | {self.status}"
        if self.seller_sku:
            line += f" | sku={self.seller_sku}"
        if self.is_migrated and self.migration_ids:
            line += f" | migrado → {', '.join(self.migration_ids[:3])}"
            if len(self.migration_ids) > 3:
                line += f" (+{len(self.migration_ids) - 3})"
        return line


def _build_result(raw: dict) -> "MLResult":
    """Build an MLResult from a raw item dict."""
    r = MLResult()
    r.raw  = raw
    r.item_id             = raw.get("id", "")
    r.status              = raw.get("status", "")
    r.title               = raw.get("title", "")
    r.seller_sku          = raw.get("seller_sku", "")
    r.tags                = raw.get("tags") or []
    r.item_group_id       = raw.get("item_group_id", "") or ""
    r.catalog_product_id  = raw.get("catalog_product_id", "") or ""
    r.found               = bool(r.item_id)

    if r.status == "closed" and "variations_migration_source" in r.tags:
        r.is_migrated = True
        r.status = "migrated"
        new_items = get_migration(r.item_id)
        created = [n["new_item_id"] for n in new_items if n.get("migration_status") == "created" and n.get("new_item_id")]
        # Fall back to pending if no created entries yet
        r.migration_ids = created or [n["new_item_id"] for n in new_items if n.get("new_item_id")]
        # Deduplicate preserving order
        r.migration_ids = list(dict.fromkeys(r.migration_ids))

    return r


# ── Main lookup ───────────────────────────────────────────────────────────────

def lookup(identifier) -> MLResult:
    """
    Look up a Mercado Livre listing by MLB ID or SKU.

    - MLB ID (starts with 'MLB'): fetches directly via /items/{id}
    - SKU: searches via seller_sku, returns best result (active first)

    Returns an MLResult with status, migration info, etc.
    Migrated items get status='migrated' and migration_ids filled.
    """
    # Coerce float-like values from Excel (e.g. 10034034168089.0 → "10034034168089")
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

    # ── MLB ID path ──
    if identifier.upper().startswith("MLB"):
        raw = get_item(identifier)
        if not raw.get("id"):
            return empty
        result = _build_result(raw)
        result.identifier = identifier
        return result

    # ── SKU path ──
    mlb_ids = search_by_sku(identifier)
    time.sleep(0.15)
    if not mlb_ids:
        return empty

    if len(mlb_ids) == 1:
        raw_list = [get_item(mlb_ids[0])]
        time.sleep(0.15)
    else:
        raw_list = get_items_batch(mlb_ids)
        time.sleep(0.15)

    results = [_build_result(r) for r in raw_list if r.get("id")]
    if not results:
        return empty

    # Return best: active > paused > migrated > closed > anything
    order = {"active": 0, "paused": 1, "migrated": 2, "closed": 3}
    results.sort(key=lambda r: order.get(r.status, 9))
    best = results[0]
    best.identifier = identifier
    return best


# ── CLI ───────────────────────────────────────────────────────────────────────

def _print_result(r: MLResult) -> None:
    sep = "─" * 56
    print(f"\n{sep}")
    print(f"  Entrada     {r.identifier}")
    if not r.found:
        print(f"  Resultado   não encontrado no ML")
        print(sep)
        return
    print(f"  MLB ID      {r.item_id}")
    print(f"  Status      {r.status}")
    if r.title:
        print(f"  Título      {r.title[:58]}")
    if r.seller_sku:
        print(f"  SKU (ML)    {r.seller_sku}")
    if r.item_group_id:
        print(f"  Grupo       {r.item_group_id}")
    if r.catalog_product_id:
        print(f"  Catálogo    {r.catalog_product_id}")
    if r.is_migrated:
        ids_str = ", ".join(r.migration_ids[:3])
        if len(r.migration_ids) > 3:
            ids_str += f" (+{len(r.migration_ids) - 3})"
        print(f"  Migrado →   {ids_str or '(sem novos criados)'}")
    migration_tags = [t for t in r.tags if "migration" in t]
    if migration_tags:
        print(f"  Tags ML     {', '.join(migration_tags)}")
    print(sep)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Uso: python ml_finder.py <MLB_ID ou SKU>")
        sys.exit(1)

    target = sys.argv[1]
    print(f"\nBuscando: {target} ...")
    res = lookup(target)
    _print_result(res)
