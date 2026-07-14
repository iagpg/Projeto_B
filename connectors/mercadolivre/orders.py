"""
connectors/mercadolivre/orders.py
-----------------------------------
Pedidos, vendas e taxas do Mercado Livre.

Uso:
    from connectors.mercadolivre.orders import get_vendas_mes, get_pedidos_hoje, get_item_fees

    kpis = get_vendas_mes()   # {"total_R$": 15000.0, "count": 42, "ticket_medio": 357.14}
    hoje = get_pedidos_hoje() # {"count": 5}
    taxa = get_item_fees("MLB1234567890", 99.90)  # {"taxa_pct": 14.0, "taxa_R$": 13.99, "frete_R$": 0}
"""

import json
import time
from datetime import datetime, date, timedelta
from pathlib import Path

import requests

_ROOT   = Path(__file__).parent.parent.parent
_CONFIG = _ROOT / "config.json"
_BASE   = "https://api.mercadolibre.com"

with open(_CONFIG) as _f:
    _cfg = json.load(_f)

ML_CLIENT_ID     = _cfg["ml_client_id"]
ML_CLIENT_SECRET = _cfg["ml_client_secret"]
ML_USER_ID       = _cfg["ml_user_id"]
ML_TAXA_DEFAULT  = float(_cfg.get("ml_taxa_default_pct", 12.0))

_ml_access_token  = _cfg.get("ml_access_token", "")
_ml_refresh_token = _cfg.get("ml_refresh_token", "")


# ── Token ──────────────────────────────────────────────────────────────────────

def _save_tokens() -> None:
    _cfg["ml_access_token"]  = _ml_access_token
    _cfg["ml_refresh_token"] = _ml_refresh_token
    with open(_CONFIG, "w") as f:
        json.dump(_cfg, f, indent=2)


def _refresh() -> None:
    global _ml_access_token, _ml_refresh_token
    r = requests.post(f"{_BASE}/oauth/token", data={
        "grant_type":    "refresh_token",
        "client_id":     ML_CLIENT_ID,
        "client_secret": ML_CLIENT_SECRET,
        "refresh_token": _ml_refresh_token,
    }, timeout=15)
    d = r.json()
    if "access_token" not in d:
        raise RuntimeError(f"ML token refresh falhou: {d}")
    _ml_access_token  = d["access_token"]
    _ml_refresh_token = d.get("refresh_token", _ml_refresh_token)
    _save_tokens()


def _get(url: str, params: dict | None = None, *, _retry: bool = True):
    p = dict(params or {})
    p["access_token"] = _ml_access_token
    r = requests.get(url, params=p, timeout=15)
    if r.status_code == 401 and _retry:
        _refresh()
        return _get(url, params, _retry=False)
    if r.status_code == 429:
        time.sleep(3)
        return _get(url, params, _retry=_retry)
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    return r.json()


# ── Pedidos ────────────────────────────────────────────────────────────────────

def _iso(d: date) -> str:
    return d.strftime("%Y-%m-%dT00:00:00.000-03:00")


def _iso_end(d: date) -> str:
    return d.strftime("%Y-%m-%dT23:59:59.000-03:00")


def get_orders(date_from: date, date_to: date) -> list:
    """Retorna todos os pedidos pagos no intervalo de datas."""
    all_orders = []
    offset     = 0
    limit      = 50

    while True:
        data = _get(f"{_BASE}/orders/search", {
            "seller":                  ML_USER_ID,
            "order.status":            "paid",
            "order.date_created.from": _iso(date_from),
            "order.date_created.to":   _iso_end(date_to),
            "sort":                    "date_desc",
            "limit":                   limit,
            "offset":                  offset,
        })
        if not isinstance(data, dict):
            break

        results = data.get("results", [])
        all_orders.extend(results)

        paging = data.get("paging", {})
        total  = paging.get("total", 0)
        offset += limit
        if offset >= total or not results:
            break
        time.sleep(0.15)

    return all_orders


def get_vendas_mes() -> dict:
    """KPIs de vendas do mês corrente."""
    hoje   = date.today()
    inicio = hoje.replace(day=1)
    orders = get_orders(inicio, hoje)

    total = sum(float(o.get("total_amount", 0) or 0) for o in orders)
    count = len(orders)
    ticket = round(total / count, 2) if count else 0.0

    return {
        "total_R$":    round(total, 2),
        "count":       count,
        "ticket_medio": ticket,
    }


