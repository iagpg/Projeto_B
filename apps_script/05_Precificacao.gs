// ============================================================
// 05_Precificacao.gs — Cálculos e escrita da aba Precificação
// ============================================================

// ── Fórmulas Lucro Real ───────────────────────────────────────────────────────

function calcularLinha(sku, mlData, custoData, timestamp) {
  const preco     = mlData ? (parseFloat(mlData.price) || 0) : 0;
  const taxaPct   = mlData ? (parseFloat(mlData.taxaPct) || 0) : 0;
  const taxaRs    = mlData ? (parseFloat(mlData.taxaRs) || 0) : 0;
  const freteRs   = mlData ? (parseFloat(mlData.freteRs) || 0) : 0;
  const mlbId     = mlData ? (mlData.mlbId || '') : '';
  const title     = mlData ? (mlData.title || '') : '';
  const category  = mlData ? (mlData.categoryId || '') : '';
  const status    = mlData ? (mlData.status || '') : '';

  // Comissão ML
  const comissaoFrete = _r2(taxaRs + freteRs);

  // Débitos fiscais sobre venda
  const icmsVenda   = _r2(preco * ICMS_VENDA);
  const pisVenda    = _r2(preco * PIS_VENDA);
  const cofinsVenda = _r2(preco * COFINS_VENDA);

  // Custo e créditos fiscais da compra
  let custoNf = 0, icmsCred = 0, pisCred = 0, cofinsCred = 0, impRecup = 0;
  if (custoData) {
    const custoBase = parseFloat(custoData.custoBase) || 0;
    const ipiPct    = parseFloat(custoData.ipiPct)    || 0;
    const icmsPct   = parseFloat(custoData.icmsPct)   || 0;
    custoNf    = _r2(custoBase * (1 + ipiPct / 100));
    icmsCred   = _r2(custoBase * icmsPct / 100);       // 0 se ST
    pisCred    = _r2(custoBase * PIS_COMPRA);
    cofinsCred = _r2(custoBase * COFINS_COMPRA);
    impRecup   = _r2(icmsCred + pisCred + cofinsCred);
  }

  // Margem
  const margemRs  = _r2(preco - comissaoFrete - icmsVenda - pisVenda - cofinsVenda - custoNf + impRecup);
  const margemPct = preco > 0 ? _r2(margemRs / preco * 100) : 0;

  return [
    mlbId || sku,    // A 0  ID ML
    sku,             // B 1  SKU
    title || sku,    // C 2  Nome
    category,        // D 3  Categoria
    preco,           // E 4  Preço de Venda
    _r2(taxaPct),    // F 5  Taxa ML (%)
    0,               // G 6  RT (%) — reservado
    freteRs,         // H 7  Frete
    icmsVenda,       // I 8  ICMS Venda
    pisVenda,        // J 9  PIS Venda
    cofinsVenda,     // K 10 COFINS Venda
    comissaoFrete,   // L 11 Comissão + Frete
    custoNf,         // M 12 Custo NF c/ IPI
    icmsCred,        // N 13 ICMS Compra crédito
    pisCred,         // O 14 PIS Compra crédito
    cofinsCred,      // P 15 COFINS Compra crédito
    impRecup,        // Q 16 Imposto Recuperável
    margemRs,        // R 17 Margem Líquida (R$)
    margemPct,       // S 18 Margem Líquida (%)
    statusMl(status),// T 19 Status Anúncio
    timestamp,       // U 20 Última Atualização
  ];
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

  allSkus.forEach(sku => {
    const mlData    = skuMlbMap[sku] || null;
    const custoData = cacheNF[sku]   || null;

    // Busca taxa ML se temos o anúncio
    let mlDataComTaxa = null;
    if (mlData) {
      const fees = getMlItemFees(mlData.mlbId, mlData.price);
      mlDataComTaxa = {
        mlbId:      mlData.mlbId,
        price:      mlData.price,
        status:     mlData.status,
        categoryId: mlData.categoryId,
        title:      mlData.title,
        taxaPct:    fees.taxaPct,
        taxaRs:     fees.taxaRs,
        freteRs:    fees.freteRs,
      };
    }

    rows.push(calcularLinha(sku, mlDataComTaxa, custoData, timestamp));
  });

  // 4. Ordena por Margem % decrescente
  rows.sort((a, b) => (b[MARGEM_COL_IDX] || -999) - (a[MARGEM_COL_IDX] || -999));

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
  if (rows.length) {
    ws.getRange(2, 1, rows.length, HEADERS_PREC.length).setValues(rows);
    _colorirLinhas(ws, rows);
  }

  // Formatos de coluna
  _formatarColunas(ws, rows.length);

  ws.setFrozenRows(1);
  ss.toast(`✅ Precificação atualizada: ${rows.length} produtos.`, 'BouwObra', 8);
}

// Coloração por margem
function _colorirLinhas(ws, rows) {
  rows.forEach((row, i) => {
    const margem = parseFloat(row[MARGEM_COL_IDX]) || 0;
    const range  = ws.getRange(i + 2, 1, 1, HEADERS_PREC.length);
    const bg = margem >= 20 ? '#d4edda'   // verde claro
             : margem >= 10 ? '#fff3cd'   // amarelo claro
             : '#f8d7da';                 // vermelho claro
    range.setBackground(bg);
  });
}

// Formatos numéricos
function _formatarColunas(ws, nRows) {
  if (nRows < 1) return;
  const R$ = '"R$"#,##0.00';
  const PCT = '#,##0.00"%"';

  // Preço (E), Frete (H), ICMS..Margem R$ (I..R) → R$
  ws.getRange(2, 5, nRows, 1).setNumberFormat(R$);  // E
  ws.getRange(2, 8, nRows, 1).setNumberFormat(R$);  // H
  ws.getRange(2, 9, nRows, 4).setNumberFormat(R$);  // I..L
  ws.getRange(2, 13, nRows, 6).setNumberFormat(R$); // M..R

  // Taxa ML (F), RT (G), Margem % (S) → %
  ws.getRange(2, 6, nRows, 2).setNumberFormat(PCT); // F..G
  ws.getRange(2, 19, nRows, 1).setNumberFormat(PCT);// S

  // Colunas de texto
  ws.setColumnWidth(1, 140);  // A ID ML
  ws.setColumnWidth(2, 90);   // B SKU
  ws.setColumnWidth(3, 220);  // C Nome
  ws.setColumnWidth(4, 120);  // D Categoria
  ws.autoResizeColumns(20, 2);// T..U
}
