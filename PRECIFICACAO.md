# Contexto de Precificação — BouwObra

Este documento explica **como os dados são obtidos e como a margem é calculada**
na aba "Precificação" da planilha (Apps Script). É o mesmo cálculo que existe
em `services/precificacao_service.py` (Python) — hoje as duas implementações
têm exatamente a mesma fórmula, mas quem roda em produção é o Apps Script
(`apps_script/05_Precificacao.gs`), acionado pelo menu BouwObra ou pelo
trigger diário. O Python é mantido só como referência/histórico de validação.

## Onde cada coisa está implementada

| Camada | Arquivo |
|---|---|
| Constantes/config | `apps_script/01_Config.gs` (produção) · `config.json` + `services/precificacao_service.py` (Python) |
| Cálculo da linha | `apps_script/05_Precificacao.gs` → `calcularLinha()` (produção) · `services/precificacao_service.py` → `calcular_linha()` (Python) |
| Chamadas à API do ML | `apps_script/04_MlApi.gs` (produção) · `connectors/mercadolivre/client.py` + `orders.py` (Python) |
| Chamadas à API do Tiny / NF | `apps_script/03_TinyApi.gs` (produção) · `connectors/tiny/nf.py` + `services/custo_service.py` (Python) |
| Agrupamento por Family ID | `apps_script/09_AdicionarAnuncio.gs` → `_construirBlocoGrupo()` |

**Atenção a uma pegadinha**: `services/precificacao_service.py` tem
`icms_venda_pct: float = 0.12` como *default do parâmetro da função* (12%),
mas na prática sempre é chamado passando o valor de `config.json` →
`icms_venda_pct: 18.0` (18%). O Apps Script usa direto a constante
`ICMS_VENDA = 0.18` (`01_Config.gs`). **Hoje os dois batem em 18%** — mas se
algum dia alguém chamar `calcular_linha()` no Python sem passar esse
parâmetro explicitamente, o resultado diverge silenciosamente do Apps Script.

---

## 1. Kit, variação e produto pai — o que o código realmente distingue

Importante desfazer uma expectativa: **não existe nenhuma lógica de soma de
custo de componentes de um kit (BOM)** em nenhum lugar do código. O que existe
é mais simples:

- No Tiny ERP, `GET /produtos/{id}` retorna um campo `variacoes` (array).
  **Qualquer produto cujo `variacoes` não seja vazio é tratado como "kit"** —
  é literalmente `is_kit = bool(variacoes)` (`connectors/tiny/connector.py`).
  O Tiny não diferencia, nesse campo, entre:
  - um "kit" de fato (produto composto por outros SKUs vendidos juntos), e
  - um "produto pai com variações" (mesma peça em tamanhos/cores diferentes).

  Os dois casos chegam com a mesma forma de JSON (`variacoes: [...]`) e são
  tratados de forma idêntica pelo código — não há bifurcação.
- Cada item dentro de `variacoes` já vem como um dict "achatado" com o campo
  `sku` direto (formato do Tiny v3). Cada uma dessas SKUs de variação é
  tratada, pra fins de custo, **exatamente como um produto simples**: tem seu
  próprio histórico de Notas Fiscais de entrada no Tiny, e o custo dela é
  resolvido individualmente por esse histórico (seção 4). Não existe "somar
  o custo dos componentes" — cada variação/SKU já tem seu próprio custo de
  compra registrado.
- O campo Tiny `tipo` (ex: `V` = variação) existe no retorno da API e é
  guardado em metadata, mas **não é usado para nenhuma decisão** no código
  hoje — quem decide é só `bool(variacoes)`.
- Na planilha de validação de SKUs (`scripts/validate_skus.py` /
  equivalente Apps Script), um "kit"/produto-com-variações fica marcado:
  - 🟠 laranja = tem variações com anúncio ativo no ML
  - 🔴 vermelho escuro = nenhuma variação achada ativa/pausada/fechada no ML

Ou seja: quando você vê "kit" nesse projeto, leia como **"produto do Tiny com
mais de uma variação cadastrada"**, não como "kit de componentes".

