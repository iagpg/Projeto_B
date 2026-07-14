"""
scripts/probe_tiny_nf.py
--------------------------
Diagnóstico da API Tiny v3 para Notas Fiscais.
Exibe a estrutura bruta da resposta para verificar nomes de campos
antes de rodar o pipeline completo.

Uso:
    python scripts/probe_tiny_nf.py
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from connectors.tiny.client import get as tiny_get


def probe():
    print("\n" + "=" * 60)
    print("  Tiny NF — Diagnóstico de Endpoints")
    print("=" * 60)

    # 1. Listar NFs de entrada (página 1, limite 3)
    print("\n[1] GET /notas-fiscais?tipo=E&situacao=A&limite=3")
    print("─" * 50)
    try:
        resp = tiny_get("/notas-fiscais", {
            "tipo":     "E",
            "situacao": "A",
            "limite":   3,
            "pagina":   1,
        })
        print(json.dumps(resp, indent=2, ensure_ascii=False)[:3000])
    except Exception as e:
        print(f"  ERRO: {e}")
        resp = {}

    # Extrair ID da primeira NF para buscar detalhes
    nf_id = None
    inner = resp.get("data") or resp
    for key in ("itens", "notas", "items", "results"):
        lst = inner.get(key, [])
        if lst and isinstance(lst, list):
            first = lst[0]
            nf_id = first.get("id")
            print(f"\n  → Primeira NF encontrada: id={nf_id}, campos disponíveis: {list(first.keys())}")
            break

    if not nf_id:
        print("\n  Nenhuma NF de entrada encontrada no período.")
        print("  Tente ajustar os filtros ou verificar se há NFs de entrada no Tiny.")
        return

    # 2. Detalhe da NF
    print(f"\n[2] GET /notas-fiscais/{nf_id}")
    print("─" * 50)
    try:
        detail = tiny_get(f"/notas-fiscais/{nf_id}")
        print(json.dumps(detail, indent=2, ensure_ascii=False)[:4000])
    except Exception as e:
        print(f"  ERRO: {e}")
        detail = {}

    # Analisar estrutura dos itens
    inner2 = detail.get("data") or detail
    nota   = inner2.get("nota") or inner2
    items  = None
    for key in ("itens", "items", "produtos", "products"):
        v = nota.get(key)
        if isinstance(v, list) and v:
            items = v
            print(f"\n  → Itens da NF estão em chave: '{key}'")
            print(f"  → Primeiro item, campos disponíveis: {list(items[0].keys())}")
            print(f"\n  Detalhe do primeiro item:")
            print(json.dumps(items[0], indent=2, ensure_ascii=False))
            break

    if not items:
        print("\n  Itens não encontrados. Verifique a estrutura acima.")

    print("\n" + "=" * 60)
    print("  Use as informações acima para verificar se")
    print("  connectors/tiny/nf.py está lendo os campos corretos.")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    probe()
