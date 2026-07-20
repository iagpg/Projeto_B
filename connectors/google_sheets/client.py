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
_UNCERTAIN_ORANGE = {"red": 1.0, "green": 0.6,   "blue": 0.0}  # valor estimado/nao confirmado por API
_CREDITO_VERDE    = _MARGIN_GREEN  # valores que entram/beneficiam a margem (créditos, bônus)
_DEBITO_VERMELHO  = _MARGIN_RED    # valores que saem/reduzem a margem (encargos, custo)

# Status Anúncio — mesma paleta de scripts/validate_skus.py (Verde/Cinza/Vermelho/Azul)
_STATUS_CINZA = {"red": 0.886, "green": 0.890, "blue": 0.898}
_STATUS_AZUL  = {"red": 0.800, "green": 0.894, "blue": 1.0}
_STATUS_COLORS = {
    "Ativo":   _MARGIN_GREEN,
    "Pausado": _STATUS_CINZA,
    "Fechado": _MARGIN_RED,
    "Migrado": _STATUS_AZUL,
}


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


def _cell_request(sheet_id, start_row: int, end_row: int, start_col: int, end_col: int, color: dict) -> dict:
    """repeatCell request para um retângulo de células (índices 0-based, end exclusivo)."""
    return {
        "repeatCell": {
            "range": {
                "sheetId":          sheet_id,
                "startRowIndex":    start_row,
                "endRowIndex":      end_row,
                "startColumnIndex": start_col,
                "endColumnIndex":   end_col,
            },
            "cell": {"userEnteredFormat": {"backgroundColor": color}},
            "fields": "userEnteredFormat.backgroundColor",
        }
    }


def _reset_format_request(sheet_id, start_row: int, end_row: int, start_col: int, end_col: int) -> dict:
    """Reseta TODA a formatação (cor, numberFormat, etc.) de um retângulo para o padrão.

    ws.clear() só limpa valores, não formatação — sem isso, um numberFormat de
    data/moeda de uma sincronização anterior (com outro layout de colunas) fica
    preso na célula e distorce a exibição de um valor numérico novo (ex: 12.73
    sendo lido como data-serial em vez de percentual).
    """
    return {
        "repeatCell": {
            "range": {
                "sheetId":          sheet_id,
                "startRowIndex":    start_row,
                "endRowIndex":      end_row,
                "startColumnIndex": start_col,
                "endColumnIndex":   end_col,
            },
            "cell": {"userEnteredFormat": {"backgroundColor": _WHITE}},
            "fields": "userEnteredFormat",
        }
    }


def _data_validation_request(sheet_id, start_row: int, end_row: int, col: int, options: list) -> dict:
    """Dropdown (menu suspenso) restrito a uma lista de valores para uma coluna inteira."""
    return {
        "setDataValidation": {
            "range": {
                "sheetId":          sheet_id,
                "startRowIndex":    start_row,
                "endRowIndex":      end_row,
                "startColumnIndex": col,
                "endColumnIndex":   col + 1,
            },
            "rule": {
                "condition": {
                    "type":   "ONE_OF_LIST",
                    "values": [{"userEnteredValue": v} for v in options],
                },
                "showCustomUi": True,
                "strict": True,
            },
        }
    }


def _build_format_requests(ws, headers, data_rows, margin_col_index: int,
                            uncertain_cols_per_row: list | None = None,
                            credito_cols: list | None = None,
                            debito_cols: list | None = None,
                            margem_cols: list | None = None,
                            status_col_index: int | None = None,
                            status_options: list | None = None) -> list:
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

    # Reseta TODA a formatação da área de dados (até o fim da aba) antes de
    # recolorir — ws.clear() só limpa valores, não formatação, então sem isso
    # cores/numberFormat de uma sincronização anterior (mais linhas ou colunas,
    # layout diferente) ficariam presos.
    requests.append(_reset_format_request(
        sheet_id, 1, max(ws.row_count, 1 + len(data_rows)), 0, max(ws.col_count, n_cols),
    ))

    for i, row in enumerate(data_rows, start=1):
        # Crédito (verde claro) e débito (vermelho claro), célula a célula
        for col in (credito_cols or []):
            requests.append(_cell_request(sheet_id, i, i + 1, col, col + 1, _CREDITO_VERDE))
        for col in (debito_cols or []):
            requests.append(_cell_request(sheet_id, i, i + 1, col, col + 1, _DEBITO_VERMELHO))

        # Margem (R$ e %) colorida pela faixa de desempenho
        if margem_cols:
            try:
                pct = row[margin_col_index] if margin_col_index < len(row) else None
                color = _margin_color(pct)
            except Exception:
                color = _MARGIN_RED
            for col in margem_cols:
                requests.append(_cell_request(sheet_id, i, i + 1, col, col + 1, color))

        # Status Anúncio — cor fixa por valor (Ativo=verde, Pausado=cinza, Fechado=vermelho, Migrado=azul)
        if status_col_index is not None:
            status_val = row[status_col_index] if status_col_index < len(row) else None
            color = _STATUS_COLORS.get(status_val)
            if color:
                requests.append(_cell_request(sheet_id, i, i + 1, status_col_index, status_col_index + 1, color))

    # Laranja por cima, nas células com valor incerto/estimado (aplicado depois → tem prioridade)
    if uncertain_cols_per_row:
        for i, cols in enumerate(uncertain_cols_per_row, start=1):
            for col in cols or []:
                requests.append(_cell_request(sheet_id, i, i + 1, col, col + 1, _UNCERTAIN_ORANGE))

    # Dropdown (menu suspenso) na coluna de status
    if status_col_index is not None and status_options and data_rows:
        requests.append(_data_validation_request(sheet_id, 1, 1 + len(data_rows), status_col_index, status_options))

    return requests


