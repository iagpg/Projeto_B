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
  const margemRs  = _r2(preco - comissaoFrete - icmsVenda - pisVenda - cofinsVenda - custoNf + impRecup);
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
    custoNf,           // N 13 Custo NF c/ IPI
    icmsCred,          // O 14 ICMS Compra crédito
    pisCred,           // P 15 PIS Compra crédito
    cofinsCred,        // Q 16 COFINS Compra crédito
    impRecup,          // R 17 Imposto Recuperável
    margemRs,          // S 18 Margem Líquida (R$)
    margemPct,         // T 19 Margem Líquida (%)
    statusMl(status),  // U 20 Status Anúncio
    timestamp,         // V 21 Última Atualização
  ];

  const uncertainCols = [];
  if (mlData && mlData.promoIncerto)  uncertainCols.push(5);            // F — Preço Praticado
  if (mlData && mlData.feesIncerto) { uncertainCols.push(6); uncertainCols.push(12); } // G, M
  if (mlData && mlData.rtIncerto)     uncertainCols.push(7);            // H — RT
  if (mlData && mlData.freteIncerto) { uncertainCols.push(8); uncertainCols.push(12); } // I, M
  if (!custoData)                     uncertainCols.push(13);           // N — Custo NF

  return [row, uncertainCols];
}

function _r2(v) { return Math.round(v * 100) / 100; }

// ── Escrita na aba Precificação ───────────────────────────────────────────────

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

    // Busca preço praticado (promoção), taxa ML, RT e frete real se temos o anúncio
    let mlDataCompleto = null;
    if (mlData) {
      const promo = getPrecoPraticado(mlData.mlbId, mlData.price);
      const fees  = getMlItemFees(promo.precoPraticado, mlData.categoryId, mlData.listingTypeId);
      const bonus = getTaxaBonus(mlData.mlbId, mlData.price, promo.precoPraticado);
      const frete = getFreteEnvio(mlData.mlbId);

      mlDataCompleto = {
        mlbId:      mlData.mlbId,
        price:      mlData.price,
        status:     mlData.status,
        categoryId: mlData.categoryId,
        title:      mlData.title,
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

// Coloração: crédito (verde) e débito (vermelho) fixos por coluna, margem por
// faixa de desempenho, status por valor, laranja por cima nas células com
// valor incerto/estimado. Um único setBackgrounds() sobre a área inteira —
// evita milhares de chamadas individuais (lento e sujeito a limite de
// execução do Apps Script).
function _colorirLinhas(ws, rows, uncertainCols) {
  const nCols = HEADERS_PREC.length;

  const bg = rows.map((row, i) => {
    const linha = new Array(nCols).fill(null); // null = sem cor (padrão)

    CREDITO_COLS.forEach(col => { linha[col] = '#d4edda'; });
    DEBITO_COLS.forEach(col => { linha[col] = '#f8d7da'; });

    const margem = parseFloat(row[MARGEM_COL_IDX]) || 0;
    const corMargem = margem >= 20 ? '#d4edda' : margem >= 10 ? '#fff3cd' : '#f8d7da';
    MARGEM_COLS.forEach(col => { linha[col] = corMargem; });

    const corStatus = _STATUS_CORES[row[STATUS_COL_IDX]];
    if (corStatus) linha[STATUS_COL_IDX] = corStatus;

    (uncertainCols[i] || []).forEach(col => { linha[col] = '#ffa500'; });

    return linha;
  });

  ws.getRange(2, 1, rows.length, nCols).setBackgrounds(bg);

  // Dropdown (menu suspenso) na coluna de status
  const regra = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUS_OPTIONS, true)
    .setAllowInvalid(false)
    .build();
  ws.getRange(2, STATUS_COL_IDX + 1, rows.length, 1).setDataValidation(regra);
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
  // RT..Margem R$ (H..S) → R$
  ws.getRange(2, 8, nRows, 12).setNumberFormat(R$);
  // Margem % (T)
  ws.getRange(2, 20, nRows, 1).setNumberFormat(PCT);

  // Colunas de texto
  ws.setColumnWidth(1, 140);  // A ID ML
  ws.setColumnWidth(2, 90);   // B SKU
  ws.setColumnWidth(3, 220);  // C Nome
  ws.setColumnWidth(4, 120);  // D Categoria
  ws.autoResizeColumns(21, 2);// U..V (Status, Última Atualização)
}
