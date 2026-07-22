// ============================================================
// 05_Precificacao.gs — Cálculos e escrita da aba Precificação
// ============================================================

// ── Fórmulas Lucro Real ───────────────────────────────────────────────────────
//
// mlData (quando existe o anúncio) traz: mlbId, title, categoryId, status,
// price (preço BASE), precoPraticado (preço vigente agora, com promoção se
// houver — usado em todo o cálculo abaixo), taxaPct/taxaRs, freteRs, rtValor
// (bônus Meli em R$) e as flags *_incerto (fallback/estimativa, não confirmado
// pela API — vira laranja na coloração).
//
// Retorna [row, uncertainCols] — uncertainCols são índices de coluna (0-based)
// com valor estimado/não confirmado.

function calcularLinha(sku, mlData, custoData, timestamp) {
  const precoBase = mlData ? (parseFloat(mlData.price) || 0) : 0;
  const preco      = mlData ? (parseFloat(mlData.precoPraticado != null ? mlData.precoPraticado : precoBase) || 0) : 0;
  const taxaPct    = mlData ? (parseFloat(mlData.taxaPct) || 0) : 0;
  const freteRs    = mlData ? (parseFloat(mlData.freteRs) || 0) : 0;
  const rtValor    = mlData ? (parseFloat(mlData.rtValor) || 0) : 0;
  const mlbId      = mlData ? (mlData.mlbId || '') : '';
  const title      = mlData ? (mlData.title || '') : '';
  const category   = mlData ? (mlData.categoryId || '') : '';
  const status     = mlData ? (mlData.status || '') : '';

  // Comissão ML — RT é um bônus da Meli que reduz a comissão diretamente em R$
  // (não é ponto percentual), calculada sobre o preço praticado
  const comissaoMl    = _r2(preco * taxaPct / 100 - rtValor);
  const comissaoFrete = _r2(comissaoMl + freteRs);

  // Débitos fiscais sobre venda — PIS/COFINS incidem sobre a receita já líquida de ICMS (Lucro Real)
  const icmsVenda      = _r2(preco * ICMS_VENDA);
  const basePisCofins  = preco - icmsVenda;
  const pisVenda       = _r2(basePisCofins * PIS_VENDA);
  const cofinsVenda    = _r2(basePisCofins * COFINS_VENDA);

  // Crédito de PIS/COFINS sobre comissão+frete — confirmado com a contadora
  // (12/06/2026): despesas de venda (comissão de intermediação + frete na
  // operação de venda) geram crédito no Lucro Real, mesma alíquota da venda.
  const creditoPisComFrete    = _r2(comissaoFrete * PIS_VENDA);
  const creditoCofinsComFrete = _r2(comissaoFrete * COFINS_VENDA);

  // Custo e créditos fiscais da compra — valores absolutos da NF
  let custoNf = 0, icmsCred = 0, pisCred = 0, cofinsCred = 0, impRecup = 0;
  if (custoData) {
    const custoBase     = parseFloat(custoData.custoBase)     || 0;
    const ipiValor      = parseFloat(custoData.ipiValor)      || 0;
    const icmsCredito   = parseFloat(custoData.icmsCredito)   || 0;
    const pisCredito    = parseFloat(custoData.pisCredito)    || 0;
    const cofinsCredito = parseFloat(custoData.cofinsCredito) || 0;
    custoNf    = _r2(custoBase + ipiValor);
    icmsCred   = _r2(icmsCredito);
    pisCred    = _r2(pisCredito);
    cofinsCred = _r2(cofinsCredito);
    impRecup   = _r2(icmsCred + pisCred + cofinsCred);
  }

  // Margem
  const margemRs  = _r2(
    preco - comissaoFrete - icmsVenda - pisVenda - cofinsVenda - custoNf
    + impRecup + creditoPisComFrete + creditoCofinsComFrete
  );
  const margemPct = preco > 0 ? _r2(margemRs / preco * 100) : 0;

  const row = [
    mlbId || sku,      // A 0  ID ML
    sku,               // B 1  SKU
    title || sku,      // C 2  Nome
    category,          // D 3  Categoria
    _r2(precoBase),    // E 4  Preço Base
    _r2(preco),        // F 5  Preço Praticado (usado no cálculo acima)
    _r2(taxaPct),      // G 6  Taxa ML (%)
    _r2(rtValor),      // H 7  RT (R$)
    _r2(freteRs),      // I 8  Frete
    icmsVenda,         // J 9  ICMS Venda
    pisVenda,          // K 10 PIS Venda
    cofinsVenda,       // L 11 COFINS Venda
    comissaoFrete,     // M 12 Comissão + Frete
    creditoPisComFrete,    // N 13 PIS Crédito s/ Comissão+Frete
    creditoCofinsComFrete, // O 14 COFINS Crédito s/ Comissão+Frete
    custoNf,           // P 15 Custo NF c/ IPI
    icmsCred,          // Q 16 ICMS Compra crédito
    pisCred,           // R 17 PIS Compra crédito
    cofinsCred,        // S 18 COFINS Compra crédito
    impRecup,          // T 19 Imposto Recuperável
    margemRs,          // U 20 Margem Líquida (R$)
    margemPct,         // V 21 Margem Líquida (%)
    statusMl(status),  // W 22 Status Anúncio
    timestamp,         // X 23 Última Atualização
  ];

  const uncertainCols = [];
  if (mlData && mlData.promoIncerto)  uncertainCols.push(5);            // F — Preço Praticado
  if (mlData && mlData.feesIncerto) { uncertainCols.push(6); uncertainCols.push(12); uncertainCols.push(13); uncertainCols.push(14); } // G, M, N, O
  if (mlData && mlData.rtIncerto)     uncertainCols.push(7);            // H — RT
  if (mlData && mlData.freteIncerto) { uncertainCols.push(8); uncertainCols.push(12); uncertainCols.push(13); uncertainCols.push(14); } // I, M, N, O
  if (!custoData)                     uncertainCols.push(15);           // P — Custo NF

  return [row, uncertainCols];
}

