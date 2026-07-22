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
      ? montarMlDataCompleto(mlData.mlbId, mlData.title, mlData.status, mlData.categoryId, mlData.listingTypeId, mlData.price)
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

  // Dados
  if (rowsOrdenadas.length) {
    ws.getRange(2, 1, rowsOrdenadas.length, HEADERS_PREC.length).setValues(rowsOrdenadas);
    _colorirLinhas(ws, rowsOrdenadas, colsOrdenados);
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
