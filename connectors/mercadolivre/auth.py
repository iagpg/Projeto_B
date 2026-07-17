"""
connectors/mercadolivre/auth.py
--------------------------------
Autorização OAuth2 Mercado Livre com PKCE. Roda após habilitar novo escopo no app.

Uso:
    python connectors/mercadolivre/auth.py
"""

import base64
import hashlib
import json
import os
import webbrowser
from pathlib import Path
from urllib.parse import urlencode
import requests

_ROOT      = Path(__file__).parent.parent.parent   # d:/backend
_CONFIG    = _ROOT / "config.json"
_AUTH_URL  = "https://auth.mercadolivre.com.br/authorization"
_TOKEN_URL = "https://api.mercadolibre.com/oauth/token"
_REDIRECT  = "https://bouwobraequipamentos.com.br/"

with open(_CONFIG) as f:
    cfg = json.load(f)

CLIENT_ID     = cfg["ml_client_id"]
CLIENT_SECRET = cfg["ml_client_secret"]


def _pkce_pair():
    verifier  = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()
    ).rstrip(b"=").decode()
    return verifier, challenge


def main():
    code_verifier, code_challenge = _pkce_pair()

    auth_url = _AUTH_URL + "?" + urlencode({
        "response_type":         "code",
        "client_id":             CLIENT_ID,
        "redirect_uri":          _REDIRECT,
        "code_challenge":        code_challenge,
        "code_challenge_method": "S256",
        "scope":                 "read:orders offline_access",
    })

    print("\n" + "=" * 60)
    print("  BOUW.OBRA — Autorizacao Mercado Livre (PKCE)")
    print("=" * 60)
    print("\n  1. Abrindo navegador para autorizacao...")
    print("  2. Faca login no ML e autorize o app.")
    print("  3. O site vai abrir. Copie o 'code' da URL do navegador.")
    print("     Exemplo de URL apos autorizar:")
    print("     https://bouwobraequipamentos.com.br/?code=TG-XXXXX&state=...")
    print(f"\n  Se o browser nao abrir, acesse:\n  {auth_url}\n")

    webbrowser.open(auth_url)

    code = input("  Cole o code aqui: ").strip()
    if not code:
        print("  Nenhum code informado. Abortando.")
        return

    print("\n  Trocando code por token...")
    r = requests.post(_TOKEN_URL, data={
        "grant_type":    "authorization_code",
        "client_id":     CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code":          code,
        "redirect_uri":  _REDIRECT,
        "code_verifier": code_verifier,
    }, timeout=15)

    d = r.json()
    if "access_token" not in d:
        print(f"\n  Erro ao obter token: {d}")
        return

    access_token  = d["access_token"]
    refresh_token = d.get("refresh_token", "")

    cfg["ml_access_token"]  = access_token
    cfg["ml_refresh_token"] = refresh_token
    with open(_CONFIG, "w") as f:
        json.dump(cfg, f, indent=2)

    print(f"\n  Tokens salvos em config.json")
    print(f"  access_token : {access_token[:50]}...")
    print(f"  refresh_token: {refresh_token[:40]}...")

    print("\n  Testando /orders/search?seller=...")
    import datetime
    hoje = datetime.date.today()
    ini  = hoje.replace(day=1)
    fmt  = lambda d: f"{d.isoformat()}T00:00:00.000-03:00"
    user_id = cfg["ml_user_id"]
    r2 = requests.get(
        "https://api.mercadolibre.com/orders/search",
        params={
            "access_token":            access_token,
            "seller":                  user_id,
            "order.status":            "paid",
            "order.date_created.from": fmt(ini),
            "order.date_created.to":   fmt(hoje),
            "limit":                   5,
        },
        timeout=15,
    )
    print(f"  HTTP {r2.status_code}")
    try:
        body = r2.json()
        total = body.get("paging", {}).get("total", "n/d")
        print(f"  Total pedidos no mes: {total}")
        if r2.status_code == 200:
            print("\n  Escopo OK! Agora atualize credentials_local.gs e rode clasp push.")
            print(f"\n  ML_ACCESS_TOKEN  = '{access_token}'")
            print(f"  ML_REFRESH_TOKEN = '{refresh_token}'")
        else:
            print(f"  Resposta: {json.dumps(body)[:400]}")
    except Exception:
        print(f"  {r2.text[:400]}")


if __name__ == "__main__":
    main()