function _r2(v) { return Math.round(v * 100) / 100; }

// ── Escrita na aba Precificação ───────────────────────────────────────────────

// Busca preço praticado (promoção), taxa ML, RT e frete real de um anúncio —
// reutilizado tanto pela sincronização completa quanto pela adição manual
// (09_AdicionarAnuncio.gs).
function montarMlDataCompleto(mlbId, title, status, categoryId, listingTypeId, price) {
  const promo = getPrecoPraticado(mlbId, price);
  const fees  = getMlItemFees(promo.precoPraticado, categoryId, listingTypeId);
  const bonus = getTaxaBonus(mlbId, price, promo.precoPraticado);
  const frete = getFreteEnvio(mlbId);

  return {
    mlbId, price, status, categoryId, title,
    precoPraticado: promo.precoPraticado,
    promoAtiva:     promo.promoAtiva,
    promoIncerto:   promo.incerto,
    taxaPct:    fees.taxaPct,
    taxaRs:     fees.taxaRs,
    feesIncerto: fees.incerto,
    rtValor:    bonus.rtValor,
    rtIncerto:  bonus.incerto,
    freteRs:    frete.freteRs,
    freteIncerto: frete.incerto,
  };
}

// Se o SKU tiver uma simulação de preço ativa (ver "Simulação de Preço"
// abaixo), substitui o preço praticado real do ML pelo simulado antes do
// cálculo — sem chamar a API de novo (taxa/RT/frete continuam os últimos
// sincronizados; só o preço muda, e as fórmulas da planilha reagem a isso).
function _aplicarOverridePreco(mlDataCompleto, sku, simulacoes) {
  const ov = mlDataCompleto ? simulacoes[sku] : null;
  if (ov) {
    mlDataCompleto.precoPraticado = ov.precoSimulado;
    mlDataCompleto.promoAtiva = true;
    mlDataCompleto.promoIncerto = false;
  }
  return mlDataCompleto;
}

