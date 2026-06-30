"""
Modelos de domínio compartilhados entre todos os connectors.
Estes dataclasses representam entidades de negócio, não estruturas de API.
"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Product:
    sku: str
    name: str
    status: str              # active | paused | closed | migrated | not_found
    platform: str            # mercadolivre | tiny | amazon | shopee | ...
    platform_id: str = ""   # MLB... | ID Tiny | ASIN...
    price: Optional[float] = None
    stock: Optional[int] = None
    is_kit: bool = False
    metadata: dict = field(default_factory=dict)  # dados extras específicos da plataforma


@dataclass
class OrderItem:
    sku: str
    quantity: int
    unit_price: float


@dataclass
class Order:
    order_id: str
    platform: str
    status: str
    items: list[OrderItem]
    total: float
    buyer_name: str = ""
    metadata: dict = field(default_factory=dict)


@dataclass
class InventoryItem:
    sku: str
    platform: str
    platform_id: str
    quantity: int
    metadata: dict = field(default_factory=dict)
