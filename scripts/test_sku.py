"""
test_sku.py — run build_col_e for one SKU and print the result.
Usage: python test_sku.py <SKU>
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from validate_skus import build_col_e, refresh_ml_token

refresh_ml_token()

sku = sys.argv[1] if len(sys.argv) > 1 else "10034034168169"
print(f"\nTesting SKU: {sku}")
val, color = build_col_e(sku)
print(f"\nColumn E : {val}")
print(f"Color    : {color}")