function atualizarPrecificacao() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Iniciando Precificação...', 'BouwObra', -1);

  // 1. Lê cache de custos (deve já ter sido populado por atualizarCacheNF)
  const cacheNF = lerCacheNF();
  const nCached = Object.keys(cacheNF).length;
  ss.toast(`Cache NF: ${nCached} SKUs. Mapeando anúncios ML...`, 'BouwObra', -1);

  // 2. Mapeia SKU → dados do anúncio ML
  const skuMlbMap = buildSkuMlbMap();
  const nMl = Object.keys(skuMlbMap).length;
  const simulacoes = lerSimulacoesPreco(); // SKUs com preço praticado simulado manualmente
  ss.toast(`${nMl} anúncios ML mapeados. Calculando taxas e margens...`, 'BouwObra', -1);

  // 3. Une os conjuntos de SKUs (ML + Cache NF)
  const allSkus = new Set([...Object.keys(skuMlbMap), ...Object.keys(cacheNF)]);
  const timestamp = new Date().toLocaleString('pt-BR');
  const rows = [];
  const uncertainCols = [];

  allSkus.forEach(sku => {
    const mlData    = skuMlbMap[sku] || null;
    const custoData = cacheNF[sku]   || null;

    const mlDataCompleto = mlData
      ? _aplicarOverridePreco(montarMlDataCompleto(mlData.mlbId, mlData.title, mlData.status, mlData.categoryId, mlData.listingTypeId, mlData.price), sku, simulacoes)
      : null;

    const [row, cols] = calcularLinha(sku, mlDataCompleto, custoData, timestamp);
    rows.push(row);
    uncertainCols.push(cols);
  });

  // 4. Ordena por Margem % decrescente (mantendo uncertainCols alinhado)
  const ordem = rows.map((row, i) => ({ row, cols: uncertainCols[i] }))
    .sort((a, b) => (b.row[MARGEM_COL_IDX] || -999) - (a.row[MARGEM_COL_IDX] || -999));
  const rowsOrdenadas = ordem.map(o => o.row);
  const colsOrdenados = ordem.map(o => o.cols);

  // 5. Grava na aba
  let ws = ss.getSheetByName(ABA_PRECIFICACAO);
  if (!ws) ws = ss.insertSheet(ABA_PRECIFICACAO);

  ws.clearContents();
  ws.clearFormats();

  // Cabeçalho
  const hdrRange = ws.getRange(1, 1, 1, HEADERS_PREC.length);
  hdrRange.setValues([HEADERS_PREC]);
  hdrRange.setBackground('#1a1a2e');
  hdrRange.setFontColor('#ffffff');
  hdrRange.setFontWeight('bold');
  hdrRange.setHorizontalAlignment('center');

  // Dados — J,K,L,M,N,O,U,V vão como FÓRMULA (não valor), pra recalcular
  // sozinhas quando o Preço Praticado for editado direto na planilha.
  if (rowsOrdenadas.length) {
    const rowsParaGravar = rowsOrdenadas.map((row, i) => _paraFormulas(row, i + 2));
    ws.getRange(2, 1, rowsOrdenadas.length, HEADERS_PREC.length).setValues(rowsParaGravar);
    _colorirLinhas(ws, rowsOrdenadas, colsOrdenados);
    // A ordenação por margem muda a posição de cada SKU a cada sync — reaplica
    // a nota de simulação (se houver) na linha nova de cada um, e limpa a nota
    // de quem não estiver mais simulando.
    _aplicarNotasSimulacao(ws, rowsOrdenadas, simulacoes);
  }

  // Formatos de coluna
  _formatarColunas(ws, rowsOrdenadas.length);

  ws.setFrozenRows(1);
  ss.toast(`✅ Precificação atualizada: ${rowsOrdenadas.length} produtos.`, 'BouwObra', 8);
}

// Status Anúncio — mesma paleta de scripts/validate_skus.py (Verde/Cinza/Vermelho/Azul)
const _STATUS_CORES = {
  'Ativo':   '#d4edda',
  'Pausado': '#e2e3e5',
  'Fechado': '#f8d7da',
  'Migrado': '#cce5ff',
};