---

## 2. Family ID, UPs (User Products) e agrupamento de variações no ML

Esses conceitos são do lado do **Mercado Livre**, e são um eixo totalmente
separado do "kit" do Tiny (seção 1) — não se relacionam diretamente.

- **User Product (UP)**: representa o produto do vendedor no catálogo do ML,
  independente de qual anúncio específico está vendendo ele agora (um UP pode
  ter tido vários MLB IDs diferentes ao longo do tempo, por causa de migrações
  de anúncio). Endpoint: `GET /users/{seller_id}/user_products?item_id={MLB}`.
  **Limitação**: só funciona pra item com status `active`; pra item `closed`/
  migrado, retorna vazio.
- **Family ID (= `item_group_id`)**: agrupa as variações de um mesmo anúncio
  "pai" no ML (ex: mesma peça em cores diferentes, cada cor com seu próprio
  MLB, todas compartilhando um Family ID).
  - Endpoint principal: `GET /sites/MLB/user-products-families/{familyId}` →
    devolve `user_products_ids[]`, um UP por variação.
  - Cada `user_product_id` é resolvido pro MLB ID **ativo** via
    `GET /users/{seller}/items/search?user_product_id={upId}`. Quando essa
    busca retorna 2 itens pra mesma UP (o anúncio antigo fechado por migração
    + o atual), o código prioriza por status: `active > paused > closed`.
  - Fallback se o endpoint de família falhar: varre **todos** os itens do
    vendedor (`search_type=scan` + `scroll_id` em `/users/{uid}/items/search`)
    filtrando manualmente por `family_id` item a item — porque a API do ML
    **ignora** o parâmetro `family_id` quando passado direto na busca.
  - Caminho alternativo que funciona direto: `GET /users/{user_id}/items/search?item_group_id={id}`.
- **Migração de anúncio**: quando o ML migra um anúncio simples pra modelo de
  variações, o item antigo fica `status: closed` com tag
  `variations_migration_source`, e os novos itens ganham tag
  `variations_migration_uptin`. Endpoint pra rastrear isso:
  `GET /items/{MLB_ANTIGO}/migration_live_listing` →
  `{"new_items": [{"variation_id", "new_item_id", "migration_status"}]}`.
- **Uso na precificação**: quando você adiciona um Family ID na planilha
  (em vez de um MLB individual), o sistema resolve todas as variações e monta
  uma **linha "pai" (GRUPO {familyId})** + N linhas de variação abaixo,
  agrupadas visualmente. A linha pai é a **média aritmética simples** de
  todas as colunas numéricas (preço, taxa, margem etc.) das variações — não é
  soma, é média.

---

## 3. Impostos — quais entram e as alíquotas exatas

Regime: **Lucro Real**. Dois grupos de impostos, que **não se misturam**:
impostos de **venda** (recalculados agora, por alíquota) e créditos de
**compra** (vêm prontos da Nota Fiscal de entrada, valor absoluto já apurado).

### 3.1 Impostos de venda (recalculados sobre o preço praticado)

Alíquotas fixas (`apps_script/01_Config.gs` / `services/precificacao_service.py`):

```
ICMS_VENDA   = 18%
PIS_VENDA    = 1,65%
COFINS_VENDA = 7,60%
```

**Regra importante**: no Lucro Real, PIS/COFINS de venda incidem sobre a
receita **já líquida de ICMS**, não sobre o preço cheio:

```
icms_venda      = preco_praticado * 18%
base_pis_cofins = preco_praticado − icms_venda
pis_venda       = base_pis_cofins * 1,65%
cofins_venda    = base_pis_cofins * 7,60%
```

### 3.2 Crédito de PIS/COFINS sobre comissão do ML + frete de venda

Confirmado com a contadora (Jéssica, Bouwobra Contabilidade) em 2026-06-12,
formalizado internamente: comissão do Mercado Livre e frete de venda
(Mercado Envios/Full) **geram crédito de PIS/COFINS** no Lucro Real:

```
comissao_frete           = comissao_ml + frete_R$
credito_pis_com_frete    = comissao_frete * 1,65%
credito_cofins_com_frete = comissao_frete * 7,60%
```

Esses créditos **somam** na margem (entram como positivo), do mesmo jeito que
o Imposto Recuperável do lado de compra (seção 3.3). São uma **estimativa**
calculada antes da venda, sobre a comissão/frete estimados via API do ML — o
valor real que a contabilidade lança na apuração de PIS/COFINS
(EFD-Contribuições) vem das NFS-e que o ML emite (capturadas via portal
nacional de NFS-e) e do CT-e do frete, não dessa estimativa.

### 3.3 Créditos de compra (Imposto Recuperável) — vêm da Nota Fiscal, não de alíquota

Diferente dos impostos de venda, aqui **não se recalcula nada por
percentual** — os valores vêm prontos, já apurados, de dentro da própria NF
de entrada daquele SKU (ver endpoints na seção 4):

```
custo_base       = valorUnitario do item na NF (sem IPI), por unidade
ipi_valor        = ipi.valorImposto / quantidade
icms_credito     = icms.valorImposto / quantidade   (0 se for Substituição Tributária)
pis_credito      = pis.valorImposto / quantidade
cofins_credito   = cofins.valorImposto / quantidade

custo_com_ipi       = custo_base + ipi_valor
imposto_recuperavel = icms_credito + pis_credito + cofins_credito
```

`imposto_recuperavel` é a coluna "Imposto Recuperável" da planilha, e entra
como crédito (positivo) na margem.

---

## 4. Nota Fiscal (NF) no Tiny ERP — endpoints e uso

Base URL: `https://erp.tiny.com.br/public-api/v3`. Token OAuth2 via
`https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token`.
Implementação de referência: `connectors/tiny/nf.py` (espelhado em
`apps_script/03_TinyApi.gs`).

A NF aqui **só é usada pra custo de compra e créditos de compra** — nunca pra
calcular impostos de venda (esses são recalculados por alíquota, seção 3.1).

Chamadas, na ordem:

1. `GET /notas?tipo=E&limit=100&offset=N&dataInicial=...&dataFinal=...` —
   lista as NFs de **entrada** (`tipo=E` = compra). Não filtra por
   `situacao` (Autorizada) de propósito, pra capturar também notas ainda em
   processamento.
2. `GET /notas/{id}` — detalhe da NF: `itens[]` com `idItem`, `idProduto`,
   `codigo`, `quantidade`, `valorUnitario`, `descricao`.
3. `GET /notas/{idNota}/itens/{idItem}` — impostos detalhados de cada item:
   `ipi.valorImposto`, `icms.valorImposto`, `pis.valorImposto`,
   `cofins.valorImposto`.
4. `GET /produtos/{idProduto}` — resolve `idProduto → SKU atual`, porque o
   campo `codigo` de um item de NF pode ser um código antigo/do fornecedor,
   diferente do SKU vigente hoje (ex real: NF com item "WPSRESENOINP46" →
   `idProduto` 991633087 → SKU atual "10034034168445").

Quando existe mais de uma NF pra mesmo SKU, **prevalece a mais recente**
(maior data de emissão). O resultado fica em cache (`cache/nf_custo.json`
no lado Python; equivalente em Apps Script) pra não reconsultar tudo de novo
a cada recálculo.

---

## 5. Redução de Tarifa (RT) do Mercado Livre

RT = parte da comissão do ML **bancada pelo próprio Mercado Livre** dentro de
promoções do tipo SMART ("Meli Essencial" e afins).

- Fonte: `GET /seller-promotions/items/{mlb_id}?app_version=v2` — procura uma
  promoção com `"status": "started"` cujo `price` bata (arredondado a
  centavos) com o preço praticado. O campo relevante é `meli_percentage`.
- Cálculo (multiplica pelo **preço base**, não pelo preço praticado):
  ```
  rt_valor = round(preco_base * meli_percentage / 100, 2)
  ```
