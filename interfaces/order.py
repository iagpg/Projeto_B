from abc import ABC, abstractmethod
from typing import Optional
from interfaces.base import Order


class IOrderConnector(ABC):
    """Interface de pedidos. Todo connector de marketplace deve implementar esta."""

    @abstractmethod
    def buscar_pedido(self, order_id: str) -> Optional[Order]:
        """Busca um pedido pelo ID da plataforma."""
        ...

    @abstractmethod
    def listar_pedidos(self, **filters) -> list[Order]:
        """Lista pedidos com filtros opcionais (status, data, etc.)."""
        ...
