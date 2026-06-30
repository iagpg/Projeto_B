from abc import ABC, abstractmethod
from typing import Optional
from interfaces.base import Product


class IProductConnector(ABC):
    """Interface de produto. Todo connector de plataforma deve implementar esta."""

    @abstractmethod
    def buscar_produto(self, sku: str) -> Optional[Product]:
        """Busca um produto pelo SKU. Retorna None se não encontrado."""
        ...

    @abstractmethod
    def listar_produtos(self, **filters) -> list[Product]:
        """Lista produtos com filtros opcionais (status, situacao, etc.)."""
        ...
