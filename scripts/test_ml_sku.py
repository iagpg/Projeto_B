"""
test_ml_sku.py — search ML by seller_sku and show raw results
Usage: python test_ml_sku.py <SKU>
"""
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from validate_skus import ml_search_sku, ml_get_items_status, refresh_ml_token

refresh_ml_token()

sku = sys.argv[1] if len(sys.argv) > 1 else "912283"
print(f"\nSearching ML for seller_sku: {sku}")
ids = ml_search_sku(sku)
print(f"IDs returned: {ids}")

if ids:
    print(f"\nFetching status for: {ids}")
    statuses = ml_get_items_status(ids)
    print(f"Statuses: {statuses}")
