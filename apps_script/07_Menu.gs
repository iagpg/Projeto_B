// ============================================================
// 07_Menu.gs — Menu customizado, triggers e orquestração
// ============================================================

// Disparado automaticamente ao abrir a planilha
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BouwObra')
    .addItem('▶ Sincronizar Tudo', 'sincronizarTudo')
    .addSeparator()
    .addSubMenu(
      SpreadsheetApp.getUi().createMenu('Operações Individuais')
        .addItem('Atualizar Cache de NFs (Tiny)', 'atualizarCacheNF')
        .addItem('Atualizar Precificação',         'atualizarPrecificacao')
        .addItem('Atualizar Dashboard',            'atualizarDashboard')
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

// Roda no editor de script para testar autenticação Tiny
function testarConexaoTiny() {
  const data = tinyGet('/info-conta');
  Logger.log(JSON.stringify(data));
  SpreadsheetApp.getActiveSpreadsheet()
    .toast('Tiny OK: ' + JSON.stringify(data).substring(0, 80), 'BouwObra', 6);
}
