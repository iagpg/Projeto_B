"""
connectors/tiny/connector.py
------------------------------
Implementa IProductConnector para o Tiny ERP v3.
Traduz resposta do Tiny → Product (domínio agnóstico de plataforma).
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from typing import Optional
from interfaces.product import IProductConnector
from interfaces.base import Product
from connectors.tiny import client as tc


class TinyConnector(IProductConnector):
    """Connector do Tiny ERP. Implementa IProductConnector."""

    def buscar_produto(self, sku: str) -> Optional[Product]:
        result = tc.get("/produtos", {"codigo": sku})
        itens = result.get("itens", [])
        match = next((i for i in itens if str(i.get("sku", "")).strip() == sku), None)
        if not match:
            return None
        detail = tc.get_produto(match["id"])
        return self._to_product(detail)

    def listar_produtos(self, **filters) -> list[Product]:
        result = tc.get("/produtos", {k: v for k, v in filters.items() if v is not None})
        return [self._to_product(p) for p in result.get("itens", [])]

    def _to_product(self, raw: dict) -> Product:
        situacao = raw.get("situacao", "")
        status_map = {"A": "active", "I": "paused", "E": "closed"}
        status = status_map.get(situacao, situacao.lower() if situacao else "unknown")
        variacoes = raw.get("variacoes") or []
        return Product(
            sku=str(raw.get("codigo") or raw.get("sku") or ""),
            name=raw.get("nome", ""),
            status=status,
            platform="tiny",
            platform_id=str(raw.get("id", "")),
            is_kit=bool(variacoes),
            metadata={
                "tipo":      raw.get("tipo"),
                "situacao":  situacao,
                "variacoes": variacoes,
            },
        )
