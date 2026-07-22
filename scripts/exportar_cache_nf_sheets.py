"""
scripts/exportar_cache_nf_sheets.py
--------------------------------------
Empurra o cache local (cache/nf_custo.json) para a aba "Cache NF" da planilha
Google Sheets (gestao_sheet_id em config.json) — usado quando o Apps Script
não pode rodar (ex: cota diária de UrlFetch estourada).

Uso:
    python scripts/exportar_cache_nf_sheets.py
"""

import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services.custo_service import load_cache, cache_info
from connectors.google_sheets.client import get_worksheet, clear_and_write

with open(ROOT / "config.json") as f:
    _cfg = json.load(f)

SHEET_ID = _cfg.get("gestao_sheet_id", "")
TAB_NAME = "Cache NF"

# Mesma ordem de apps_script/01_Config.gs (HEADERS_CACHE_NF)
HEADERS = [
    "SKU", "Custo Base (R$)", "IPI (R$)", "ICMS Crédito (R$)",
    "PIS Crédito (R$)", "COFINS Crédito (R$)", "NF Número", "NF Data",
    "Atualizado em",
]


def main():
    print("\n" + "=" * 60)
    print("  BouwObra - Push Cache NF -> Google Sheets")
    print("=" * 60)

    if not SHEET_ID:
        print("\n  ERRO: gestao_sheet_id não configurado em config.json")
        return

    info = cache_info()
    if not info["exists"]:
        print("\n  ERRO: cache/nf_custo.json não existe.")
        print("  Execute antes: python scripts/sincronizar_custo.py --desde ... --ate ...")
        return

    cache = load_cache()
    print(f"\n  Cache: {len(cache)} SKUs (versão: {info['version']})")

    atualizado_em = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    rows = []
    for sku in sorted(cache.keys(), key=lambda s: s.lower()):
        d = cache[sku]
        rows.append([
            sku,
            round(d.custo_base, 4),
            round(d.ipi_valor, 4),
            round(d.icms_credito, 4),
            round(d.pis_credito, 4),
            round(d.cofins_credito, 4),
            d.nf_numero,
            d.nf_data,
            atualizado_em,
        ])

    print(f"\n  Escrevendo {len(rows)} linhas na aba '{TAB_NAME}'...")
    ws = get_worksheet(SHEET_ID, TAB_NAME)
    clear_and_write(ws, HEADERS, rows)

    print(f"\n  OK: aba '{TAB_NAME}' atualizada com {len(rows)} SKUs.\n")


if __name__ == "__main__":
    main()