// Cor de UMA linha — reutilizado pela sincronização completa (em lote) e pela
// adição manual de anúncio/grupo (09_AdicionarAnuncio.gs, linha a linha).
function _coresParaLinha(row, uncertainColsRow) {
  const nCols = HEADERS_PREC.length;
  const linha = new Array(nCols).fill(null); // null = sem cor (padrão)

  CREDITO_COLS.forEach(col => { linha[col] = '#d4edda'; });
  DEBITO_COLS.forEach(col => { linha[col] = '#f8d7da'; });

  const margem = parseFloat(row[MARGEM_COL_IDX]) || 0;
  const corMargem = margem >= 20 ? '#d4edda' : margem >= 10 ? '#fff3cd' : '#f8d7da';
  MARGEM_COLS.forEach(col => { linha[col] = corMargem; });

  const corStatus = _STATUS_CORES[row[STATUS_COL_IDX]];
  if (corStatus) linha[STATUS_COL_IDX] = corStatus;

  (uncertainColsRow || []).forEach(col => { linha[col] = '#ffa500'; });

  return linha;
}

// Aplica a validação de dropdown (menu suspenso) da coluna de status a um
// intervalo de linhas — reutilizado pela sincronização completa e pela adição manual.
function _aplicarDropdownStatus(ws, startRow, nRows) {
  const regra = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  ws.getRange(startRow, STATUS_COL_IDX + 1, nRows, 1).setDataValidation(regra);
}

// Coloração: crédito (verde) e débito (vermelho) fixos por coluna, margem por
// faixa de desempenho, status por valor, laranja por cima nas células com
// valor incerto/estimado. Um único setBackgrounds() sobre a área inteira —
// evita milhares de chamadas individuais (lento e sujeito a limite de
// execução do Apps Script).
function _colorirLinhas(ws, rows, uncertainCols) {
  const bg = rows.map((row, i) => _coresParaLinha(row, uncertainCols[i]));
  ws.getRange(2, 1, rows.length, HEADERS_PREC.length).setBackgrounds(bg);
  _aplicarDropdownStatus(ws, 2, rows.length);
}

// Formatos numéricos
function _formatarColunas(ws, nRows) {
  if (nRows < 1) return;
  const R$ = '"R$"#,##0.00';
  const PCT = '#,##0.00"%"';

  // Preço Base + Praticado (E..F) → R$
  ws.getRange(2, 5, nRows, 2).setNumberFormat(R$);
  // Taxa ML % (G)
  ws.getRange(2, 7, nRows, 1).setNumberFormat(PCT);
  // RT..Margem R$ (H..U) → R$
  ws.getRange(2, 8, nRows, 14).setNumberFormat(R$);
  // Margem % (V)
  ws.getRange(2, 22, nRows, 1).setNumberFormat(PCT);

  // Colunas de texto
  ws.setColumnWidth(1, 140);  // A ID ML
  ws.setColumnWidth(2, 90);   // B SKU
  ws.setColumnWidth(3, 220);  // C Nome
  ws.setColumnWidth(4, 120);  // D Categoria
  ws.autoResizeColumns(23, 2);// W..X (Status, Última Atualização)
}

// ── Simulação de Preço Praticado (promoção manual) ──────────────────────────
//
// Editar a coluna F (Preço Praticado) direto na planilha simula uma promoção.
// J,K,L,M,N,O,U,V (impostos de venda, comissão+frete e margem — tudo que NÃO
// depende do custo de compra) são gravadas como FÓRMULA nativa do Sheets
// (ver _paraFormulas), então recalculam na hora, sem precisar de script. Taxa
// ML/RT/Frete (G,H,I) continuam como valor fixo (do último sync) — não são
// re-buscadas na API a cada edição.
//
// O onEdit (trigger simples, abaixo) só salva o preço original a primeira
// vez que a célula é editada, guardando numa aba oculta (mesmo padrão do
// Cache NF) — isso é o que permite: (1) sobreviver a uma "Sincronizar Tudo"
// completa, que reescreve a aba inteira do zero, e (2) reverter pro preço
// real do ML depois (restaurarPrecoOriginalSelecionadas).

