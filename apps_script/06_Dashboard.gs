// ============================================================
// 06_Dashboard.gs — KPIs do Dashboard
// ============================================================
//
// O Dashboard não escreve mais numa aba da planilha — o painel HTML
// (Dashboard.html, aberto via mostrarDashboardSidebar) é a única forma de
// visualização, sempre computado ao vivo a partir dos pedidos/anúncios ML
// e da aba Precificação.

const _DASHBOARD_CACHE_KEY = 'dashboardKpis_v1';
const _DASHBOARD_CACHE_TTL = 300; // 5 min — getStatusAnuncios() pagina TODOS os anúncios,
                                   // sem isso cada abertura do painel batia na API do zero.

// Calcula os KPIs crus (números), usado pelo sidebar HTML. Cacheado por
// _DASHBOARD_CACHE_TTL segundos pra não estourar a cota diária de UrlFetch
// só de abrir/recarregar o painel repetidas vezes — passe forcar=true (usado
// pelo botão "Atualizar") pra ignorar o cache e recalcular na hora.
function _calcularKpisDashboard(forcar) {
  const cache = CacheService.getScriptCache();
  if (!forcar) {
    const cached = cache.get(_DASHBOARD_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const kpis   = getKpisPedidos();
  const status = getStatusAnuncios();

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

  const resultado = {
    vendasBrutas: kpis.vendasBrutas,
    pedidosHoje: kpis.pedidosHoje,
    pedidosMes: kpis.pedidosMes,
    ticketMedio: kpis.ticketMedio,
    anunciosAtivos: status.active,
    anunciosPausados: status.paused,
    margemMedia, semCusto, totalProd,
    timestamp: new Date().toLocaleString('pt-BR'),
  };

  cache.put(_DASHBOARD_CACHE_KEY, JSON.stringify(resultado), _DASHBOARD_CACHE_TTL);
  return resultado;
}

// ── Suporte ao sidebar HTML (Dashboard.html) ──────────────────────────────

function mostrarDashboardSidebar() {
  const tmpl = HtmlService.createTemplateFromFile('Dashboard');
  tmpl.modo = 'sidebar';
  const html = tmpl.evaluate().setTitle('📊 Dashboard BouwObra');
  SpreadsheetApp.getUi().showSidebar(html);
}

// Chamado pelo sidebar/web app ao carregar — usa o cache de 5 min se existir.
function getDashboardData() {
  return _formatarKpisParaSidebar(_calcularKpisDashboard(false));
}

// Chamado pelo botão "Atualizar" — ignora o cache e recalcula na hora.
function atualizarDashboardData() {
  return _formatarKpisParaSidebar(_calcularKpisDashboard(true));
}

function _formatarKpisParaSidebar(k) {
  return {
    vendasBrutas: _fmt(k.vendasBrutas),
    pedidosHoje: k.pedidosHoje,
    pedidosMes: k.pedidosMes,
    ticketMedio: _fmt(k.ticketMedio),
    anunciosAtivos: k.anunciosAtivos,
    anunciosPausados: k.anunciosPausados,
    margemMedia: _fmt(k.margemMedia),
    semCusto: k.semCusto,
    totalProd: k.totalProd,
    timestamp: k.timestamp,
  };
}

function _fmt(v) {
  return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
