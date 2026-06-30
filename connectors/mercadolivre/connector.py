"""
connectors/mercadolivre/connector.py
--------------------------------------
Implementa IProductConnector para o Mercado Livre.
Traduz MLResult → Product (domínio agnóstico de plataforma).
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from typing import Optional
from interfaces.product import IProductConnector
from interfaces.base import Product
from connectors.mercadolivre.client import lookup, search_by_sku, get_items_batch, get_item, MLResult


class MercadoLivreConnector(IProductConnector):
    """Connector do Mercado Livre. Implementa IProductConnector."""

    def buscar_produto(self, sku: str) -> Optional[Product]:
        result = lookup(sku)
        return self._to_product(result) if result.found else None

    def listar_produtos(self, **filters) -> list[Product]:
        seller_sku = filters.get("sku")
        if seller_sku:
            ids = search_by_sku(str(seller_sku))
            raws = get_items_batch(ids) if len(ids) > 1 else ([get_item(ids[0])] if ids else [])
            from connectors.mercadolivre.client import _build_result
            return [self._to_product(_build_result(r)) for r in raws if r.get("id")]
        return []

    def _to_product(self, result: MLResult) -> Product:
        return Product(
            sku=result.seller_sku or result.identifier,
            name=result.title,
            status=result.status,
            platform="mercadolivre",
            platform_id=result.item_id,
            metadata={
                "item_group_id":     result.item_group_id,
                "catalog_product_id": result.catalog_product_id,
                "is_migrated":       result.is_migrated,
                "migration_ids":     result.migration_ids,
                "tags":              result.tags,
            },
        )
