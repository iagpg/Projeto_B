"""
tools/produtos.py
------------------
Ferramentas públicas de produto para agentes de IA.

A IA chama estas funções sem conhecer detalhes de APIs, OAuth,
rate limits ou diferenças entre plataformas.

Uso:
    from tools.produtos import buscar_produto, buscar_anuncio
    resultado = buscar_produto("10034034168089")
    anuncio   = buscar_anuncio("MLB4097684635")
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from typing import Optional
from interfaces.base import Product
from connectors.mercadolivre.connector import MercadoLivreConnector
from connectors.tiny.connector import TinyConnector
from services.produto_service import ProdutoService

# Connectors e service são instanciados uma vez (singleton de módulo)
_service = ProdutoService(connectors=[
    MercadoLivreConnector(),
    TinyConnector(),
])


def buscar_produto(sku: str) -> dict[str, Optional[Product]]:
    """Busca um produto pelo SKU em todos os sistemas integrados.

    Retorna um dict com o resultado de cada plataforma:
        {
            "mercadolivre": Product | None,
            "tiny":         Product | None,
        }

    O status de cada Product é normalizado:
        active | paused | closed | migrated | not_found
    """
    return _service.buscar_produto(sku)


def buscar_anuncio(identifier: str):
    """Busca um anúncio no Mercado Livre por MLB ID ou SKU.

    Detecta automaticamente:
    - Status (active / paused / closed)
    - Migração para modelo de variações
    - Dados do grupo de variações

    Retorna MLResult com atributos:
        .found        bool
        .status       str  (active | paused | closed | migrated | not_found)
        .item_id      str  (MLB...)
        .seller_sku   str
        .is_migrated  bool
        .migration_ids list[str]
        .title        str
        .summary()    str  (linha legível)
    """
    from connectors.mercadolivre.client import lookup
    return lookup(identifier)
