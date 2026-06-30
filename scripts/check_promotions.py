"""
scripts/check_promotions.py
----------------------------
Lê a aba "Curva B" do Ecommerce.xlsx, verifica cada anúncio no ML e
cria uma nova aba "Análise Promoções" com status das campanhas Junho e Julho.

Campanhas monitoradas:
  C-MLB4305989  "Junho ate Julho"  — expira 01/07/2026  ⚠ URGENTE
  C-MLB4586868  "Julho"            — inicia 01/07/2026, vai até 01/08/2026

Uso:
    python scripts/check_promotions.py
"""

import json
import sys
import time
from pathlib import Path
from datetime import date

import requests
import openpyxl
from openpyxl.styles import PatternFill, Font, Alignment
from openpyxl.utils import get_column_letter

# ── Config ────────────────────────────────────────────────────────────────────

ROOT        = Path(__file__).parent.parent
cfg         = json.load(open(ROOT / "config.json", encoding="utf-8"))
USER_ID     = cfg["ml_user_id"]
EXCEL_PATH  = ROOT / "output" / "Ecommerce.xlsx"
BASE        = "https://api.mercadolibre.com"

CAMP_JUNHO  = "C-MLB4305989"   # Junho ate Julho — expira 01/07
CAMP_JULHO  = "C-MLB4586868"   # Julho           — inicia 01/07

TODAY       = date.today()

_token = cfg.get("ml_access_token", "")


# ── Token ─────────────────────────────────────────────────────────────────────

