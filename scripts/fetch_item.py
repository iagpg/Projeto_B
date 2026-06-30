"""
fetch_item.py — fetch a single ML item by ID
Usage: python fetch_item.py MLB3347232243
"""
import json, sys
from pathlib import Path
import requests

cfg = json.load(open(Path(__file__).parent.parent / "config.json"))
token = cfg["ml_access_token"]

item_id = sys.argv[1] if len(sys.argv) > 1 else "MLB3347232243"
r = requests.get(f"https://api.mercadolibre.com/items/{item_id}", params={"access_token": token}, timeout=10)
print(json.dumps(r.json(), indent=2, ensure_ascii=False))
