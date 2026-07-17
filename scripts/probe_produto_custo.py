"""
scripts/probe_produto_custo.py
-------------------------------
Dado um MLB ID (ou SKU), mostra:
  - Dados do anúncio no ML (sku, título, preço, status)
  - NF de entrada no Tiny para esse SKU (custo, IPI, ICMS)

Uso:
    python scripts/probe_produto_custo.py MLB4097684635
    python scripts/probe_produto_custo.py 800202C
"""

import sys, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from connectors.mercadolivre.client import lookup, ml_get, ML_USER_ID
from connectors.tiny.client import get as tiny_get

TINY_BASE = "https://erp.tiny.com.br/public-api/v3"
ML_BASE   = "https://api.mercadolibre.com"

identifier = sys.argv[1] if len(sys.argv) > 1 else "MLB4097684635"

print("\n" + "=" * 60)
print(f"  Produto: {identifier}")
print("=" * 60)

# ── 1. Busca no ML ──────────────────────────────────────────────
print("\n[ML] Buscando item...")
result = lookup(identifier)
print(f"  Status     : {result.status}")
print(f"  Item ID    : {result.item_id}")
print(f"  Seller SKU : {result.seller_sku}")
print(f"  Título     : {result.title}")

sku = result.seller_sku
item_id = result.item_id

if item_id:
    # Busca preço e categoria
    detail = ml_get(f"{ML_BASE}/items/{item_id}", {"attributes": "id,price,status,category_id,seller_sku"})
    print(f"  Preço      : R$ {detail.get('price', 'n/d')}")
    print(f"  Categoria  : {detail.get('category_id', 'n/d')}")

if not sku:
    print("\n  SKU não encontrado no ML. Encerrando.")
    sys.exit(0)

# ── 2. Busca NFs no Tiny ────────────────────────────────────────
print(f"\n[TINY] Buscando NFs de entrada com SKU '{sku}'...")

# Tenta endpoint /notas primeiro, depois /notas-fiscais
for endpoint in ["/notas", "/notas-fiscais"]:
    print(f"\n  Tentando {endpoint}...")
    try:
        resp = tiny_get(endpoint, {
            "tipo":     "E",
            "situacao": "A",
            "limite":   5,
            "pagina":   1,
        })
        print(f"  HTTP OK. Chaves da resposta: {list(resp.keys())}")
        inner = resp.get("data") or resp
        if isinstance(inner, dict):
            print(f"  Chaves internas: {list(inner.keys())}")
        # Pega primeira NF para inspecionar estrutura
        for key in ("itens", "notas", "items", "results"):
            v = inner.get(key) if isinstance(inner, dict) else None
            if isinstance(v, list) and v:
                print(f"  Lista em '{key}': {len(v)} itens")
                print(f"  Primeira NF (chaves): {list(v[0].keys())}")
                print(f"  Primeira NF: {json.dumps(v[0], ensure_ascii=False)[:400]}")
                break
        break
    except Exception as e:
        print(f"  Erro: {e}")

# ── 3. Busca itens de uma NF ────────────────────────────────────
print(f"\n[TINY] Testando /notas/{{id}}/itens ...")
try:
    resp2 = tiny_get("/notas", {"tipo": "E", "situacao": "A", "limite": 1, "pagina": 1})
    inner2 = resp2.get("data") or resp2
    for key in ("itens", "notas", "items", "results"):
        v2 = inner2.get(key) if isinstance(inner2, dict) else None
        if isinstance(v2, list) and v2:
            first_nf = v2[0]
            nf_id = first_nf.get("id")
            print(f"  NF id: {nf_id}")
            if nf_id:
                # Testa /notas/{id}/itens
                try:
                    resp3 = tiny_get(f"/notas/{nf_id}/itens")
                    print(f"  /notas/{nf_id}/itens -> chaves: {list(resp3.keys())}")
                    inner3 = resp3.get("data") or resp3
                    print(f"  Conteúdo: {json.dumps(inner3, ensure_ascii=False)[:600]}")
                except Exception as e3:
                    print(f"  Erro em /notas/{nf_id}/itens: {e3}")

                # Testa /notas-fiscais/{id}
                try:
                    resp4 = tiny_get(f"/notas-fiscais/{nf_id}")
                    print(f"\n  /notas-fiscais/{nf_id} -> chaves: {list(resp4.keys())}")
                    inner4 = resp4.get("data") or resp4
                    print(f"  Conteúdo: {json.dumps(inner4, ensure_ascii=False)[:600]}")
                except Exception as e4:
                    print(f"  Erro em /notas-fiscais/{nf_id}: {e4}")
            break
except Exception as e:
    print(f"  Erro: {e}")