def _refresh():
    global _token, cfg
    r = requests.post(f"{BASE}/oauth/token", data={
        "grant_type":    "refresh_token",
        "client_id":     cfg["ml_client_id"],
        "client_secret": cfg["ml_client_secret"],
        "refresh_token": cfg["ml_refresh_token"],
    }, timeout=15)
    d = r.json()
    if "access_token" not in d:
        sys.exit(f"Token refresh failed: {d}")
    _token = d["access_token"]
    cfg["ml_access_token"]  = _token
    cfg["ml_refresh_token"] = d.get("refresh_token", cfg["ml_refresh_token"])
    with open(ROOT / "config.json", "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)


def _get(url, params=None, _retry=True):
    h = {"Authorization": f"Bearer {_token}"}
    r = requests.get(url, headers=h, params=params or {}, timeout=15)
    if r.status_code == 401 and _retry:
        _refresh()
        return _get(url, params, _retry=False)
    if r.status_code == 429:
        time.sleep(3)
        return _get(url, params, _retry=_retry)
    if r.status_code in (400, 404):
        return None
    if not r.ok:
        return None
    return r.json()


# ── ML helpers ────────────────────────────────────────────────────────────────

def get_item_details_batch(mlb_ids):
    """Busca título e preço de até 20 itens em uma chamada."""
    if not mlb_ids:
        return {}
    data = _get(f"{BASE}/items", {
        "ids":        ",".join(mlb_ids[:20]),
        "attributes": "id,title,price,status",
    })
    result = {}
    if isinstance(data, list):
        for entry in data:
            body = entry.get("body") if isinstance(entry, dict) else entry
            if body and body.get("id"):
                result[body["id"]] = body
    return result


def get_item_promotions(mlb_id):
    """Retorna lista de promoções do item."""
    data = _get(f"{BASE}/seller-promotions/items/{mlb_id}?app_version=v2")
    return data if isinstance(data, list) else []


def parse_item_ids(raw_val):
    """Extrai IDs válidos de uma célula (pode ter múltiplos separados por espaço)."""
    if raw_val is None:
        return []
    raw = str(raw_val).strip()
    parts = raw.split()
    ids = []
    for p in parts:
        p = p.strip()
        if p.isdigit() and 7 <= len(p) <= 13:
            ids.append(p)
    return ids


def check_campaign(promotions, camp_id):
    """Verifica se o item está ativo em uma campanha específica.
    Retorna (in_campaign: bool, status: str, price: float|None)"""
    for promo in promotions:
        if promo.get("id") == camp_id:
            status = promo.get("status", "")
            price  = promo.get("price") or None
            return True, status, price
    return False, None, None


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    _refresh()
    print("Token refreshed OK")

    # Lê aba Curva B
    wb = openpyxl.load_workbook(EXCEL_PATH)
    ws = wb["Curva B"]
    print(f"Curva B: {ws.max_row - 1} linhas de dados")

    # Coleta todos os IDs únicos
    rows_data = []   # [(row_num, [item_ids])]
    all_ids   = []   # para batch fetch de detalhes

    for row in ws.iter_rows(min_row=2, max_row=ws.max_row, min_col=1, max_col=1):
        cell = row[0]
        ids  = parse_item_ids(cell.value)
        if ids:
            rows_data.append((cell.row, ids))
            all_ids.extend(ids)

    all_ids_unique = list(dict.fromkeys(all_ids))
    print(f"IDs únicos encontrados: {len(all_ids_unique)}")

    # Batch fetch de detalhes (título/preço) em grupos de 20
    details_cache = {}
    mlb_ids_full = [f"MLB{i}" for i in all_ids_unique]
    for i in range(0, len(mlb_ids_full), 20):
        chunk = mlb_ids_full[i:i+20]
        batch = get_item_details_batch(chunk)
        details_cache.update(batch)
        time.sleep(0.2)
    print(f"Detalhes obtidos: {len(details_cache)}")

    # Processa promoções por item
    promotions_cache = {}
    for idx, mlb_id in enumerate(mlb_ids_full):
        print(f"  [{idx+1}/{len(mlb_ids_full)}] {mlb_id} ...", end=" ", flush=True)
        promos = get_item_promotions(mlb_id)
        promotions_cache[mlb_id] = promos
        in_j, _, _ = check_campaign(promos, CAMP_JUNHO)
        in_jul, _, _ = check_campaign(promos, CAMP_JULHO)
        flags = []
        if in_j:   flags.append("JUNHO")
        if in_jul: flags.append("JULHO")
        print(", ".join(flags) if flags else "sem campanha")
        time.sleep(0.2)

    # ── Cria nova aba ─────────────────────────────────────────────────────────

    TAB_NAME = "Analise Promocoes"
    if TAB_NAME in wb.sheetnames:
        del wb[TAB_NAME]
    ws_out = wb.create_sheet(TAB_NAME)

    # Cores
    HEADER_FILL   = PatternFill("solid", fgColor="1F3864")
    RED_FILL      = PatternFill("solid", fgColor="FF4444")
    ORANGE_FILL   = PatternFill("solid", fgColor="FFB347")
    GREEN_FILL    = PatternFill("solid", fgColor="92D050")
    YELLOW_FILL   = PatternFill("solid", fgColor="FFFF99")
    GRAY_FILL     = PatternFill("solid", fgColor="D9D9D9")
    WHITE_FILL    = PatternFill("solid", fgColor="FFFFFF")

    # Headers
    headers = [
        "MLB ID",
        "Título",
        "Preço Atual (R$)",
        "Status ML",
        "Camp. Junho\n(expira 01/07 ⚠)",
        "Camp. Julho\n(01/07 a 01/08)",
        "Alerta",
    ]

    for col, h in enumerate(headers, 1):
        cell = ws_out.cell(row=1, column=col, value=h)
        cell.fill = HEADER_FILL
        cell.font = Font(bold=True, color="FFFFFF", size=10)
        cell.alignment = Alignment(wrap_text=True, vertical="center", horizontal="center")

    ws_out.row_dimensions[1].height = 36

    # Larguras de coluna
    col_widths = [16, 52, 16, 12, 20, 20, 40]
    for col, w in enumerate(col_widths, 1):
        ws_out.column_dimensions[get_column_letter(col)].width = w

    # Preenche linhas
    out_row = 2
    seen_ids = set()

    for row_num, item_ids in rows_data:
        for raw_id in item_ids:
            mlb_id = f"MLB{raw_id}"
            if mlb_id in seen_ids:
                continue
            seen_ids.add(mlb_id)

            detail = details_cache.get(mlb_id, {})
            title  = detail.get("title", "— não encontrado —")
            price  = detail.get("price")
            status_ml = detail.get("status", "—")

            promos = promotions_cache.get(mlb_id, [])
            in_junho, junho_status, junho_price = check_campaign(promos, CAMP_JUNHO)
            in_julho, julho_status, julho_price = check_campaign(promos, CAMP_JULHO)

            # Texto das células de campanha
            def camp_text(in_camp, camp_status, camp_price):
                if not in_camp:
                    return "Fora"
                if camp_status == "started":
                    return f"Ativa (R$ {camp_price:.2f})" if camp_price else "Ativa"
                if camp_status == "pending":
                    return f"Inscrito (R$ {camp_price:.2f})" if camp_price else "Inscrito"
                if camp_status == "candidate":
                    return "Candidato"
                return camp_status or "—"

            junho_text = camp_text(in_junho, junho_status, junho_price)
            julho_text = camp_text(in_julho, julho_status, julho_price)

            # Alerta
            alertas = []
            if in_junho and junho_status == "started":
                alertas.append("⚠ EXPIRA AMANHA! Sair da campanha Junho")
            if not in_julho:
                alertas.append("Fora da campanha Julho — verificar")
            elif julho_status == "candidate":
                alertas.append("Candidato ao Julho — confirmar inscrição")
            alerta_text = " | ".join(alertas) if alertas else "OK"

            # Fills
            if in_junho and junho_status == "started":
                junho_fill = ORANGE_FILL
            elif in_junho:
                junho_fill = YELLOW_FILL
            else:
                junho_fill = GRAY_FILL

            if in_julho and julho_status in ("started", "pending"):
                julho_fill = GREEN_FILL
            elif in_julho and julho_status == "candidate":
                julho_fill = YELLOW_FILL
            else:
                julho_fill = RED_FILL

            row_fill = RED_FILL if alertas and "EXPIRA" in alertas[0] else WHITE_FILL

            # Escreve linha
            values = [mlb_id, title, price, status_ml, junho_text, julho_text, alerta_text]
            for col, val in enumerate(values, 1):
                c = ws_out.cell(row=out_row, column=col, value=val)
                c.alignment = Alignment(vertical="center", wrap_text=(col in (2, 7)))
                if col == 1:
                    c.font = Font(bold=True)
                if col == 5:
                    c.fill = junho_fill
                elif col == 6:
                    c.fill = julho_fill
                elif col == 7:
                    if "EXPIRA" in alerta_text:
                        c.fill = ORANGE_FILL
                        c.font = Font(bold=True, color="880000")
                    elif "Fora" in alerta_text:
                        c.fill = RED_FILL
                        c.font = Font(color="880000")
                    else:
                        c.fill = GREEN_FILL

            out_row += 1

    # Congela header e adiciona filtro
    ws_out.freeze_panes = "A2"
    ws_out.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{out_row - 1}"

    wb.save(EXCEL_PATH)
    print(f"\nAba '{TAB_NAME}' criada com {out_row - 2} linhas.")
    print(f"Arquivo salvo: {EXCEL_PATH}")

    # Resumo
    total   = out_row - 2
    exp     = sum(1 for r in promotions_cache.values()
                  if any(p.get("id") == CAMP_JUNHO and p.get("status") == "started" for p in r))
    fora_j  = sum(1 for r in promotions_cache.values()
                  if not any(p.get("id") == CAMP_JULHO for p in r))

    print(f"\n{'='*50}")
    print(f"  Total anuncios analisados : {total}")
    print(f"  Ativos na campanha Junho  : {exp}  *** EXPIRAM AMANHA ***")
    print(f"  Fora da campanha Julho    : {fora_j}")
    print(f"{'='*50}")


if __name__ == "__main__":
    main()
