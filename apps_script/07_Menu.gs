// ============================================================
// 07_Menu.gs — Menu customizado, triggers e orquestração
// ============================================================

// Disparado automaticamente ao abrir a planilha
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BouwObra')
    .addItem('▶ Sincronizar Tudo', 'sincronizarTudo')
    .addItem('➕ Adicionar Anúncio (MLB/Family ID)', 'mostrarDialogoAdicionarAnuncio')
    .addItem('🔍 Buscar NF (período/número)', 'mostrarDialogoBuscarNF')
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('Operações Individuais')
        .addItem('Atualizar Cache de NFs (Tiny)', 'atualizarCacheNF')
        .addItem('Atualizar Precificação',         'atualizarPrecificacao')
        .addItem('Atualizar Dashboard',            'atualizarDashboard')
    )
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('🔧 Diagnóstico')
        .addItem('Testar Conexão ML',    'testarConexaoML')
        .addItem('Testar Conexão Tiny',  'testarConexaoTiny')
        .addItem('Testar Vendas ML',     'testarVendasML')
    )
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('🔐 Autorização OAuth (rodar 1x, ou se o token for revogado)')
        .addItem('Autorizar Mercado Livre', 'autorizarML')
        .addItem('Autorizar Tiny ERP',       'autorizarTiny')
    )
    .addSeparator()
    .addItem('⚙️ Inicializar Configurações', 'inicializarConfiguracoes')
    .addItem('🔑 Instalar Trigger Diário',   'instalarTriggerDiario')
    .addItem('🗑️ Remover Trigger Diário',    'removerTriggerDiario')
    .addToUi();
}

// ── Sincronização completa ────────────────────────────────────────────────────

function sincronizarTudo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Iniciando sincronização completa...', 'BouwObra', -1);

  try {
    atualizarCacheNF();
  } catch (e) {
    ss.toast('⚠️ Erro no Cache NF: ' + e.message, 'BouwObra', 8);
    Logger.log('Erro atualizarCacheNF: ' + e.stack);
    return;
  }

  try {
    atualizarPrecificacao();
  } catch (e) {
    ss.toast('⚠️ Erro na Precificação: ' + e.message, 'BouwObra', 8);
    Logger.log('Erro atualizarPrecificacao: ' + e.stack);
    return;
  }

  try {
    atualizarDashboard();
  } catch (e) {
    ss.toast('⚠️ Erro no Dashboard: ' + e.message, 'BouwObra', 8);
    Logger.log('Erro atualizarDashboard: ' + e.stack);
    return;
  }

  ss.toast('✅ Sincronização concluída!', 'BouwObra', 8);
}

// ── Trigger automático diário ─────────────────────────────────────────────────

function instalarTriggerDiario() {
  // Remove triggers existentes para evitar duplicatas
  removerTriggerDiario();

  ScriptApp.newTrigger('sincronizarTudo')
    .timeBased()
    .everyDays(1)
    .atHour(6)          // 06:00 no fuso do script (America/Sao_Paulo configurar no projeto)
    .create();

  SpreadsheetApp.getActiveSpreadsheet()
    .toast('✅ Trigger diário instalado: sincronização às 6h.', 'BouwObra', 6);
}

function removerTriggerDiario() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sincronizarTudo')
    .forEach(t => ScriptApp.deleteTrigger(t));

  SpreadsheetApp.getActiveSpreadsheet()
    .toast('Trigger diário removido.', 'BouwObra', 4);
}

// ── Diagnóstico rápido ────────────────────────────────────────────────────────

// Roda no editor de script para testar autenticação ML
function testarConexaoML() {
  const data = mlGet(`/users/${ML_USER_ID_PROP()}`);
  Logger.log(JSON.stringify(data));
  SpreadsheetApp.getActiveSpreadsheet()
    .toast('ML OK: ' + (data.nickname || data.id || 'sem nickname'), 'BouwObra', 6);
}

// ── Teste de vendas ML ────────────────────────────────────────────────────────

function testarVendasML() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const userId = ML_USER_ID_PROP();

  // 1. Testa conexão básica
  ss.toast('Testando conexão ML...', 'BouwObra', -1);
  const user = mlGet('/users/' + userId);
  Logger.log('USER: ' + JSON.stringify(user));
  if (user.error) {
    ss.toast('❌ Erro de autenticação ML: ' + user.message, 'BouwObra', 10);
    return;
  }

  // 2. Busca pedidos — endpoint raw sem helper de data
  ss.toast('Buscando pedidos...', 'BouwObra', -1);
  const hoje = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dataHoje = hoje.getFullYear() + '-' + pad(hoje.getMonth()+1) + '-' + pad(hoje.getDate());
  const inicioMes = hoje.getFullYear() + '-' + pad(hoje.getMonth()+1) + '-01';

  const respMes = mlGet('/orders/search', {
    seller: userId,
    'order.status': 'paid',
    'order.date_created.from': inicioMes + 'T00:00:00.000-03:00',
    'order.date_created.to':   dataHoje  + 'T23:59:59.000-03:00',
    limit: 5,
    offset: 0,
  });
  Logger.log('ORDERS RAW: ' + JSON.stringify(respMes));

  // 3. Exibe resultado bruto na aba Dashboard para inspeção
  let ws = ss.getSheetByName(ABA_DASHBOARD);
  if (!ws) ws = ss.insertSheet(ABA_DASHBOARD);
  ws.getRange('A15:C25').clearContent();
  ws.getRange('A15').setValue('--- DIAGNÓSTICO ML ---');
  ws.getRange('A16').setValue('Usuário ML: ' + (user.nickname || user.id));
  ws.getRange('A17').setValue('Total pedidos mês (API): ' + (respMes.paging ? respMes.paging.total : 'n/d'));
  ws.getRange('A18').setValue('Resultados retornados: ' + ((respMes.results || []).length));
  ws.getRange('A19').setValue('Resposta bruta (trunc.): ' + JSON.stringify(respMes).substring(0, 300));
  ws.getRange('A20').setValue('Período: ' + inicioMes + ' → ' + dataHoje);
  ws.getRange('A21').setValue('Timestamp: ' + new Date().toLocaleString('pt-BR'));

  const total = respMes.paging ? respMes.paging.total : 0;
  ss.toast('ML OK: ' + (user.nickname || userId) + ' | ' + total + ' pedidos no mês', 'BouwObra', 10);
}

// Roda no editor de script para testar autenticação Tiny
function testarConexaoTiny() {
  const data = tinyGet('/produtos', { limit: 1 });
  Logger.log(JSON.stringify(data));
  const inner = data.data || data;
  const itens = inner.itens || inner.items || inner.produtos || [];
  if (data.error || data.status === 401) {
    SpreadsheetApp.getActiveSpreadsheet()
      .toast('❌ Tiny ERRO: ' + (data.message || data.error || JSON.stringify(data).substring(0, 100)), 'BouwObra', 10);
    return;
  }
  SpreadsheetApp.getActiveSpreadsheet()
    .toast('✅ Tiny OK — ' + itens.length + ' produto(s) retornado(s)', 'BouwObra', 6);
}
