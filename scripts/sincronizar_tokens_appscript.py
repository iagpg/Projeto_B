"""
scripts/sincronizar_tokens_appscript.py
----------------------------------------
Sincroniza as CREDENCIAIS ESTATICAS do app (client_id/client_secret/user_id)
do Python para o Apps Script.

Desde que apps_script/08_Autorizacao.gs existe, o Apps Script obtem e renova
seus proprios access/refresh tokens sozinho (menu BouwObra > Autorizacao
OAuth) — este script NAO mexe mais em tokens, só nas credenciais do app,
que praticamente nunca mudam.

Rodar apenas se:
    - for a primeira vez configurando a planilha, ou
    - o client_id/client_secret do app ML ou Tiny for trocado.

Uso:
    python scripts/sincronizar_tokens_appscript.py
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT          = Path(__file__).resolve().parent.parent
CONFIG        = ROOT / "config.json"
CREDENTIALS   = ROOT / "apps_script" / "credentials_local.gs"
APPS_SCRIPT   = ROOT / "apps_script"

TEMPLATE = """\
// ============================================================
// credentials_local.gs — CREDENCIAIS DO APP (gitignored, só local)
// Gerado automaticamente por scripts/sincronizar_tokens_appscript.py
//
// Contém apenas client_id/client_secret/user_id (credenciais estáticas
// do app, não mudam). Os access/refresh tokens NÃO ficam mais aqui —
// use o menu BouwObra > 🔐 Autorização OAuth para obtê-los diretamente
// no Apps Script (apps_script/08_Autorizacao.gs).
// ============================================================

function inicializarConfiguracoes() {{
  getProps().setProperties({{
    // Mercado Livre
    'ML_CLIENT_ID':     '{ml_client_id}',
    'ML_CLIENT_SECRET': '{ml_client_secret}',
    'ML_USER_ID':       '{ml_user_id}',
    // Tiny ERP
    'TINY_CLIENT_ID':     '{tiny_client_id}',
    'TINY_CLIENT_SECRET': '{tiny_client_secret}',
  }});
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ Credenciais salvas! Agora rode Autorizacao OAuth.', 'BouwObra');
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
    print("  BouwObra - Sincronizar Credenciais -> Apps Script")
    print("=" * 60)

    cfg = _load_json(CONFIG, "ML/Tiny (config.json)")

    required_cfg = ["ml_client_id", "ml_client_secret", "ml_user_id",
                    "tiny_v3_client_id", "tiny_v3_client_secret"]
    missing = [k for k in required_cfg if not cfg.get(k)]
    if missing:
        print(f"\n  ERRO: Campos ausentes em config.json: {missing}")
        sys.exit(1)

    content = TEMPLATE.format(
        ml_client_id       = cfg["ml_client_id"],
        ml_client_secret   = cfg["ml_client_secret"],
        ml_user_id         = cfg["ml_user_id"],
        tiny_client_id     = cfg["tiny_v3_client_id"],
        tiny_client_secret = cfg["tiny_v3_client_secret"],
    )

    CREDENTIALS.write_text(content, encoding="utf-8")
    print(f"\n  OK: credentials_local.gs atualizado (sem tokens)")

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
    print("  PROXIMOS PASSOS na planilha Google Sheets:")
    print("  1. Menu BouwObra > Inicializar Configuracoes")
    print("  2. Menu BouwObra > Autorizacao OAuth > Autorizar ML / Autorizar Tiny")
    print("-" * 60 + "\n")


if __name__ == "__main__":
    main()
