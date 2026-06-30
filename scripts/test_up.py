"""
test_up.py — testa endpoint de migração de item MLB
Usage: python test_up.py MLB3347232243
"""
import sys
import json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from validate_skus import refresh_ml_token, ml_get, ml_find_active_for_migrated

refresh_ml_token()

item_id = sys.argv[1] if len(sys.argv) > 1 else "MLB3347232243"

print(f"\n=== migration_live_listing para {item_id} ===")
r = ml_get(f"https://api.mercadolibre.com/items/{item_id}/migration_live_listing")
print(json.dumps(r.json(), indent=2, ensure_ascii=False)[:1500])

print(f"\n=== ml_find_active_for_migrated({item_id}) ===")
first_id, summary = ml_find_active_for_migrated(item_id)
print(f"first_id : {first_id}")
print(f"summary  : {summary}")
