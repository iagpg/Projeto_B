"""
scripts/sincronizar_custo.py
-----------------------------
Sincroniza o cache de custo NF com o Tiny ERP e grava alertas na planilha.

Uso:
    python scripts/sincronizar_custo.py            # incremental (só NFs novas)
    python scripts/sincronizar_custo.py --full     # varredura completa (12 meses)
    python scripts/sincronizar_custo.py --report   # mostra mudanças sem gravar cache
    python scripts/sincronizar_custo.py --info     # exibe info do cache atual

    # Período específico (não mexe no checkpoint incremental, faz merge com o cache):
    python scripts/sincronizar_custo.py --desde 2025-01-01 --ate 2025-07-23

    # Uma NF específica:
    python scripts/sincronizar_custo.py --nf 059467
"""

import sys, json
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from services.custo_service import build_cache, load_cache, detect_changes, cache_info

ARGS = sys.argv[1:]


def _arg_value(flag: str):
    if flag in ARGS:
        idx = ARGS.index(flag)
        if idx + 1 < len(ARGS):
            return ARGS[idx + 1]
    return None


def _fmt_brl(v) -> str:
    if v is None:
        return "—"
    return f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _fmt_pct(v) -> str:
    if v is None:
        return "novo"
    sign = "+" if v > 0 else ""
    return f"{sign}{v:.1f}%"


def main():
    print("\n" + "=" * 60)
    print("  BouwObra — Sincronizar Custo NF")
    print("=" * 60)

    # ── --info ──────────────────────────────────────────────────
    if "--info" in ARGS:
        info = cache_info()
        print(f"\n  Cache: {info['cache_path']}")
        print(f"  Existe: {info['exists']}")
        if info["exists"]:
            print(f"  Versão:      {info['version']}")
            print(f"  Last NF ID:  {info['last_nf_id']}")
            print(f"  Total SKUs:  {info['total_skus']}")
        return

    # ── --report: mostra diferenças sem gravar ───────────────────
    if "--report" in ARGS:
        print("\n  Modo report: comparando cache atual vs API (sem gravar)...")
        old = load_cache()
        print(f"  Cache atual: {len(old)} SKUs")
        new = build_cache(force_full=True, verbose=True)
        alertas = detect_changes(old, new)
        _print_alertas(alertas)
        return

    # ── Período específico ou NF específica ─────────────────────
    desde  = _arg_value("--desde")
    ate    = _arg_value("--ate")
    numero = _arg_value("--nf")

    if numero:
        print(f"\n  Modo: NF específica (numero={numero})")
        old_cache = load_cache()
        print(f"  Cache anterior: {len(old_cache)} SKUs")
        print()
        new_cache = build_cache(numero_nf=numero, verbose=True)
        alertas = detect_changes(old_cache, new_cache)
        _print_alertas(alertas)
        if alertas:
            _gravar_alertas_json(alertas)
        print(f"\n  Concluído em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
        print("=" * 60 + "\n")
        return

    if desde or ate:
        print(f"\n  Modo: período específico ({desde or '...'} -> {ate or 'hoje'})")
        old_cache = load_cache()
        print(f"  Cache anterior: {len(old_cache)} SKUs")
        print()
        new_cache = build_cache(data_inicio=desde, data_fim=ate, verbose=True)
        alertas = detect_changes(old_cache, new_cache)
        _print_alertas(alertas)
        if alertas:
            _gravar_alertas_json(alertas)
        print(f"\n  Concluído em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
        print("=" * 60 + "\n")
        return

    # ── Sync normal (incremental ou full) ───────────────────────
    force_full = "--full" in ARGS
    if force_full:
        print("\n  Modo: varredura COMPLETA (últimos 12 meses)")
    else:
        print("\n  Modo: incremental (só NFs novas)")

    old_cache = load_cache()
    print(f"  Cache anterior: {len(old_cache)} SKUs")

    print()
    new_cache = build_cache(force_full=force_full, verbose=True)

    alertas = detect_changes(old_cache, new_cache)
    _print_alertas(alertas)

    if alertas:
        _gravar_alertas_json(alertas)

    print(f"\n  Concluído em {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    print("=" * 60 + "\n")


def _print_alertas(alertas: list) -> None:
    if not alertas:
        print("\n  Sem mudanças de custo relevantes.")
        return

    print(f"\n  {len(alertas)} alerta(s) de custo:\n")
    print(f"  {'SKU':<12} {'Descrição':<35} {'Anterior':>10} {'Novo':>10} {'Var':>8}")
    print("  " + "-" * 80)
    for a in alertas:
        desc = (a["descricao"] or "")[:34]
        print(f"  {a['sku']:<12} {desc:<35} "
              f"{_fmt_brl(a['custo_antigo']):>10} "
              f"{_fmt_brl(a['custo_novo']):>10} "
              f"{_fmt_pct(a['variacao_pct']):>8}")


def _gravar_alertas_json(alertas: list) -> None:
    """Salva alertas em cache/alertas.json para leitura posterior."""
    path = ROOT / "cache" / "alertas.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "gerado_em": datetime.now().isoformat(timespec="seconds"),
        "alertas":   alertas,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"\n  Alertas gravados em: {path}")


if __name__ == "__main__":
    main()
