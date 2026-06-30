"""
tiny_auth_setup.py
------------------
Autorização inicial Tiny ERP v3 (roda só uma vez, ou quando o token expirar).

Uso:
    python tiny_auth_setup.py
"""

import json
import time
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs
import requests

_DIR        = Path(__file__).parent.parent
_CONFIG     = _DIR / "config.json"
_TOKEN_FILE = _DIR / "tiny_token.json"
_TOKEN_URL  = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token"
_AUTH_URL   = "https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth"
_REDIRECT   = "http://localhost:8080/callback"

with open(_CONFIG) as f:
    cfg = json.load(f)

CLIENT_ID     = cfg["tiny_v3_client_id"]
CLIENT_SECRET = cfg["tiny_v3_client_secret"]

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
        pass  # silencia logs do servidor


def _wait_for_code(timeout=120):
    server = HTTPServer(("localhost", 8080), _CallbackHandler)
    server.timeout = 1
    deadline = time.time() + timeout
    while time.time() < deadline and _captured_code is None:
        server.handle_request()
    server.server_close()


def main():
    global _captured_code

    auth_url = _AUTH_URL + "?" + urlencode({
        "client_id":     CLIENT_ID,
        "redirect_uri":  _REDIRECT,
        "response_type": "code",
        "scope":         "openid",
    })

    print("\n" + "=" * 60)
    print("  BOUW.OBRA — Autorização Tiny ERP v3")
    print("=" * 60)
    print("\n  Abrindo navegador para autorização...")
    print("  Faça login no Tiny e autorize o app.")
    print("  O code será capturado automaticamente.\n")

    # Sobe servidor local em thread separada
    t = threading.Thread(target=_wait_for_code, args=(120,), daemon=True)
    t.start()

    webbrowser.open(auth_url)

    print("  Aguardando callback (até 120s)...")
    t.join(timeout=125)

    if not _captured_code:
        print("\n  Timeout ou erro: code não recebido.")
        print("  Abra manualmente a URL abaixo e cole o code:")
        print(f"\n  {auth_url}\n")
        _captured_code = input("  Cole o code aqui: ").strip()
        if not _captured_code:
            print("  Nenhum code informado. Abortando.")
            return

    print(f"\n  Code recebido. Trocando por token...")
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

    d["_expires_at"] = time.time() + d.get("expires_in", 3600)

    with open(_TOKEN_FILE, "w") as f:
        json.dump(d, f, indent=2)

    print(f"\n  Token salvo em: {_TOKEN_FILE}")
    print("  Testando conexão...")

    token = d["access_token"]
    r2 = requests.get(
        "https://erp.tiny.com.br/public-api/v3/produtos",
        headers={"Authorization": f"Bearer {token}"},
        params={"limite": 1},
        timeout=10,
    )
    if r2.status_code == 200:
        print("  Conexão OK! Pronto para rodar validate_skus.py")
    else:
        print(f"  Aviso: teste retornou HTTP {r2.status_code} — {r2.text[:200]}")


if __name__ == "__main__":
    main()