function lerSimulacoesPreco() {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABA_SIMULACAO_PRECO);
  if (!ws || ws.getLastRow() < 2) return {};
  const dados = ws.getRange(2, 1, ws.getLastRow() - 1, HEADERS_SIMULACAO_PRECO.length).getValues();
  const map = {};
  dados.forEach(row => {
    const sku = String(row[0]).trim();
    if (!sku) return;
    map[sku] = {
      precoOriginal: parseFloat(row[1]) || 0,
      precoSimulado: parseFloat(row[2]) || 0,
      data: String(row[3] || ''),
    };
  });
  return map;
}

// Grava (ou atualiza, se o SKU já estiver simulando) o preço simulado de um
// SKU. precoOriginal só é usado na primeira vez — edições seguintes do mesmo
// SKU mantêm o original já salvo (ver onEdit).
function _gravarSimulacaoPreco(sku, precoOriginal, precoSimulado) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(ABA_SIMULACAO_PRECO);
  if (!ws) {
    ws = ss.insertSheet(ABA_SIMULACAO_PRECO);
    ws.hideSheet();
    ws.getRange(1, 1, 1, HEADERS_SIMULACAO_PRECO.length).setValues([HEADERS_SIMULACAO_PRECO]);
  }

  const lastRow = ws.getLastRow();
  let targetRow = lastRow + 1;
  if (lastRow >= 2) {
    const skus = ws.getRange(2, 1, lastRow - 1, 1).getValues().map(r => String(r[0]));
    const idx = skus.indexOf(sku);
    if (idx >= 0) targetRow = idx + 2;
  }

  const agora = new Date().toLocaleString('pt-BR');
  ws.getRange(targetRow, 1, 1, HEADERS_SIMULACAO_PRECO.length)
    .setValues([[sku, precoOriginal, precoSimulado, agora]]);
}

function _removerSimulacaoPreco(sku) {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABA_SIMULACAO_PRECO);
  if (!ws || ws.getLastRow() < 2) return;
  const skus = ws.getRange(2, 1, ws.getLastRow() - 1, 1).getValues().map(r => String(r[0]));
  const idx = skus.indexOf(sku);
  if (idx >= 0) ws.deleteRow(idx + 2);
}

// Texto da nota (comentário) exibida ao passar o mouse na célula de Preço
// Praticado de uma linha com simulação ativa. ov = entrada de lerSimulacoesPreco().
function _textoNotaSimulacao(ov) {
  if (!ov) return '';
  return `🔶 Simulação ativa — preço original: R$ ${ov.precoOriginal.toFixed(2)} (desde ${ov.data}).\n`
       + `Menu "↩️ Restaurar Preço Original" volta ao preço real do ML.`;
}

// Reaplica a nota de simulação (coluna F) pra um conjunto de linhas já
// gravadas, na ordem em que aparecem em `rows` — usado depois da reordenação
// por margem no sync completo, já que a posição de cada SKU muda a cada vez.
function _aplicarNotasSimulacao(ws, rows, simulacoes) {
  if (!rows.length) return;
  const notas = rows.map(row => [_textoNotaSimulacao(simulacoes[row[1]])]);
  ws.getRange(2, 6, rows.length, 1).setNotes(notas);
}

