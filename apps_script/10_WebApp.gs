// ============================================================
// 10_WebApp.gs — Web App (deploy "Bouw Flow") — layout full-width p/ apresentação
// ============================================================
//
// Serve as mesmas páginas HTML dos sidebars, só que como Web App standalone
// (URL própria, fora da planilha). Reaproveita os mesmos arquivos e as
// mesmas funções de servidor (getDashboardData, getPrecificacaoListaBusca,
// irParaLinhaPrecificacao) — a diferença é só como a página é entregue e
// estilizada (variável `modo`, ver CSS em Dashboard.html/BuscaPrecificacao.html).
//
// ?page=dashboard (padrão) → Dashboard.html
// ?page=busca               → BuscaPrecificacao.html

function doGet(e) {
  const pagina = ((e && e.parameter && e.parameter.page) || 'dashboard').toLowerCase();
  const arquivo = pagina === 'busca' ? 'BuscaPrecificacao' : 'Dashboard';

  const tmpl = HtmlService.createTemplateFromFile(arquivo);
  tmpl.modo = 'webapp';

  return tmpl.evaluate()
    .setTitle('BouwObra')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Composição de templates (recorte oficial do Apps Script pra reaproveitar
// HTML entre páginas) — usado por Dashboard.html/BuscaPrecificacao.html pra
// incluir Nav.html só no modo 'webapp'.
function include(filename, data) {
  const tmpl = HtmlService.createTemplateFromFile(filename);
  Object.keys(data || {}).forEach(k => { tmpl[k] = data[k]; });
  return tmpl.evaluate().getContent();
}
