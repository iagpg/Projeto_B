"""
connectors/google_sheets/auth.py
----------------------------------
Autorização inicial Google Sheets. Roda uma vez para obter o token.

Pré-requisitos:
  1. Acessar console.cloud.google.com
  2. Habilitar Google Sheets API
  3. Criar credenciais OAuth2 (tipo: Desktop app)
  4. Copiar client_id e client_secret para config.json

Uso:
    python connectors/google_sheets/auth.py
"""

import json
import time
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs
import requests

_ROOT       = Path(__file__).parent.parent.parent   # d:/backend
_CONFIG     = _ROOT / "config.json"
_TOKEN_FILE = _ROOT / "google_token.json"
_REDIRECT   = "http://localhost:8080/callback"
_AUTH_URL   = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN_URL  = "https://oauth2.googleapis.com/token"
_SCOPES     = "https://www.googleapis.com/auth/spreadsheets"

with open(_CONFIG) as f:
    cfg = json.load(f)

CLIENT_ID     = cfg.get("google_client_id", "")
CLIENT_SECRET = cfg.get("google_client_secret", "")

_captured_code = None


class _CallbackHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        global _captured_code
        params = parse_qs(urlparse(self.path).query)
        code = params.get("code", [None])[0]
        if code:
            _captured_code = code
            body = b"<h2>Autorizado! Pode fechar esta aba.</h2>"
            self.send_response(200)
        else:
            body = b"<h2>Erro: code nao encontrado na URL.</h2>"
            self.send_response(400)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def _wait_for_code(timeout: int = 120) -> None:
    server = HTTPServer(("localhost", 8080), _CallbackHandler)
    server.timeout = 1
    import time as _t
    deadline = _t.time() + timeout
    while _t.time() < deadline and _captured_code is None:
        server.handle_request()
    server.server_close()


def main():
    global _captured_code

    if not CLIENT_ID or not CLIENT_SECRET:
        print("\n  ERRO: google_client_id e google_client_secret nao configurados em config.json")
        print("\n  Passos:")
        print("  1. Acesse console.cloud.google.com")
        print("  2. Crie um projeto e habilite 'Google Sheets API'")
        print("  3. Crie credenciais OAuth2 (tipo Desktop app)")
        print("  4. Copie client_id e client_secret para config.json")
        return

    auth_url = _AUTH_URL + "?" + urlencode({
        "client_id":     CLIENT_ID,
        "redirect_uri":  _REDIRECT,
        "response_type": "code",
        "scope":         _SCOPES,
        "access_type":   "offline",
        "prompt":        "consent",
    })

    print("\n" + "=" * 60)
    print("  BOUW.OBRA — Autorização Google Sheets")
    print("=" * 60)
    print("\n  Abrindo navegador para autorização Google...")
    print("  Faça login com a conta que tem acesso ao Google Sheets.")
    print("  O code será capturado automaticamente.\n")

    t = threading.Thread(target=_wait_for_code, args=(120,), daemon=True)
    t.start()
    webbrowser.open(auth_url)

    print("  Aguardando callback (até 120s)...")
    t.join(timeout=125)

    if not _captured_code:
        print("\n  Timeout: code não recebido.")
        print("  Abra manualmente e cole o code:")
        print(f"\n  {auth_url}\n")
        _captured_code = input("  Cole o code aqui: ").strip()
        if not _captured_code:
            print("  Nenhum code informado. Abortando.")
            return

    print("\n  Code recebido. Trocando por token...")
    r = requests.post(_TOKEN_URL, data={
        "grant_type":    "authorization_code",
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code":          _captured_code,
        "redirect_uri":  _REDIRECT,
    }, timeout=15)

    d = r.json()
    if "access_token" not in d:
        print(f"\n  Erro: {d}")
        return

    token_data = {
        "access_token":  d["access_token"],
        "refresh_token": d.get("refresh_token", ""),
        "token_uri":     _TOKEN_URL,
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scopes":        [_SCOPES],
        "expires_in":    d.get("expires_in", 3600),
        "_expires_at":   time.time() + d.get("expires_in", 3600),
    }

    with open(_TOKEN_FILE, "w") as f:
        json.dump(token_data, f, indent=2)

    print(f"\n  Token salvo em: {_TOKEN_FILE}")
    print("  Testando acesso ao Google Sheets...")

    headers = {"Authorization": f"Bearer {d['access_token']}"}
    sheet_id = cfg.get("gestao_sheet_id", "")
    if sheet_id:
        r2 = requests.get(
            f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}",
            headers=headers,
            timeout=10,
        )
        if r2.status_code == 200:
            title = r2.json().get("properties", {}).get("title", "")
            print(f"  Planilha acessível: \"{title}\"")
        else:
            print(f"  Aviso: HTTP {r2.status_code} — verifique gestao_sheet_id em config.json")
    else:
        print("  OK — configure gestao_sheet_id em config.json para testar acesso à planilha.")


if __name__ == "__main__":
    main()