def get_pedidos_hoje() -> dict:
    """Conta pedidos pagos criados hoje."""
    hoje   = date.today()
    orders = get_orders(hoje, hoje)
    return {"count": len(orders)}


def get_anuncios_status() -> dict:
    """Conta anúncios ativos e pausados do vendedor."""
    active = 0
    paused = 0
    offset = 0
    limit  = 50

    while True:
        data = _get(f"{_BASE}/users/{ML_USER_ID}/items/search", {
            "limit":  limit,
            "offset": offset,
        })
        if not isinstance(data, dict):
            break

        results = data.get("results", [])
        if not results:
            break

        # Busca detalhes em batch para obter status
        batch = _get(f"{_BASE}/items", {
            "ids":        ",".join(results[:50]),
            "attributes": "id,status",
        })
        if isinstance(batch, list):
            for entry in batch:
                body = entry.get("body", {}) if isinstance(entry, dict) else {}
                st   = body.get("status", "")
                if st == "active":
                    active += 1
                elif st == "paused":
                    paused += 1

        paging = data.get("paging", {})
        total  = paging.get("total", 0)
        offset += limit
        if offset >= total:
            break
        time.sleep(0.1)

    return {"active": active, "paused": paused}


# ── Taxas ML ──────────────────────────────────────────────────────────────────

def get_item_fees(mlb_id: str, price: float) -> dict:
    """
    Retorna a taxa do ML para um anúncio em R$.
    Tenta GET /users/{uid}/items/{id}/fees — fallback: taxa default de config.json.
    """
    try:
        data = _get(
            f"{_BASE}/users/{ML_USER_ID}/items/{mlb_id}/fees",
            {"price": price},
        )
        if not isinstance(data, dict):
            raise ValueError("resposta inválida")

        # A API retorna uma estrutura com sale_fee_amount e/ou shipping_fee
        sale_fee   = float(data.get("sale_fee_amount", 0) or 0)
        frete      = float(data.get("shipping_fee_amount", 0) or 0)
        taxa_pct   = round(sale_fee / price * 100, 2) if price else ML_TAXA_DEFAULT
        return {
            "taxa_R$":   round(sale_fee, 2),
            "taxa_pct":  taxa_pct,
            "frete_R$":  round(frete, 2),
        }
    except Exception:
        # Fallback: usa taxa default configurada
        taxa_R = round(price * ML_TAXA_DEFAULT / 100, 2)
        return {
            "taxa_R$":   taxa_R,
            "taxa_pct":  ML_TAXA_DEFAULT,
            "frete_R$":  0.0,
        }


# ── Mapa SKU → MLB (para todos os produtos do vendedor) ───────────────────────

def build_sku_mlb_map() -> dict:
    """
    Pagina todos os anúncios do vendedor e retorna:
    dict[seller_sku → {mlb_id, price, status, category_id, title}]

    Mais eficiente que chamar search_by_sku() por item.
    """
    print("  Mapeando SKUs dos anúncios ML...")
    all_ids = []
    offset  = 0
    limit   = 50

    while True:
        data = _get(f"{_BASE}/users/{ML_USER_ID}/items/search", {
            "limit":  limit,
            "offset": offset,
        })
        if not isinstance(data, dict):
            break
        results = data.get("results", [])
        all_ids.extend(results)
        paging = data.get("paging", {})
        total  = paging.get("total", 0)
        offset += limit
        if offset >= total or not results:
            break
        time.sleep(0.1)

    print(f"  Total de anúncios ML: {len(all_ids)}")

    sku_map: dict = {}
    for i in range(0, len(all_ids), 20):
        chunk = all_ids[i:i + 20]
        batch = _get(f"{_BASE}/items", {
            "ids":        ",".join(chunk),
            "attributes": "id,title,price,status,category_id,seller_sku",
        })
        if isinstance(batch, list):
            for entry in batch:
                if not isinstance(entry, dict):
                    continue
                body = entry.get("body", {})
                if not isinstance(body, dict) or not body.get("id"):
                    continue
                sku = str(body.get("seller_sku") or "").strip()
                if sku:
                    sku_map[sku] = {
                        "mlb_id":      body["id"],
                        "price":       float(body.get("price") or 0),
                        "status":      body.get("status", ""),
                        "category_id": body.get("category_id", ""),
                        "title":       body.get("title", ""),
                    }
        time.sleep(0.1)

    print(f"  SKUs mapeados no ML: {len(sku_map)}")
    return sku_map
