# Mercado Livre — Rastreamento de Anúncios

Referência de como localizar, classificar e rastrear anúncios no ML a partir de um **MLB ID** ou de um **SKU**. Cobre detecção de status, migração para modelo de variações e limites da API de User Products.

---

## Conceitos Fundamentais

| Conceito | Formato | Descrição |
|---|---|---|
| **SKU** | alfanumérico (ex: `10034034168089`) | Identificador único da variação. Igual em todas as plataformas (ML, Shopee, etc.). É o campo `seller_sku` dentro do anúncio ML. |
| **MLB ID** | `MLB{números}` | ID do anúncio no Mercado Livre. Específico da plataforma. |
| **MLBU ID** | `MLBU{números}` | ID do user product referenciado nas variações de um item. |
| **User Product (UP)** | numérico ou MLBU | Representa o produto do vendedor no catálogo ML. Cada variação de um item tem um UP próprio. |
| **Status** | active / paused / closed | Estado atual do anúncio. |

---

## Autenticação

OAuth2 com **refresh token**. O access token expira; o refresh token é de longa duração.

```
POST https://api.mercadolibre.com/oauth/token
  grant_type=refresh_token
  client_id={ML_CLIENT_ID}
  client_secret={ML_CLIENT_SECRET}
  refresh_token={refresh_token}
```

**Regras de retry:**
- `401` → refresh automático do token, retentar uma vez
- `429` → aguardar 3 s, retentar
- Sempre salvar o novo `access_token` e `refresh_token` recebidos

---

## Busca por MLB ID

### Endpoint direto (item único)
```
GET /items/{MLB_ID}
    ?attributes=id,status,tags,item_group_id,catalog_product_id
```

### Endpoint em lote (até 20 IDs por chamada)
```
GET /items
    ?ids=MLB1,MLB2,...
    &attributes=id,status,tags,item_group_id,catalog_product_id
```
Resposta: array de objetos `{code, body}`. Usar `body` para cada item.

### Campos relevantes

| Campo | O que observar |
|---|---|
| `status` | `active` / `paused` / `closed` |
| `tags` | lista de strings — checar `variations_migration_source` |
| `item_group_id` | grupo de variações (quando presente) |
| `catalog_product_id` | vínculo com catálogo ML |

---

## Busca por SKU

```
GET /users/{user_id}/items/search
    ?seller_sku={SKU}
```

Retorna `{"results": ["MLB...", "MLB...", ...]}`.  
Para cada MLB retornado, aplicar a lógica de busca por MLB ID.

**Importante:** o campo `seller_sku` no ML é o mesmo que o `SKU` no Tiny. Se o anúncio não tiver o SKU configurado, a busca retorna vazio — o problema é nos dados, não no código.

---

## Status dos Anúncios

| Status | Significado |
|---|---|
| `active` | Anúncio visível e disponível para compra |
| `paused` | Inativo — sem estoque ou pausado manualmente |
| `closed` | Encerrado — pode ter sido migrado ou simplesmente fechado |

Um anúncio `closed` **não significa** migrado. Verificar as `tags` para diferenciar.

---

## Detecção de Migração (UPtin / Preço por Variação)

Quando o ML migra um anúncio simples para o modelo de preço por variação:

- **Item antigo** → `status: closed`, `tags` contém `variations_migration_source`
- **Itens novos** → um por variação, `tags` contém `variations_migration_uptin`

### Mapeando antigo → novos

```
GET /items/{MLB_ANTIGO}/migration_live_listing
```

Resposta:
```json
{
  "new_items": [
    {
      "variation_id": 179111297961,
      "new_item_id": "MLB4234005033",
      "migration_status": "created"
    }
  ]
}
```

| `migration_status` | Significado |
|---|---|
| `created` | Novo anúncio já criado e ativo |
| `pending` | Migração em andamento, novo item ainda não disponível |

Usar apenas `new_item_id` com `migration_status == "created"` como referência confiável.

---

