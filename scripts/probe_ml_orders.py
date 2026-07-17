"""
scripts/probe_ml_orders.py — diagnostico raw da API de pedidos ML
"""
import sys, json, requests
from pathlib import Path
from datetime import date

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from connectors.mercadolivre.client import _cfg, _ml_access_token, ML_USER_ID as USER_ID

BASE  = "https://api.mercadolibre.com"
TOKEN = _ml_access_token

hoje    = date.today()
ini_mes = hoje.replace(day=1)
fmt     = lambda d: f"{d.isoformat()}T00:00:00.000-03:00"
fmt_fim = lambda d: f"{d.isoformat()}T23:59:59.000-03:00"

print(f"User ID : {USER_ID}")
print(f"Token   : {TOKEN[:50]}...")
print(f"Periodo : {ini_mes} -> {hoje}")
print()

endpoints = [
    ("/orders/search", {
        "seller":                  USER_ID,
        "order.status":            "paid",
        "order.date_created.from": fmt(ini_mes),
        "order.date_created.to":   fmt_fim(hoje),
        "limit": 5,
    }),
    ("/orders/search", {
        "seller": USER_ID,
        "limit":  5,
    }),
]

for path, params in endpoints:
    url = BASE + path
    print(f"GET {path}")
    print(f"Params: { {k:v for k,v in params.items()} }")

    # tenta via query param
    r = requests.get(url, params={**params, "access_token": TOKEN}, timeout=15)
    print(f"HTTP {r.status_code} (query param)")
    try:
        body = r.json()
        print(json.dumps(body)[:600])
    except Exception:
        print(r.text[:600])

    if r.status_code != 200:
        # tenta via Authorization header
        r2 = requests.get(url, params=params, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=15)
        print(f"HTTP {r2.status_code} (Bearer header)")
        try:
            body2 = r2.json()
            print(json.dumps(body2)[:600])
        except Exception:
            print(r2.text[:600])
    print()
