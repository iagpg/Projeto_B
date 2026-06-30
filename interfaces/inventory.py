from abc import ABC, abstractmethod
from interfaces.base import InventoryItem


class IInventoryConnector(ABC):
    """Interface de estoque. Implementada por ERPs e marketplaces com fulfillment."""

    @abstractmethod
    def consultar_estoque(self, sku: str) -> list[InventoryItem]:
        """Retorna posições de estoque para o SKU em todos os depósitos/centros."""
        ...

    @abstractmethod
    def atualizar_estoque(self, sku: str, quantity: int, **kwargs) -> bool:
        """Atualiza o estoque. Retorna True em sucesso."""
        ...
