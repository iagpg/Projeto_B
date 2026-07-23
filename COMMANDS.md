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

### `sincronizar_tokens_appscript.py`
Sincroniza os tokens mais recentes do Python para o Apps Script.
Lê `config.json` (tokens ML) e `tiny_token.json` (tokens Tiny), regrava
`apps_script/credentials_local.gs` e executa `clasp push` automaticamente.

**Rodar sempre depois de qualquer auth Python** (Tiny ou ML):

```bash
python scripts/sincronizar_tokens_appscript.py
```

Depois abrir a planilha e executar: **Menu BouwObra → Inicializar Configurações**

---

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
| `google_client_id` | OAuth2 Client ID do Google Cloud (Desktop app) |
| `google_client_secret` | OAuth2 Client Secret do Google Cloud |
| `gestao_sheet_id` | ID da planilha "BouwObra - Plataforma de Gestão" |
| `icms_venda_pct` | Alíquota de ICMS sobre vendas em % (ex: `12.0`) |
| `ml_taxa_default_pct` | Taxa ML padrão caso API de fees não responda (ex: `12.0`) |

---

## Plataforma de Gestão (Google Sheets)

### `populate_gestao.py`
Popula a planilha Google Sheets "BouwObra - Plataforma de Gestão" com:
- **Aba Precificação**: custo real (via NF Tiny), encargos fiscais e margem líquida por produto
- **Aba Dashboard**: KPIs de vendas do Mercado Livre

**Fórmulas fiscais (Lucro Real):**
| Campo | Fórmula |
|---|---|
| Custo NF c/ IPI | `(valor_NF / qtd) + IPI` |
| ICMS Compra crédito | `custo_base × ICMS_NF%` (0 se ST) |
| PIS/COFINS Compra crédito | `custo_base × 1,65% / 7,60%` |
| Imposto Recuperável | soma dos créditos de compra |
| ICMS/PIS/COFINS Venda | sobre Preço de Venda |
| Margem Líquida | `PV − ML − Impostos venda − Custo + Créditos` |

**Colunas da aba Precificação (A a U):**
ID ML · SKU · Nome · Categoria · Preço Venda · Taxa ML% · RT% · Frete · ICMS Venda · PIS Venda · COFINS Venda · Comissão+Frete ML · Custo NF · ICMS Crédito · PIS Crédito · COFINS Crédito · Imposto Recuperável · **Margem R$** · **Margem %** · Status · Atualização

**Coloração por margem:** Verde ≥20% · Amarelo 10–20% · Vermelho <10%

```bash
# Executar pipeline completo
python scripts/populate_gestao.py

# Sem varredura de NFs (teste rápido, custo = 0)
python scripts/populate_gestao.py --skip-nf

# Sem busca de pedidos (não atualiza Dashboard)
python scripts/populate_gestao.py --skip-orders
```

---

### `sincronizar_custo.py`
Constrói e mantém o cache local `cache/nf_custo.json` com o custo real de cada SKU
extraído das Notas Fiscais de entrada do Tiny. Detecta mudanças de custo e salva
alertas em `cache/alertas.json`.

```bash
# Incremental: só NFs com id maior que o último processado
python scripts/sincronizar_custo.py

# Varredura completa dos últimos 12 meses
python scripts/sincronizar_custo.py --full

# Compara cache atual vs API (sem gravar nada)
python scripts/sincronizar_custo.py --report

# Exibe metadados do cache atual
python scripts/sincronizar_custo.py --info
```

**Saída:** `cache/nf_custo.json` (SKU → custo base, IPI, ICMS/PIS/COFINS crédito, NF)
**Alertas:** `cache/alertas.json` (gerado quando custo varia > 2% entre sync)

---

### `exportar_cache_nf_excel.py`
Exporta `cache/nf_custo.json` para uma planilha Excel legível, com formatação
em R$, cabeçalho colorido, filtro automático e coluna congelada.

```bash
python scripts/exportar_cache_nf_excel.py
```

**Saída:** `output/cache_nf.xlsx`

---

### `probe_precificacao.py`
Testa o fluxo completo de precificação de um produto: cache NF → anúncio ML
(com seller_sku via campo direto ou attributes) → taxas ML → cálculo de
margem Lucro Real. Útil para diagnosticar por que um produto não aparece
corretamente na aba Precificação.

```bash
python scripts/probe_precificacao.py MLB3633227036 AM27
python scripts/probe_precificacao.py --sku AM27
```

---

