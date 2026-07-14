// ============================================================
// 06_Dashboard.gs — KPIs e escrita da aba Dashboard
// ============================================================

function atualizarDashboard() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Atualizando Dashboard...', 'BouwObra', -1);

  // ── KPIs de pedidos ML ────────────────────────────────────
  const kpis   = getKpisPedidos();
  const status = getStatusAnuncios();

  // ── KPIs da aba Precificação (lê o que já foi gravado) ────
  let margemMedia = 0, semCusto = 0, totalProd = 0;
  const wsPr = ss.getSheetByName(ABA_PRECIFICACAO);
  if (wsPr && wsPr.getLastRow() > 1) {
    const dados = wsPr.getRange(2, 1, wsPr.getLastRow() - 1, HEADERS_PREC.length).getValues();
    totalProd = dados.length;
    let somaM = 0, countM = 0;
    dados.forEach(row => {
      const m = parseFloat(row[MARGEM_COL_IDX]);
      if (!isNaN(m)) { somaM += m; countM++; }
      const custo = parseFloat(row[12]); // coluna M — Custo NF
      if (!custo || custo === 0) semCusto++;
    });
    margemMedia = countM > 0 ? Math.round(somaM / countM * 100) / 100 : 0;
  }

  const timestamp = new Date().toLocaleString('pt-BR');

  // ── Dados do Dashboard ────────────────────────────────────
  const kpiData = [
    ['📦 Vendas do Mês',             'Mercado Livre',      'R$ ' + _fmt(kpis.vendasBrutas)],
    ['🛒 Pedidos Hoje',              'Mercado Livre',      kpis.pedidosHoje],
    ['📅 Pedidos no Mês',            'Mercado Livre',      kpis.pedidosMes],
    ['🎯 Ticket Médio',              'Mercado Livre',      'R$ ' + _fmt(kpis.ticketMedio)],
    ['✅ Anúncios Ativos',           'Mercado Livre',      status.active],
    ['⏸️ Anúncios Pausados',         'Mercado Livre',      status.paused],
    ['📊 Margem Média',              'Precificação',       _fmt(margemMedia) + '%'],
    ['⚠️ Produtos sem Custo',        'Precificação',       semCusto],
    ['📝 Total de Produtos',         'Precificação',       totalProd],
    ['🕐 Última Sincronização',      'Sistema',            timestamp],
  ];

  // ── Grava na aba Dashboard ────────────────────────────────
  let ws = ss.getSheetByName(ABA_DASHBOARD);
  if (!ws) ws = ss.insertSheet(ABA_DASHBOARD);
  ws.clearContents();
  ws.clearFormats();

  _escreverDashboard(ws, kpiData);

  ss.toast('✅ Dashboard atualizado!', 'BouwObra', 5);
}

function _fmt(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _escreverDashboard(ws, kpiData) {
  // Título
  const tRange = ws.getRange(1, 1, 1, 3);
  tRange.merge();
  tRange.setValue('BouwObra — Plataforma de Gestão');
  tRange.setBackground('#1a1a2e');
  tRange.setFontColor('#ffffff');
  tRange.setFontSize(16);
  tRange.setFontWeight('bold');
  tRange.setHorizontalAlignment('center');
  tRange.setVerticalAlignment('middle');
  ws.setRowHeight(1, 48);

  // Sub-título de colunas
  const headers = ['KPI', 'Fonte', 'Valor'];
  const hdr = ws.getRange(2, 1, 1, 3);
  hdr.setValues([headers]);
  hdr.setBackground('#16213e');
  hdr.setFontColor('#e0e0e0');
  hdr.setFontWeight('bold');
  hdr.setHorizontalAlignment('center');

  // Dados
  ws.getRange(3, 1, kpiData.length, 3).setValues(kpiData);

  // Coloração alternada + destaque de valor
  kpiData.forEach((_, i) => {
    const row = i + 3;
    const bg  = i % 2 === 0 ? '#f8f9fa' : '#ffffff';
    ws.getRange(row, 1, 1, 2).setBackground(bg).setFontColor('#333333');
    const valRange = ws.getRange(row, 3);
    valRange.setBackground(bg).setFontWeight('bold').setFontSize(12);
    // Cor especial para KPIs financeiros
    const label = String(kpiData[i][0]);
    if (label.includes('Margem')) valRange.setFontColor('#155724');
    else if (label.includes('sem Custo') || label.includes('Pausados')) valRange.setFontColor('#856404');
    else if (label.includes('Vendas') || label.includes('Ticket')) valRange.setFontColor('#0c5460');
    else valRange.setFontColor('#1a1a2e');
  });

  // Bordas
  ws.getRange(2, 1, kpiData.length + 1, 3).setBorder(
    true, true, true, true, true, true,
    '#dee2e6', SpreadsheetApp.BorderStyle.SOLID
  );

  // Largura de colunas
  ws.setColumnWidth(1, 260);
  ws.setColumnWidth(2, 150);
  ws.setColumnWidth(3, 200);
}
