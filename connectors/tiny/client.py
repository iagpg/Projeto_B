"""
connectors/tiny/client.py
--------------------------
Tiny ERP API v3 — HTTP client com OAuth2 + auto-refresh.
Lê credenciais de config.json, salva token em tiny_token.json.
"""

import json
import time
from pathlib import Path
import requests

_ROOT       = Path(__file__).parent.parent.parent   # d:/backend
_CONFIG     = _ROOT / "config.json"
_TOKEN_FILE = _ROOT / "tiny_token.json"
_BASE       = "https://erp.tiny.com.br/public-api/v3"
_TOKEN_URL  = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token"

with open(_CONFIG) as f:
    _cfg = json.load(f)

_CLIENT_ID     = _cfg["tiny_v3_client_id"]
_CLIENT_SECRET = _cfg["tiny_v3_client_secret"]

_token_data = {}
if _TOKEN_FILE.exists():
    with open(_TOKEN_FILE) as f:
        _token_data = json.load(f)


def _save_token(d: dict) -> None:
    global _token_data
    _token_data = d
    with open(_TOKEN_FILE, "w") as f:
        json.dump(d, f, indent=2)


def _refresh() -> str:
    rt = _token_data.get("refresh_token")
    if not rt:
        raise RuntimeError("No refresh_token. Run connectors/tiny/auth.py to authenticate.")
    r = requests.post(_TOKEN_URL, data={
        "grant_type":    "refresh_token",
        "client_id":     _CLIENT_ID,
        "client_secret": _CLIENT_SECRET,
        "refresh_token": rt,
    }, timeout=15)
    d = r.json()
    if "access_token" not in d:
        raise RuntimeError(
            f"Tiny token refresh failed: {d}\n"
            "Run: python connectors/tiny/auth.py"
        )
    d["_expires_at"] = time.time() + d.get("expires_in", 3600)
    _save_token(d)
    return d["access_token"]


def _access_token() -> str:
    at  = _token_data.get("access_token", "")
    exp = _token_data.get("_expires_at", 0)
    if at and (exp == 0 or time.time() < exp - 60):
        return at
    return _refresh()


_RETRY_DELAYS = (2, 5, 15, 30)  # segundos de espera a cada tentativa de 429


def get(path: str, params: dict | None = None, retry: bool = True):
    token = _access_token()
    for attempt, delay in enumerate((*_RETRY_DELAYS, None)):
        r = requests.get(
            f"{_BASE}{path}",
            headers={"Authorization": f"Bearer {token}"},
            params=params or {},
            timeout=20,
        )
        if r.status_code == 401 and retry:
            token = _refresh()
            retry = False
            continue
        if r.status_code == 429:
            if delay is None:
                r.raise_for_status()
            wait = delay + attempt  # leve backoff adicional
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()  # não alcançado, mas satisfaz o linter


# ── Funções de alto nível ─────────────────────────────────────────────────────

def get_produtos(pesquisa: str | None = None, situacao: str | None = None) -> dict:
    params = {}
    if pesquisa: params["pesquisa"] = pesquisa
    if situacao: params["situacao"] = situacao
    return get("/produtos", params)


def get_produto(produto_id: int | str) -> dict:
    return get(f"/produtos/{produto_id}")


def get_estoque_produto(produto_id: int | str) -> dict:
    return get(f"/produtos/{produto_id}/estoque")