// Substitui, num row já calculado por calcularLinha, as colunas que dependem
// só do preço de venda (não do custo de compra) por FÓRMULA nativa do Sheets
// referenciando a própria linha (sheetRow = número real da linha na aba).
// Assim, editar o Preço Praticado (F) recalcula tudo isso na hora, sem
// precisar de script. G (Taxa ML %), H (RT) e I (Frete) continuam valor fixo
// — vêm do último sync, não são recalculados por fórmula.
//
// A planilha está no locale pt_BR: o separador decimal é vírgula (não ponto),
// e por isso o separador de argumentos de função também precisa ser ";"
// (não ","), senão o Sheets não consegue distinguir "0,18" de dois argumentos
// "0" e "18" — dá #ERROR! ("O separador de casas decimais é a vírgula (,),
// e não o ponto (.)").
function _paraFormulas(row, sheetRow) {
  const r = sheetRow;
  const nova = row.slice();
  const icms   = String(ICMS_VENDA).replace('.', ',');
  const pis    = String(PIS_VENDA).replace('.', ',');
  const cofins = String(COFINS_VENDA).replace('.', ',');
  nova[9]  = `=ROUND(F${r}*${icms};2)`;                                          // J ICMS Venda
  nova[10] = `=ROUND((F${r}-J${r})*${pis};2)`;                                  // K PIS Venda
  nova[11] = `=ROUND((F${r}-J${r})*${cofins};2)`;                               // L COFINS Venda
  nova[12] = `=ROUND(F${r}*G${r}/100-H${r}+I${r};2)`;                           // M Comissão + Frete
  nova[13] = `=ROUND(M${r}*${pis};2)`;                                          // N PIS Crédito s/ Comissão+Frete
  nova[14] = `=ROUND(M${r}*${cofins};2)`;                                       // O COFINS Crédito s/ Comissão+Frete
  nova[20] = `=ROUND(F${r}-M${r}-J${r}-K${r}-L${r}-P${r}+T${r}+N${r}+O${r};2)`;  // U Margem Líquida (R$)
  nova[21] = `=IF(F${r}>0;ROUND(U${r}/F${r}*100;2);0)`;                        // V Margem Líquida (%)
  return nova;
}

// Trigger SIMPLES de onEdit — não precisa de instalação/autorização extra
// porque só lê/escreve na própria planilha (nada de UrlFetchApp): salva o
// preço original a primeira vez que a célula é editada. O recálculo em si
// (taxa/débitos/margem) é automático, feito pelas fórmulas de _paraFormulas —
// esse trigger só cuida de guardar o ponto de partida pra poder reverter.
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    if (sheet.getName() !== ABA_PRECIFICACAO) return;
    if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return; // só edição de 1 célula

    const row = e.range.getRow();
    const col = e.range.getColumn();
    if (row < 2 || col !== 6) return; // só coluna F (Preço Praticado), fora do cabeçalho

    const colA = String(sheet.getRange(row, 1).getValue() || '').trim();
    if (!colA.toUpperCase().startsWith('MLB')) return; // ignora linha "pai" de grupo (é média, não 1 anúncio)

    const sku = String(sheet.getRange(row, 2).getValue() || '').trim();
    if (!sku) return;

    const novoPreco = parseFloat(e.value);
    if (!novoPreco || novoPreco <= 0) return; // limpar a célula não inicia simulação — use "Restaurar Preço Original"

    const precoAnterior = (e.oldValue !== undefined && e.oldValue !== '')
      ? parseFloat(e.oldValue)
      : (parseFloat(sheet.getRange(row, 5).getValue()) || 0); // sem valor anterior: usa Preço Base

    // Preço original: preserva o já salvo se essa SKU já estiver em simulação
    // (edições seguidas simulam preços diferentes sem perder o ponto de partida real).
    const existente = lerSimulacoesPreco()[sku];
    const precoOriginal = existente ? existente.precoOriginal : precoAnterior;
    _gravarSimulacaoPreco(sku, precoOriginal, novoPreco);

    const agora = new Date().toLocaleString('pt-BR');
    sheet.getRange(row, 6).setNote(_textoNotaSimulacao({ precoOriginal, data: agora }));
  } catch (err) {
    Logger.log('Erro onEdit (simulacao de preco): ' + (err && err.stack));
  }
}

