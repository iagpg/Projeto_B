# Comandos do Projeto

Referência de todos os scripts disponíveis. Executar sempre a partir da **raiz do projeto** (`d:\backend`).

---

## Pipeline Principal

### `validate_skus.py`
Valida SKUs do Excel contra as APIs do Mercado Livre e Tiny ERP.
Preenche a coluna E com o resultado e aplica cor por status.

| Cor | Significado |
|---|---|
| Verde | Anúncio ativo no ML |
| Cinza | Anúncio pausado (sem estoque) |
| Vermelho | Anúncio fechado |
| Amarelo | Cadastrado no Tiny, sem anúncio no ML |
| Roxo | Não encontrado em nenhum sistema |
| Azul | Migrado para novo modelo de variações |
| Laranja | Kit com variações ativas no ML |
| Vermelho escuro | Kit sem variações no ML |

```bash
# Processar todas as linhas (do início ao fim)
python scripts/validate_skus.py

# Processar intervalo específico de linhas
python scripts/validate_skus.py --from-row 2 --to-row 50

# Forçar reprocessamento de todas as linhas (incluindo já preenchidas)
python scripts/validate_skus.py --force-all

# Combinar: forçar reprocessamento em intervalo
python scripts/validate_skus.py --from-row 2 --to-row 10 --force-all
```

**Entrada:** `input/bouw_skus_a_validar.xlsx` (configurado em `config.json`)
**Saída:** `output/output.xlsx`

---

## Promoções ML

### `check_promotions.py`
Verifica o status de campanhas de promoção do ML para os anúncios de uma Curva
do arquivo `Ecommerce.xlsx`. Cria uma aba de análise com status, alertas e cores.

**Campanhas monitoradas:**
- `C-MLB4305989` — "Junho ate Julho" (expira 01/07/2026)
- `C-MLB4586868` — "Julho" (01/07/2026 a 01/08/2026)

**Status na aba gerada:**
| Coluna Julho | Cor | Significado |
|---|---|---|
| Ativa / Inscrito | Verde | OK — campanha garantida |
| Candidato | Amarelo | Inscrito como candidato — confirmar |
| Fora | Vermelho | Não participa da campanha |

**Tipos de ID suportados na coluna A:**
| Dígitos | Tipo | Exemplo | Comportamento |
|---|---|---|---|
| 7–13 | Anúncio individual | `3943414937` → `MLB3943414937` | Uma linha por anúncio |
| 14+   | Grupo de variações | `8394429844084229` → `MLBU...` | Expande todas as variações, exibe linha resumo |

**Filtro automático:**
- Linhas com **"Estoque Encalhado"** na coluna R são ignoradas automaticamente.

**Lógica de alerta (anúncios individuais):**
- Anúncio em ambas as campanhas → `"Julho ja programado — OK"` (normal, campanha sobreposta)
- Apenas na Junho sem Julho → `"EXPIRA AMANHA! Nao inscrito no Julho"` ⚠
- Fora de ambas → `"Fora de ambas as campanhas"`

**Lógica de alerta (grupos):**
- Todas as variações com Julho → `"Todas as N variacoes com Julho OK"` (verde)
- Parte das variações com Julho → `"X/N variacoes SEM Julho"` ⚠ (laranja)
- Candidatas, sem confirmação → `"X/N candidatas — confirmar inscricao"` (amarelo)
- Todas sem Julho, algumas na Junho → `"URGENTE! X/N apenas em Junho"` ⚠ (vermelho)

```bash
# Curva B (padrão)
python scripts/check_promotions.py

# Selecionar curva
python scripts/check_promotions.py --a    # Curva A → aba "Analise Promocoes A"
python scripts/check_promotions.py --b    # Curva B → aba "Analise Promocoes B"
python scripts/check_promotions.py --c    # Curva C → aba "Analise Promocoes C"
```

**Arquivo:** `output/Ecommerce.xlsx` (lê a aba selecionada, cria aba de análise)

---

## Autenticação