## Variações dentro de um Anúncio

Um item pode ter variações (ex: tamanho, cor). Cada variação possui:

```json
{
  "id": 179111297961,
  "user_product_id": "MLBU1675698947",
  "inventory_id": "AMWT58801",
  "seller_custom_field": null
}
```

Para acessar as variações com menos dados:
```
GET /items/{MLB_ID}
    ?attributes=variations.id,variations.user_product_id,variations.inventory_id
```

---

## User Products (UP)

Representa o produto do vendedor no catálogo ML, independente do anúncio.

```
GET /users/{user_id}/user_products
    ?item_id={MLB_ID}
```

### ⚠️ Limitações conhecidas

| Situação | Resultado |
|---|---|
| Item **ativo** | Retorna o UP com `family_id`, `catalog_product_id`, `id` numérico |
| Item **closed** ou **migrado** | Retorna vazio — o vínculo pelo `item_id` não funciona para itens fechados |
| `GET /users/{uid}/user_products/{MLBU_ID}` | Retorna `resource not found` — requer permissão de escopo que o token atual não possui |

Para itens migrados, usar `/migration_live_listing` em vez dos endpoints de user_products.

---

## Busca por Grupo de Itens

Quando um item tem `item_group_id`, é possível encontrar todos os itens ativos do mesmo grupo:

```
GET /users/{user_id}/items/search
    ?item_group_id={item_group_id}
```

Retorna lista de MLB IDs ativos no grupo. Útil para encontrar o item ativo quando o item original foi migrado e o `item_group_id` está preenchido.

---

## Fluxo de Decisão

```
Entrada: MLB ID ou SKU
       │
       ▼
┌─────────────────────┐
│ Começa com "MLB"?   │
└─────────────────────┘
    │ SIM                    │ NÃO (é SKU)
    ▼                        ▼
GET /items/{MLB_ID}      GET /users/{uid}/items/search
                             ?seller_sku={SKU}
                             │
                             ▼
                         Retornou IDs?
                         │ NÃO → "não encontrado no ML"
                         │ SIM → para cada MLB, aplicar fluxo abaixo
    │
    ▼
Checar status
    │
    ├── "active"  → anúncio ativo ✓
    │
    ├── "paused"  → anúncio inativo (sem estoque)
    │
    └── "closed"
            │
            ▼
        Tag "variations_migration_source"?
            │
            ├── NÃO → anúncio fechado (encerrado)
            │
            └── SIM → migrado
                    │
                    ▼
                item_group_id preenchido?
                    │
                    ├── SIM → GET /items/search?item_group_id=...
                    │         → lista de novos itens ativos
                    │
                    └── NÃO → GET /items/{MLB}/migration_live_listing
                              → new_items[].new_item_id onde status=="created"
```

---

## Referência de Endpoints

| Operação | Endpoint |
|---|---|
| Buscar item por ID | `GET /items/{MLB_ID}` |
| Buscar em lote | `GET /items?ids=MLB1,MLB2&attributes=...` |
| Buscar por SKU | `GET /users/{uid}/items/search?seller_sku={SKU}` |
| Buscar por grupo | `GET /users/{uid}/items/search?item_group_id={id}` |
| Mapeamento de migração | `GET /items/{MLB_ID}/migration_live_listing` |
| User product por item | `GET /users/{uid}/user_products?item_id={MLB_ID}` |
| Variações do item | `GET /items/{MLB_ID}?attributes=variations.user_product_id` |

---

## Notas de Implementação

- **Rate limit:** sempre aplicar `sleep(0.15s)` entre chamadas sequenciais para evitar 429
- **Batch:** preferir o endpoint em lote `/items?ids=...` quando verificar múltiplos IDs ao mesmo tempo (até 20 por chamada)
- **Atributos:** usar `?attributes=` para limitar o payload — sem esse parâmetro, a resposta traz campos não necessários e é maior
- **Token:** salvar `access_token` e `refresh_token` a cada refresh — o ML rotaciona ambos
