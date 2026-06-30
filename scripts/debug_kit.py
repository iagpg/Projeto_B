"""
debug_kit.py
------------
Prints the Tiny API v3 response for a kit SKU.

Usage:
    python debug_kit.py <KIT_SKU>
"""

import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from connectors.tiny import client as tc


def main():
    sku = sys.argv[1] if len(sys.argv) > 1 else "10034034168169"

    print(f"\n=== Searching Tiny v3 for SKU: {sku} ===")
    result = tc.get("/produtos", {"codigo": sku})
    print(json.dumps(result, indent=2, ensure_ascii=False))

    itens = result.get("itens", [])
    if not itens:
        print("\nNenhum produto encontrado.")
        return

    prod = itens[0]
    prod_id = prod.get("id")
    print(f"\n=== Full product detail (id={prod_id}) ===")
    detail = tc.get(f"/produtos/{prod_id}")
    print(json.dumps(detail, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