### `connectors/tiny/auth.py`
Setup do OAuth2 do Tiny ERP v3. Roda **uma vez** para obter o token inicial,
e novamente quando o token expirar (mensagem de erro `Token is not active`).

Abre o navegador automaticamente e captura o callback via servidor local.

```bash
python connectors/tiny/auth.py
```

**Saída:** token salvo em `tiny_token.json` na raiz do projeto.

---

## Diagnóstico e Debug

### `debug_kit.py`
Busca um produto no Tiny ERP pelo SKU e exibe a resposta completa da API.
Útil para verificar se um produto é kit (`tipo: V`) e ver suas variações.

```bash
python scripts/debug_kit.py <SKU>

# Exemplos
python scripts/debug_kit.py 10034034168089
python scripts/debug_kit.py CAMPERAVANT4UN
```

---

### `fetch_item.py`
Busca um anúncio no Mercado Livre pelo MLB ID e exibe o JSON completo da API.
Útil para inspecionar campos, tags e status raw de um item.

```bash
python scripts/fetch_item.py <MLB_ID>

# Exemplo
python scripts/fetch_item.py MLB3347232243
```

---

### `test_up.py`
Testa o endpoint `migration_live_listing` para um anúncio migrado.
Exibe os novos MLB IDs gerados pela migração de modelo de preço por variação.

```bash
python scripts/test_up.py <MLB_ID>

# Exemplo (item migrado)
python scripts/test_up.py MLB3347232243
```

---

### `test_ml_sku.py`
Busca anúncios no ML pelo `seller_sku` e exibe os IDs e status retornados.

```bash
python scripts/test_ml_sku.py <SKU>

# Exemplos
python scripts/test_ml_sku.py 10034034168089
python scripts/test_ml_sku.py CAMPERAVANT4UN
```

---

### `test_sku.py`
Executa a lógica completa de classificação (`build_col_e`) para um SKU
e exibe o resultado e a cor que seriam escritos no Excel.

```bash
python scripts/test_sku.py <SKU>

# Exemplos
python scripts/test_sku.py 10034034168089
python scripts/test_sku.py MLB4097684635
```

---

### `test_migration_group.py`
Inspeciona o `item_group_id` e variações de um anúncio migrado.
Hardcoded para `MLB3347232243` — editar o arquivo para testar outro ID.

```bash
python scripts/test_migration_group.py
```

---

## Tool reutilizável

### `tools/ml_finder.py` (módulo + CLI)
Busca anúncios no ML por MLB ID ou SKU. Detecta status, migração e variações.
Pode ser usado como CLI ou importado por outros scripts.

```bash
# CLI
python tools/ml_finder.py <MLB_ID ou SKU>

# Exemplos
python tools/ml_finder.py MLB4097684635
python tools/ml_finder.py 10034034168089
```

```python
# Como módulo
import sys
sys.path.insert(0, ".")
from tools.ml_finder import lookup

r = lookup("MLB4097684635")
print(r.status)         # active | paused | closed | migrated | not_found
print(r.item_id)        # MLB4097684635
print(r.seller_sku)     # SKU configurado no anúncio
print(r.is_migrated)    # True/False
print(r.migration_ids)  # ["MLB..."] se migrado
print(r.summary())      # linha legível
```

---

## Configuração

### `config.json`
Arquivo de configuração na raiz. Contém credenciais e paths.

| Chave | Descrição |
|---|---|
| `ml_client_id` | App ID do Mercado Livre |
| `ml_client_secret` | Secret do Mercado Livre |
| `ml_user_id` | ID do vendedor ML |
| `ml_access_token` | Token de acesso ML (atualizado automaticamente) |
| `ml_refresh_token` | Refresh token ML |
| `tiny_v3_client_id` | Client ID do Tiny ERP v3 |
| `tiny_v3_client_secret` | Secret do Tiny ERP v3 |
| `excel_input` | Caminho absoluto para o Excel de entrada |
| `excel_output` | Caminho absoluto para o Excel de saída |

---

*Atualizado sempre que um novo script é criado.*