# ── Escrita principal ─────────────────────────────────────────────────────────

def clear_and_write(
    ws: gspread.Worksheet,
    headers: list,
    rows: list,
    margin_col_index: int = -1,
    uncertain_cols_per_row: list | None = None,
    credito_cols: list | None = None,
    debito_cols: list | None = None,
    margem_cols: list | None = None,
    status_col_index: int | None = None,
    status_options: list | None = None,
) -> None:
    """Limpa a aba, escreve cabeçalho + linhas e aplica formatação.

    uncertain_cols_per_row (opcional): lista paralela a `rows`, cada item é a lista
        de índices de coluna com valor estimado/não confirmado (marcados em laranja).
    credito_cols/debito_cols (opcional): índices de coluna sempre verde claro / vermelho
        claro (créditos fiscais e bônus vs. encargos e custo), independente da margem.
    margem_cols (opcional): índices de coluna coloridos pela faixa de margem (R$ e %).
    status_col_index/status_options (opcional): coluna com dropdown (menu suspenso)
        restrito a status_options, colorida por valor (ver _STATUS_COLORS).
    """
    ws.clear()

    all_data = [headers] + rows
    ws.update(
        range_name=f"A1:{_col_letter(len(headers))}{len(all_data)}",
        values=all_data,
        value_input_option="RAW",
    )

    fmt_requests = _build_format_requests(
        ws, headers, rows, margin_col_index, uncertain_cols_per_row,
        credito_cols, debito_cols, margem_cols, status_col_index, status_options,
    )
    if fmt_requests:
        ws.spreadsheet.batch_update({"requests": fmt_requests})


def append_row_formatted(
    ws: gspread.Worksheet,
    headers: list,
    row: list,
    margin_col_index: int = -1,
    uncertain_cols: list | None = None,
    credito_cols: list | None = None,
    debito_cols: list | None = None,
    margem_cols: list | None = None,
    status_col_index: int | None = None,
    status_options: list | None = None,
) -> int:
    """Adiciona uma única linha ao final da aba (sem apagar as demais) e formata:
    crédito/débito por célula, margem por faixa, laranja nas células incertas,
    dropdown + cor na coluna de status.

    Retorna o número da linha (1-based) onde os dados foram escritos.
    """
    ws.append_row(row, value_input_option="RAW")
    row_idx  = len(ws.get_all_values())
    sheet_id = ws.id
    r0, r1   = row_idx - 1, row_idx  # índices 0-based da linha recém-adicionada
    n_cols   = len(headers)

    requests = [_reset_format_request(sheet_id, r0, r1, 0, n_cols)]  # reseta antes de recolorir
    for col in (credito_cols or []):
        requests.append(_cell_request(sheet_id, r0, r1, col, col + 1, _CREDITO_VERDE))
    for col in (debito_cols or []):
        requests.append(_cell_request(sheet_id, r0, r1, col, col + 1, _DEBITO_VERMELHO))
    if margem_cols:
        try:
            pct = row[margin_col_index] if margin_col_index < len(row) else None
            color = _margin_color(pct)
        except Exception:
            color = _MARGIN_RED
        for col in margem_cols:
            requests.append(_cell_request(sheet_id, r0, r1, col, col + 1, color))
    for col in (uncertain_cols or []):
        requests.append(_cell_request(sheet_id, r0, r1, col, col + 1, _UNCERTAIN_ORANGE))

    if status_col_index is not None:
        status_val = row[status_col_index] if status_col_index < len(row) else None
        color = _STATUS_COLORS.get(status_val)
        if color:
            requests.append(_cell_request(sheet_id, r0, r1, status_col_index, status_col_index + 1, color))
        if status_options:
            requests.append(_data_validation_request(sheet_id, r0, r1, status_col_index, status_options))

    if requests:
        ws.spreadsheet.batch_update({"requests": requests})

    return row_idx


def write_dashboard(ws: gspread.Worksheet, kpis: list[dict]) -> None:
    """
    Escreve KPIs no Dashboard.
    kpis: lista de {"label": str, "value": any, "format": "currency"|"number"|"percent"|"text"}
    """
    ws.clear()

    # Cabeçalho da tabela de KPIs
    ws.update("A1:B1", [["Indicador", "Valor"]], value_input_option="RAW")

    rows = [[kpi["label"], kpi["value"]] for kpi in kpis]
    if rows:
        ws.update(
            range_name=f"A2:B{1 + len(rows)}",
            values=rows,
            value_input_option="RAW",
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