### `probe_tiny_nf.py`
Diagnóstico da API Tiny v3 para Notas Fiscais.
Exibe a estrutura bruta da resposta para verificar nomes de campos.
**Rodar antes do primeiro `populate_gestao.py`** para confirmar que o módulo
`connectors/tiny/nf.py` lê os campos corretos.

```bash
python scripts/probe_tiny_nf.py
```

---

## Setup Google Sheets (uma vez)

### `connectors/google_sheets/auth.py`
Autoriza o acesso à planilha Google via OAuth2 browser flow.
Salva o token em `google_token.json` na raiz do projeto.

**Pré-requisitos:**
1. Acessar [console.cloud.google.com](https://console.cloud.google.com)
2. Habilitar **Google Sheets API**
3. Criar credenciais OAuth2 → tipo **Desktop app**
4. Copiar `client_id` e `client_secret` para `config.json`

```bash
python connectors/google_sheets/auth.py
```

---

## Apps Script — BouwObra Plataforma de Gestão

O sistema operacional da planilha **"BouwObra - Plataforma de Gestão"** roda 100% dentro do
Google Apps Script — sem executar código local.

### Arquivos em `d:\backend\apps_script\`

| Arquivo | Conteúdo |
|---|---|
| `01_Config.gs` | Constantes globais (URLs, alíquotas, nomes de aba, cabeçalhos) |
| `02_Auth.gs` | Tokens ML e Tiny + helpers HTTP (`mlGet`, `tinyGet`, `fetchAll`) |
| `03_TinyApi.gs` | Notas Fiscais de entrada → `atualizarCacheNF()` + `lerCacheNF()` |
| `04_MlApi.gs` | Anúncios, pedidos e taxas ML |
| `05_Precificacao.gs` | Fórmulas Lucro Real + escrita da aba Precificação |
| `06_Dashboard.gs` | KPIs de vendas + escrita da aba Dashboard |
| `07_Menu.gs` | Menu "BouwObra", trigger diário e funções de diagnóstico |

### Instalação (passo a passo)

1. Abrir a planilha **"BouwObra - Plataforma de Gestão"** no Google Sheets
2. Menu **Extensões → Apps Script**
3. Criar um arquivo `.gs` para cada arquivo da pasta `apps_script/`, colando o conteúdo
4. Salvar todos os arquivos
5. Executar a função **`inicializarConfiguracoes`** (uma vez): gravar tokens ML e Tiny
6. Executar **`atualizarCacheNF`** para popular o cache de custos das NFs Tiny
7. Executar **`sincronizarTudo`** ou usar o menu **BouwObra → Sincronizar Tudo**
8. Opcional: **BouwObra → Configurar Trigger Diário** para escolher horário e
   quais tarefas rodam sozinhas todo dia (buscar NF novas / sincronizar Precificação)

### Funções disponíveis no menu BouwObra

| Função | Descrição |
|---|---|
| `sincronizarTudo` | Cache NF + Precificação + Dashboard em sequência |
| `mostrarDialogoAdicionarAnuncio` | Abre um diálogo pra colar 1 MLB ID ou Family ID e adicionar/atualizar direto na Precificação, sem esperar o sync completo (ver `09_AdicionarAnuncio.gs`) |
| `atualizarCacheNF` | Varre NFs de entrada do Tiny (últimos 12 meses) |
| `atualizarPrecificacao` | Calcula margens e grava aba Precificação |
| `atualizarDashboard` | Busca KPIs ML e grava aba Dashboard |
| `inicializarConfiguracoes` | Grava client_id/client_secret/user_id nas propriedades do script (rodar 1×, ou se trocar de app) |
| `autorizarML` / `autorizarTiny` | Autorização OAuth2 inicial direto na planilha — gera o link, você cola o code retornado (ver `08_Autorizacao.gs`) |
| `mostrarDialogoConfigTrigger` | Painel de configuração do trigger diário — horário + liga/desliga por tarefa (guardado nas propriedades do script, ver `07_Menu.gs`) |
| `buscarNfNovasDoDia` | Chamado pelo trigger diário — acha a maior "NF Data" já cacheada e busca NFs até hoje, em lotes de 100 encadeados automaticamente |
| `testarConexaoML` | Diagnóstico: testa token ML |
| `testarConexaoTiny` | Diagnóstico: testa token Tiny |

### Adicionar Anúncio (aba dedicada)

Aba separada da Precificação — que é reescrita do zero a cada sync, então uma
área fixa dentro dela seria apagada. Cole na célula **B3** um:

- **MLB ID** (ex: `MLB3633227036`) → adiciona ou atualiza 1 linha na Precificação.
- **Family ID / item_group_id** (14+ dígitos, mesma convenção do `check_promotions.py`)
  → adiciona a linha "pai" (média das variações, já que cada uma pode ter preço
  praticado/frete/custo diferente) + uma linha por variação, agrupadas — use o
  "+"/"−" na lateral esquerda da planilha pra expandir/recolher.

Depois de colar, rode pelo menu **BouwObra → ➕ Adicionar Anúncio**.

---

## Análise de Vendas (local)

### `dashboard_vendas/server.py`
Painel local (única dependência extra: `openpyxl`, já usada no resto do
projeto) pra analisar vendas de um produto ou família de variações do
Mercado Livre. Cada busca **soma** à lista em vez de substituir — dá pra
combinar vários produtos diferentes numa mesma análise. Não cruza com custo
(Cache NF) — só dados brutos de venda (preço, taxa ML, quantidade, status)
por pedido. Chamadas ao ML paralelizadas (`_MAX_WORKERS=8`) — família de 64
itens caiu de 146s pra ~33s.

**Cache de pedidos por dia** (`dashboard_vendas/cache/AAAA-MM-DD.json`, já no
`.gitignore` genérico `cache/`): os pedidos ficam cacheados por dia civil,
sem filtro de item — um único cache serve busca por MLB, Family e "todos os
produtos" (pra MLB/Family, filtra localmente em memória em vez de chamar a
API de novo). Hoje nunca é lido do cache (sempre busca ao vivo); dias
passados ficam cacheados pra sempre. Repetir a mesma busca reaproveita tudo
que já foi buscado antes, mesmo em período diferente que se sobreponha.