- Sempre marcado como "incerto" quando há bônus, porque a API só expõe
  `meli_percentage` arredondado a 1 casa decimal — o valor calculado pode
  diferir alguns centavos do exibido no painel do ML.
- **RT reduz a comissão em R$ diretamente** (não é ponto percentual a menos
  na alíquota):
  ```
  comissao_ml    = preco_praticado * taxa_pct / 100 − rt_valor
  comissao_frete = comissao_ml + frete_R$
  ```

---

## 6. Preço praticado, taxa ML e frete — de onde vêm

- **Preço praticado (promoção ativa)**: `GET /items/{id}/prices` → filtra
  `prices[]` com `type == "promotion"`, cujo `conditions.context_restrictions`
  contenha `"channel_marketplace"`, dentro da janela `start_time`/`end_time`
  vigente. Usa o **menor** valor entre as promoções válidas; se nenhuma
  válida, usa o preço base do anúncio.
- **Taxa/comissão ML real**: `GET /sites/MLB/listing_prices?price=...&category_id=...`,
  filtrando o resultado pelo `listing_type_id` do próprio anúncio (Clássico
  ≈ 12%, Premium ≈ 17%+). Campos usados: `sale_fee_amount` (R$) e
  `percentage_fee` (%). O endpoint dedicado `GET /users/{id}/items/{id}/fees`
  está quebrado (sempre retorna `{}`) — por isso o uso do endpoint de
  `listing_prices` como alternativa. Fallback (marcado "incerto") usa a
  constante `ML_TAXA_DEFAULT = 12%` quando a consulta real falha.
- **Frete real pago pelo vendedor (Full/Mercado Envios)**:
  `GET /users/{seller}/shipping_options/free?item_id={id}` → campo
  `coverage.all_country.list_cost`. Em anúncios Full, esse custo é cobrado do
  vendedor mesmo quando o frete aparece "grátis" pro comprador.

---

## 7. Fórmula completa da margem líquida

```
margem_R$ =
    preco_praticado
  − comissao_frete              (= preco*taxa_pct/100 − rt_valor + frete_R$)
  − icms_venda                  (= preco_praticado * 18%)
  − pis_venda                   (= (preco_praticado − icms_venda) * 1,65%)
  − cofins_venda                 (= (preco_praticado − icms_venda) * 7,60%)
  − custo_nf                    (= custo_base_NF + IPI, da NF de compra)
  + imposto_recuperavel          (= ICMS_credito + PIS_credito + COFINS_credito, da NF de compra)
  + credito_pis_com_frete        (= comissao_frete * 1,65%)
  + credito_cofins_com_frete     (= comissao_frete * 7,60%)

margem_% = margem_R$ / preco_praticado * 100
```

**Coloração da margem**: ≥ 20% verde · 10–20% amarelo · < 10% vermelho.

**Colunas crédito (verde) vs débito (vermelho)** na planilha, independente da
cor da margem:
- Crédito: RT, PIS/COFINS crédito s/comissão+frete, ICMS/PIS/COFINS crédito
  de compra, Imposto Recuperável.
- Débito: Frete, ICMS/PIS/COFINS de venda, Comissão+Frete, Custo NF.

Extra (só na coluna "Taxa ML %", sem relação com a cor da margem): < 14%
laranja-claro (típico de anúncio Clássico ~12%), ≥ 14% azul-claro (típico de
Premium ~17%+).

---

## 8. O que NÃO existe / limitações conhecidas

- Sem agregação de custo de componentes de kit (BOM) — cada SKU/variação tem
  seu próprio custo individual vindo da NF (seção 1).
- Sem comparação automática entre a estimativa de crédito PIS/COFINS
  (calculada na precificação) e o valor real apurado na contabilidade via
  NFS-e/CT-e — seriam integrações separadas, fora do escopo atual.
- `GET /users/{id}/items/{id}/fees` (endpoint "oficial" de tarifas) está
  quebrado — usa-se `listing_prices` como alternativa.
- RT é sempre uma estimativa "incerta" (arredondamento de 1 casa decimal na
  API do ML), nunca o valor exato que sai no extrato.
