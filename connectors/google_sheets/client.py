"""
connectors/google_sheets/client.py
------------------------------------
Wrapper sobre gspread para leitura e escrita na planilha Google Sheets.
Gerencia auto-refresh do token OAuth2.

Uso:
    from connectors.google_sheets.client import get_worksheet, clear_and_write

    ws = get_worksheet(sheet_id, "Precificação")
    clear_and_write(ws, headers, rows, margin_col_index=18)
"""

import json
import time
from pathlib import Path
from datetime import datetime, timezone

import gspread
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request

_ROOT       = Path(__file__).parent.parent.parent
_CONFIG     = _ROOT / "config.json"
_TOKEN_FILE = _ROOT / "google_token.json"

with open(_CONFIG) as _f:
    _cfg = json.load(_f)


# ── Credenciais ───────────────────────────────────────────────────────────────

def _save_token(creds: Credentials) -> None:
    token_data = {
        "access_token":  creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri":     creds.token_uri,
        "client_id":     creds.client_id,
        "client_secret": creds.client_secret,
        "scopes":        list(creds.scopes or []),
        "_expires_at":   time.time() + 3600,
    }
    with open(_TOKEN_FILE, "w") as f:
        json.dump(token_data, f, indent=2)


def _load_credentials() -> Credentials:
    if not _TOKEN_FILE.exists():
        raise FileNotFoundError(
            f"Token Google não encontrado: {_TOKEN_FILE}\n"
            "Execute: python connectors/google_sheets/auth.py"
        )
    with open(_TOKEN_FILE) as f:
        d = json.load(f)

    creds = Credentials(
        token=d["access_token"],
        refresh_token=d.get("refresh_token"),
        token_uri=d.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=d.get("client_id", _cfg.get("google_client_id")),
        client_secret=d.get("client_secret", _cfg.get("google_client_secret")),
        scopes=d.get("scopes", ["https://www.googleapis.com/auth/spreadsheets"]),
    )

    expires_at = d.get("_expires_at", 0)
    if time.time() >= expires_at - 60:
        creds.refresh(Request())
        _save_token(creds)

    return creds


def get_client() -> gspread.Client:
    return gspread.authorize(_load_credentials())


def get_worksheet(sheet_id: str, tab_name: str) -> gspread.Worksheet:
    gc = get_client()
    sh = gc.open_by_key(sheet_id)
    try:
        return sh.worksheet(tab_name)
    except gspread.exceptions.WorksheetNotFound:
        return sh.add_worksheet(title=tab_name, rows=1000, cols=30)


# ── Formatação ────────────────────────────────────────────────────────────────

_MARGIN_GREEN  = {"red": 0.851, "green": 0.918, "blue": 0.827}
_MARGIN_YELLOW = {"red": 1.0,   "green": 0.949, "blue": 0.8}
_MARGIN_RED    = {"red": 0.957, "green": 0.851, "blue": 0.851}
_HEADER_BG     = {"red": 0.133, "green": 0.133, "blue": 0.133}
_WHITE         = {"red": 1.0,   "green": 1.0,   "blue": 1.0}


def _margin_color(pct):
    try:
        v = float(pct)
    except (TypeError, ValueError):
        return _MARGIN_RED
    if v >= 20:
        return _MARGIN_GREEN
    if v >= 10:
        return _MARGIN_YELLOW
    return _MARGIN_RED


def _col_letter(n: int) -> str:
    """1 → A, 26 → Z, 27 → AA"""
    result = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        result = chr(65 + r) + result
    return result


def _build_format_requests(ws, headers, data_rows, margin_col_index: int) -> list:
    sheet_id = ws.id
    n_cols   = len(headers)
    requests  = []

    # Header: escuro com texto branco e negrito
    requests.append({
        "repeatCell": {
            "range": {
                "sheetId":          sheet_id,
                "startRowIndex":    0,
                "endRowIndex":      1,
                "startColumnIndex": 0,
                "endColumnIndex":   n_cols,
            },
            "cell": {
                "userEnteredFormat": {
                    "backgroundColor": _HEADER_BG,
                    "textFormat":      {"bold": True, "foregroundColor": _WHITE},
                    "verticalAlignment": "MIDDLE",
                }
            },
            "fields": "userEnteredFormat(backgroundColor,textFormat,verticalAlignment)",
        }
    })

    # Congelar linha do cabeçalho
    requests.append({
        "updateSheetProperties": {
            "properties": {
                "sheetId": sheet_id,
                "gridProperties": {"frozenRowCount": 1}
            },
            "fields": "gridProperties.frozenRowCount"
        }
    })

    # Cores por linha baseadas na margem
    for i, row in enumerate(data_rows, start=1):
        try:
            pct = row[margin_col_index] if margin_col_index < len(row) else None
            color = _margin_color(pct)
        except Exception:
            color = _MARGIN_RED

        requests.append({
            "repeatCell": {
                "range": {
                    "sheetId":          sheet_id,
                    "startRowIndex":    i,
                    "endRowIndex":      i + 1,
                    "startColumnIndex": 0,
                    "endColumnIndex":   n_cols,
                },
                "cell": {
                    "userEnteredFormat": {"backgroundColor": color}
                },
                "fields": "userEnteredFormat.backgroundColor",
            }
        })

    return requests


# ── Escrita principal ─────────────────────────────────────────────────────────

def clear_and_write(
    ws: gspread.Worksheet,
    headers: list,
    rows: list,
    margin_col_index: int = -1,
) -> None:
    """Limpa a aba, escreve cabeçalho + linhas e aplica formatação."""
    ws.clear()

    all_data = [headers] + rows
    ws.update(
        range_name=f"A1:{_col_letter(len(headers))}{len(all_data)}",
        values=all_data,
        value_input_option="USER_ENTERED",
    )

    if margin_col_index >= 0:
        fmt_requests = _build_format_requests(ws, headers, rows, margin_col_index)
        if fmt_requests:
            ws.spreadsheet.batch_update({"requests": fmt_requests})


def write_dashboard(ws: gspread.Worksheet, kpis: list[dict]) -> None:
    """
    Escreve KPIs no Dashboard.
    kpis: lista de {"label": str, "value": any, "format": "currency"|"number"|"percent"|"text"}
    """
    ws.clear()

    # Cabeçalho da tabela de KPIs
    ws.update("A1:B1", [["Indicador", "Valor"]], value_input_option="USER_ENTERED")

    rows = [[kpi["label"], kpi["value"]] for kpi in kpis]
    if rows:
        ws.update(
            range_name=f"A2:B{1 + len(rows)}",
            values=rows,
            value_input_option="USER_ENTERED",
        )

    # Formatar cabeçalho
    sheet_id = ws.id
    ws.spreadsheet.batch_update({"requests": [
        {
            "repeatCell": {
                "range": {
                    "sheetId":          sheet_id,
                    "startRowIndex":    0,
                    "endRowIndex":      1,
                    "startColumnIndex": 0,
                    "endColumnIndex":   2,
                },
                "cell": {
                    "userEnteredFormat": {
                        "backgroundColor": _HEADER_BG,
                        "textFormat":      {"bold": True, "foregroundColor": _WHITE},
                    }
                },
                "fields": "userEnteredFormat(backgroundColor,textFormat)",
            }
        },
        {
            "updateSheetProperties": {
                "properties": {
                    "sheetId": sheet_id,
                    "gridProperties": {"frozenRowCount": 1}
                },
                "fields": "gridProperties.frozenRowCount"
            }
        },
    ]})
