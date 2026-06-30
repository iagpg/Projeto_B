"""
services/produto_service.py
-----------------------------
ProdutoService — orquestra consultas de produto entre múltiplos connectors.
Depende de IProductConnector, nunca de implementações concretas.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from typing import Optional
from interfaces.product import IProductConnector
from interfaces.base import Product


class ProdutoService:
    """
    Serviço de produto. Recebe uma lista de connectors na criação.
    A IA não sabe quais connectors estão registrados — apenas chama os métodos.

    Exemplo de uso:
        service = ProdutoService([MercadoLivreConnector(), TinyConnector()])
        resultado = service.buscar_produto("10034034168089")
    """

    def __init__(self, connectors: list[IProductConnector]):
        self._connectors = connectors

    def buscar_produto(self, sku: str) -> dict[str, Optional[Product]]:
        """Busca o produto em todos os connectors registrados.
        Retorna dict keyed pelo nome da plataforma.

        Exemplo de retorno:
            {
                "mercadolivre": Product(sku=..., status="active", ...),
                "tiny":         Product(sku=..., status="active", ...),
            }
        """
        results: dict[str, Optional[Product]] = {}
        for connector in self._connectors:
            platform = connector.__class__.__name__.lower().replace("connector", "")
            try:
                results[platform] = connector.buscar_produto(sku)
            except Exception as e:
                results[platform] = None
        return results

    def listar_produtos(self, **filters) -> dict[str, list[Product]]:
        """Lista produtos em todos os connectors com os filtros fornecidos."""
        results: dict[str, list[Product]] = {}
        for connector in self._connectors:
            platform = connector.__class__.__name__.lower().replace("connector", "")
            try:
                results[platform] = connector.listar_produtos(**filters)
            except Exception as e:
                results[platform] = []
        return results