**Cache de SKU/título e tarifa de envio** (`cache/skus.json`,
`cache/fretes.json` — chaveados por `item_id`/`shipping_id`, sem expiração,
já que são fatos historicamente estáveis): busca de família de 64 itens caiu
de ~40s pra ~10s na repetição com os 3 caches (pedidos + SKU + frete) já
quentes.

```bash
python dashboard_vendas/server.py
# abre http://localhost:8765 automaticamente
```

**Aceita na busca:**
- **MLB ID** (ex: `MLB4551359415`) → vendas só desse anúncio.
- **Family ID** (14+ dígitos, ex: `5135813632757073`) → resolve todas as
  variações (`user_products_ids`) e soma as vendas de **todos** os item_ids
  de cada uma — inclusive anúncios fechados/migrados, onde o histórico de
  venda muitas vezes fica (o anúncio ativo pode mostrar 0 vendas mesmo tendo
  vendido bastante antes de ser migrado).
- **SKU** (código do vendedor, ex: `10034034166838`) → resolve via
  `search_by_sku` (já existente em `connectors/mercadolivre/client.py`) pra
  todos os MLB IDs associados — mesma lógica de não perder anúncio
  fechado/migrado. Só é tentado se a entrada não bater como MLB nem como
  Family (SKUs desse projeto costumam ter 14 dígitos, mesmo tamanho de um
  Family ID, então Family é sempre tentado primeiro).
- **Campo vazio** → busca todos os produtos vendidos no período escolhido
  (busca os pedidos direto por data, sem resolver item primeiro). Exige um
  filtro específico — não funciona com "Todos", que buscaria o histórico
  inteiro do vendedor (34 mil+ pedidos).

**Filtro de período** (aplicado direto na chamada ao ML, não busca tudo pra
filtrar depois): Todos · Hoje · Últimos 7 dias · Este mês · Mês específico
(limitado aos últimos 3 meses, incluindo o atual).

**Exportar:** botão "⬇ Baixar Excel" no final da tabela — gera um `.xlsx`
real (via `openpyxl`) com tudo que estiver acumulado na lista.

**Tarifa de envio:** cada pedido traz também o frete cobrado do vendedor
("Mercado Envios, por sua conta") via `GET /shipments/{id}/costs` — bate
com a tela de detalhe do pedido no próprio ML. Custa 1 chamada extra por
pedido (deduplicada por `shipping.id` e paralelizada).

**Pacotes (múltiplos pedidos, 1 envio só):** quando um comprador leva produtos
diferentes no mesmo carrinho, o ML cria um pedido separado por produto,
todos compartilhando o mesmo `pack_id` e o mesmo envio. A coluna "Pacote"
mostra isso (com selo 📦 quando há mais de 1 pedido no mesmo pacote na lista
atual) — e o resumo/soma de frete deduplica por `shipping_id`, senão contaria
o mesmo frete 2x por engano.

---

*Atualizado sempre que um novo script é criado.*