// Remove a simulação das linhas selecionadas na Precificação e recalcula com
// o preço REAL vigente no ML (não necessariamente igual ao "preço original"
// salvo, se o preço do anúncio mudou nesse meio-tempo).
function restaurarPrecoOriginalSelecionadas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(ABA_PRECIFICACAO);
  const abaAtiva = ss.getActiveSheet();

  if (!ws || abaAtiva.getName() !== ABA_PRECIFICACAO) {
    ss.toast('Selecione linha(s) na aba Precificação primeiro.', 'BouwObra', 8);
    return;
  }
  const sel = ss.getActiveRange();
  if (!sel) {
    ss.toast('Nenhuma linha selecionada.', 'BouwObra', 6);
    return;
  }

  const r0 = Math.max(sel.getRow(), 2);
  const r1 = sel.getRow() + sel.getNumRows() - 1;
  const simulacoes = lerSimulacoesPreco();
  let restaurados = 0;

  for (let r = r0; r <= r1; r++) {
    const colA = String(ws.getRange(r, 1).getValue() || '').trim();
    if (!colA.toUpperCase().startsWith('MLB')) continue;
    const sku = String(ws.getRange(r, 2).getValue() || '').trim();
    if (!sku || !simulacoes[sku]) continue;

    _removerSimulacaoPreco(sku);
    _adicionarAnuncioIndividual(colA.toUpperCase());
    restaurados++;
  }

  ss.toast(restaurados
    ? `✅ ${restaurados} preço(s) restaurado(s) ao valor real do ML.`
    : 'Nenhuma linha selecionada tinha simulação ativa.', 'BouwObra', 8);
}

// ── Suporte ao sidebar HTML de busca (BuscaPrecificacao.html) ────────────────

function mostrarBuscaPrecificacaoSidebar() {
  const tmpl = HtmlService.createTemplateFromFile('BuscaPrecificacao');
  tmpl.modo = 'sidebar';
  const html = tmpl.evaluate().setTitle('🔍 Buscar Produto');
  SpreadsheetApp.getUi().showSidebar(html);
}

// Lê a aba Precificação já sincronizada e devolve uma lista enxuta para o
// sidebar filtrar no cliente por nome, MLB ou SKU (sem recalcular nada).
//
// Reconhece os blocos "GRUPO {familyId}" gravados por 09_AdicionarAnuncio.gs
// (linha pai com a média das variações + linhas de variação logo abaixo,
// nativamente agrupadas via shiftRowGroupDepth) e devolve o pai com um
// array `filhos` — o sidebar exibe isso como um item expansível, igual ao
// [+]/[-] que já existe no próprio Sheets para esses blocos.
function getPrecificacaoListaBusca() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(ABA_PRECIFICACAO);
  if (!ws || ws.getLastRow() < 2) return [];

  const nRows = ws.getLastRow() - 1;
  const dados = ws.getRange(2, 1, nRows, HEADERS_PREC.length).getValues();

  const paraItem = (row, linha) => ({
    linha,                                       // linha real na planilha (1-based)
    mlbId: String(row[0] || ''),                 // A
    sku: String(row[1] || ''),                   // B
    nome: String(row[2] || ''),                  // C
    categoria: String(row[3] || ''),              // D
    precoPraticado: Number(row[5]) || 0,          // F
    margemPct: Number(row[MARGEM_COL_IDX]) || 0,  // V
    status: String(row[STATUS_COL_IDX] || ''),    // W
  });

  const resultado = [];
  let i = 0;
  while (i < dados.length) {
    const linha = i + 2;
    const row = dados[i];
    const colA = String(row[0] || '');

    if (colA.startsWith('GRUPO ')) {
      const pai = paraItem(row, linha);
      pai.isGrupo = true;
      pai.familyId = colA.replace('GRUPO ', '').trim();
      pai.filhos = [];

      let j = i + 1;
      while (j < dados.length && ws.getRowGroupDepth(j + 2) >= 1) {
        pai.filhos.push(paraItem(dados[j], j + 2));
        j++;
      }
      resultado.push(pai);
      i = j;
    } else {
      resultado.push(paraItem(row, linha));
      i++;
    }
  }
  return resultado;
}

// Chamado ao clicar num resultado do sidebar — ativa a aba Precificação e
// seleciona a linha correspondente para o usuário ver o produto na planilha.
function irParaLinhaPrecificacao(linha) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(ABA_PRECIFICACAO);
  if (!ws) return;
  ss.setActiveSheet(ws);
  const range = ws.getRange(linha, 1, 1, HEADERS_PREC.length);
  ws.setActiveRange(range);
  SpreadsheetApp.flush();
}
