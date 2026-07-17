"""
scripts/probe_tiny_nf.py
-------------------------
Inspeciona a API Tiny v3 de Notas Fiscais.
Fluxo correto:
  GET /notas/{id}               → lista de itens com idItem
  GET /notas/{id}/itens/{idItem} → detalhe fiscal de cada item

Uso:
    python scripts/probe_tiny_nf.py 059467
    python scripts/probe_tiny_nf.py
"""

import sys, json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from connectors.tiny.client import get as tiny_get

NF_NUMERO = sys.argv[1] if len(sys.argv) > 1 else None

def pp(obj, limit=2000):
    print(json.dumps(obj, ensure_ascii=False, indent=2)[:limit])

# ── 1. Encontrar a NF ───────────────────────────────────────────
found_id = None

if NF_NUMERO:
    print(f"\n[1] Buscando NF numero={NF_NUMERO}...")
    try:
        r = tiny_get("/notas", {"tipo": "E", "numero": int(NF_NUMERO), "limit": 5, "offset": 0})
        itens = r.get("itens") or []
        if itens:
            found_id = itens[0].get("id")
            print(f"  Encontrada via filtro numero=: id={found_id}")
    except Exception as e:
        print(f"  Filtro numero= falhou: {e}")

if not found_id:
    print("\n[1] Listando primeiras NFs de entrada...")
    r0 = tiny_get("/notas", {"tipo": "E", "limit": 3, "offset": 0})
    itens0 = r0.get("itens") or []
    for nf in itens0:
        print(f"  id={nf.get('id')}  numero={nf.get('numero')}  data={nf.get('dataEmissao')}")
    if itens0:
        found_id = itens0[0].get("id")
        print(f"  Usando primeira: id={found_id}")

if not found_id:
    print("Nenhuma NF encontrada. Verifique o token Tiny.")
    sys.exit(1)

# ── 2. Detalhe da NF (inclui itens[] com idItem) ────────────────
print(f"\n[2] GET /notas/{found_id}")
nf_detail = tiny_get(f"/notas/{found_id}")
print("Chaves raiz:", list(nf_detail.keys()))

# Mostra campos fiscais da NF
for campo in ("numero", "tipo", "situacao", "dataEmissao", "valor",
              "valorIcms", "valorIpi", "baseIcms"):
    if campo in nf_detail:
        print(f"  {campo}: {nf_detail[campo]}")

# Itens dentro da NF
itens_nf = nf_detail.get("itens") or []
print(f"\n  itens[]: {len(itens_nf)} item(s)")
for i, item in enumerate(itens_nf[:5]):
    print(f"\n  item[{i}] chaves: {list(item.keys())}")
    pp(item)

# ── 3. Detalhe fiscal de um item específico ─────────────────────
if itens_nf:
    id_item = itens_nf[0].get("idItem") or itens_nf[0].get("id")
    print(f"\n[3] GET /notas/{found_id}/itens/{id_item}")
    try:
        r3 = tiny_get(f"/notas/{found_id}/itens/{id_item}")
        print("Chaves raiz:", list(r3.keys()))
        pp(r3)
    except Exception as e:
        print(f"  Erro: {e}")

    # Tenta também sem o id separado (às vezes o campo tem nome diferente)
    for campo_id in ("id", "idItem", "item_id"):
        v = itens_nf[0].get(campo_id)
        if v and v != id_item:
            print(f"\n  Tentando com {campo_id}={v}...")
            try:
                r3b = tiny_get(f"/notas/{found_id}/itens/{v}")
                pp(r3b)
            except Exception as e:
                print(f"  Erro: {e}")
