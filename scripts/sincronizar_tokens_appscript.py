"""
scripts/sincronizar_tokens_appscript.py
----------------------------------------
Sincroniza os tokens de autenticação do Python para o Apps Script.

Lê os tokens mais recentes de config.json (ML) e tiny_token.json (Tiny),
regrava apps_script/credentials_local.gs e executa clasp push.

Rodar SEMPRE depois de:
    python connectors/tiny/auth.py
    python connectors/mercadolivre/auth.py

Uso:
    python scripts/sincronizar_tokens_appscript.py
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT          = Path(__file__).resolve().parent.parent
CONFIG        = ROOT / "config.json"
TINY_TOKEN    = ROOT / "tiny_token.json"
CREDENTIALS   = ROOT / "apps_script" / "credentials_local.gs"
APPS_SCRIPT   = ROOT / "apps_script"

TEMPLATE = """\
// ============================================================
// credentials_local.gs — TOKENS REAIS (gitignored, só local)
// Gerado automaticamente por scripts/sincronizar_tokens_appscript.py
// Rodar UMA VEZ após qualquer atualização de token.
// ============================================================

function inicializarConfiguracoes() {{
  getProps().setProperties({{
    // Mercado Livre
    'ML_CLIENT_ID':     '{ml_client_id}',
    'ML_CLIENT_SECRET': '{ml_client_secret}',
    'ML_USER_ID':       '{ml_user_id}',
    'ML_ACCESS_TOKEN':  '{ml_access_token}',
    'ML_REFRESH_TOKEN': '{ml_refresh_token}',
    // Tiny ERP
    'TINY_CLIENT_ID':     '{tiny_client_id}',
    'TINY_CLIENT_SECRET': '{tiny_client_secret}',
    'TINY_ACCESS_TOKEN':  '{tiny_access_token}',
    'TINY_REFRESH_TOKEN': '{tiny_refresh_token}',
  }});
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ Configurações salvas com sucesso!', 'BouwObra');
}}
"""


def _load_json(path: Path, label: str) -> dict:
    if not path.exists():
        print(f"\n  ERRO: Arquivo nao encontrado: {path}")
        print(f"     Execute o auth do {label} primeiro.")
        sys.exit(1)
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main():
    print("\n" + "=" * 60)
    print("  BouwObra - Sincronizar Tokens -> Apps Script")
    print("=" * 60)

    cfg  = _load_json(CONFIG, "ML/Tiny (config.json)")
    tiny = _load_json(TINY_TOKEN, "Tiny (tiny_token.json)")

    required_cfg = ["ml_client_id", "ml_client_secret", "ml_user_id",
                    "ml_access_token", "ml_refresh_token",
                    "tiny_v3_client_id", "tiny_v3_client_secret"]
    missing = [k for k in required_cfg if not cfg.get(k)]
    if missing:
        print(f"\n  ERRO: Campos ausentes em config.json: {missing}")
        sys.exit(1)

    if "access_token" not in tiny or "refresh_token" not in tiny:
        print("\n  ERRO: tiny_token.json sem access_token/refresh_token.")
        print("     Execute: python connectors/tiny/auth.py")
        sys.exit(1)

    content = TEMPLATE.format(
        ml_client_id     = cfg["ml_client_id"],
        ml_client_secret = cfg["ml_client_secret"],
        ml_user_id       = cfg["ml_user_id"],
        ml_access_token  = cfg["ml_access_token"],
        ml_refresh_token = cfg["ml_refresh_token"],
        tiny_client_id   = cfg["tiny_v3_client_id"],
        tiny_client_secret = cfg["tiny_v3_client_secret"],
        tiny_access_token  = tiny["access_token"],
        tiny_refresh_token = tiny["refresh_token"],
    )

    CREDENTIALS.write_text(content, encoding="utf-8")
    print(f"\n  OK: credentials_local.gs atualizado")
    print(f"     Tiny access_token : ...{tiny['access_token'][-30:]}")
    print(f"     Tiny refresh_token: ...{tiny['refresh_token'][-30:]}")
    print(f"     ML access_token   : ...{cfg['ml_access_token'][-30:]}")

    print("\n  Executando clasp push...")
    result = subprocess.run(
        "clasp push --force",
        cwd=str(APPS_SCRIPT),
        capture_output=True,
        text=True,
        shell=True,
    )
    if result.returncode == 0:
        print(f"  OK: clasp push concluido\n{result.stdout.strip()}")
    else:
        print(f"  ERRO: clasp push falhou:\n{result.stderr.strip()}")
        sys.exit(1)

    print("\n" + "-" * 60)
    print("  PROXIMO PASSO OBRIGATORIO:")
    print("  Na planilha Google Sheets, execute:")
    print("  Menu BouwObra > Inicializar Configuracoes")
    print("  (ou abra o Apps Script e rode inicializarConfiguracoes)")
    print("-" * 60 + "\n")


if __name__ == "__main__":
    main()
