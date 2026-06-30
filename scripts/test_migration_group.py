"""
test_migration_group.py — Testa como encontrar o item_group_id de um anúncio migrado
Usage: python test_migration_group.py
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from validate_skus import ml_get, refresh_ml_token

refresh_ml_token()

import requests

cfg = json.load(open(Path(__file__).parent.parent / "config.json"))
token  = cfg["ml_access_token"]
uid    = cfg["ml_user_id"]
item_id = "MLB3347232243"

print(f"\n=== Buscando item {item_id} ===")
r = ml_get(f"https://api.mercadolibre.com/items/{item_id}",
           {"attributes": "id,status,tags,item_group_id,variations"})
d = r.json()

print(f"status: {d.get('status')}")
print(f"item_group_id: {d.get('item_group_id')}")
print(f"tags migração: {[t for t in (d.get('tags') or []) if 'migr' in t.lower()]}")

vars_ = d.get("variations", [])
print(f"\nVariações encontradas: {len(vars_)}")
for v in vars_[:3]:
    upid = v.get("user_product_id")
    scf  = v.get("seller_custom_field")
    inv  = v.get("inventory_id")
    print(f"  variation id={v.get('id')} | user_product_id={upid} | seller_custom_field={scf} | inventory_id={inv}")

# Testa user_products endpoint com o primeiro user_product_id
if vars_:
    upid = vars_[0].get("user_product_id")
    if upid:
        print(f"\n=== User Products endpoint para {upid} ===")
        r2 = ml_get(f"https://api.mercadolibre.com/users/{uid}/user_products/{upid}")
        resp = r2.json()
        print(f"item_group_id: {resp.get('item_group_id')}")
        print(f"status: {resp.get('status')}")
        print(json.dumps(resp, indent=2, ensure_ascii=False)[:600])
