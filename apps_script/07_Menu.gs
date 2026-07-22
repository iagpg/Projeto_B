// ============================================================
// 07_Menu.gs — Menu customizado, triggers e orquestração
// ============================================================

// Disparado automaticamente ao abrir a planilha
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('BouwObra')
    .addItem('▶ Sincronizar Tudo', 'sincronizarTudo')
    .addItem('➕ Adicionar Anúncio (MLB/Family ID)', 'mostrarDialogoAdicionarAnuncio')
    .addItem('🔄 Atualizar Selecionadas', 'atualizarSelecionadas')
    .addItem('↩️ Restaurar Preço Original (selecionadas)', 'restaurarPrecoOriginalSelecionadas')
    .addItem('🔍 Buscar NF (período/número)', 'mostrarDialogoBuscarNF')
    .addSeparator()
    .addItem('📊 Ver Dashboard (painel)', 'mostrarDashboardSidebar')
    .addItem('🔎 Buscar Produto (nome/MLB/SKU)', 'mostrarBuscaPrecificacaoSidebar')
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
    .addItem('🕐 Configurar Trigger Diário', 'mostrarDialogoConfigTrigger')
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

  ss.toast('✅ Sincronização concluída!', 'BouwObra', 8);
}

// ── Trigger automático diário ─────────────────────────────────────────────────
//
// Painel de configuração (diálogo) em vez de um "instalar" com hora fixa:
// escolhe o horário e quais tarefas rodam (guardado nas propriedades do
// script). O handler do trigger é sempre executarTriggerDiario(), que lê
// essa config e decide o que chamar -- então trocar a config não exige
// reinstalar o trigger, só resalvar.

function _configTriggerAtual() {
  const props = getProps();
  const trigger = ScriptApp.getProjectTriggers()
    .find(t => t.getHandlerFunction() === 'executarTriggerDiario' && t.getEventType() === ScriptApp.EventType.CLOCK);
  return {
    ativo: !!trigger,
    hora: parseInt(props.getProperty('TRIGGER_HORA') || '6', 10),
    buscarNF: props.getProperty('TRIGGER_BUSCAR_NF') !== 'false',       // default ativado
    syncPrecificacao: props.getProperty('TRIGGER_SYNC_PRECIFICACAO') !== 'false', // default ativado
  };
}

function mostrarDialogoConfigTrigger() {
  const cfg = _configTriggerAtual();
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 13px; padding: 4px;">
      <p><b>Status atual:</b> ${cfg.ativo ? `✅ ativo, às ${cfg.hora}h` : '⚪ inativo'}</p>
      <p>
        Horário (0-23):<br>
        <input type="number" id="hora" min="0" max="23" value="${cfg.hora}" style="width: 60px; padding: 4px;">
      </p>
      <p>
        <label><input type="checkbox" id="buscarNF" ${cfg.buscarNF ? 'checked' : ''}>
          🔍 Buscar NFs novas (desde o último dia cacheado até hoje)</label><br>
        <label><input type="checkbox" id="syncPrec" ${cfg.syncPrecificacao ? 'checked' : ''}>
          💰 Sincronizar Precificação</label>
      </p>
      <button onclick="salvar()">Salvar e Ativar</button>
      <button onclick="desativar()" style="margin-left: 6px;">Desativar</button>
      <p id="resultado" style="color: #333; font-weight: bold;"></p>
    </div>
    <script>
      function salvar() {
        const hora = document.getElementById('hora').value;
        const buscarNF = document.getElementById('buscarNF').checked;
        const syncPrec = document.getElementById('syncPrec').checked;
        document.getElementById('resultado').innerText = 'Salvando...';
        google.script.run
          .withSuccessHandler(function(msg) { document.getElementById('resultado').innerText = msg; })
          .withFailureHandler(function(err) { document.getElementById('resultado').innerText = 'Erro: ' + err.message; })
          .processarConfigTriggerDialog(hora, buscarNF, syncPrec);
      }
      function desativar() {
        document.getElementById('resultado').innerText = 'Desativando...';
        google.script.run
          .withSuccessHandler(function(msg) { document.getElementById('resultado').innerText = msg; })
          .withFailureHandler(function(err) { document.getElementById('resultado').innerText = 'Erro: ' + err.message; })
          .removerTriggerDiario();
      }
    </script>
  `;
  const output = HtmlService.createHtmlOutput(html).setWidth(420).setHeight(280);
  SpreadsheetApp.getUi().showModalDialog(output, 'Configurar Trigger Diário');
}

function processarConfigTriggerDialog(hora, buscarNF, syncPrec) {
  try {
    const h = parseInt(hora, 10);
    if (isNaN(h) || h < 0 || h > 23) return '❌ Horário inválido (use 0-23).';

    getProps().setProperties({
      'TRIGGER_HORA': String(h),
      'TRIGGER_BUSCAR_NF': String(!!buscarNF),
      'TRIGGER_SYNC_PRECIFICACAO': String(!!syncPrec),
    });

    removerTriggerDiario();
    ScriptApp.newTrigger('executarTriggerDiario')
      .timeBased()
      .everyDays(1)
      .atHour(h)
      .create();

    const tarefas = [];
    if (buscarNF) tarefas.push('Buscar NFs novas');
    if (syncPrec) tarefas.push('Sincronizar Precificação');
    return `✅ Trigger diário ativado às ${h}h. Tarefas: ${tarefas.length ? tarefas.join(', ') : 'nenhuma selecionada'}.`;
  } catch (e) {
    Logger.log('Erro processarConfigTriggerDialog: ' + e.stack);
    return '❌ Erro: ' + e.message;
  }
}

function removerTriggerDiario() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sincronizarTudo' || t.getHandlerFunction() === 'executarTriggerDiario')
    .forEach(t => ScriptApp.deleteTrigger(t));

  SpreadsheetApp.getActiveSpreadsheet().toast('Trigger diário removido.', 'BouwObra', 4);
  return '🗑️ Trigger diário removido.';
}

// Handler chamado pelo trigger instalado -- lê a config salva e decide o que
// rodar. Cada tarefa é isolada (erro numa não impede a outra).
function executarTriggerDiario() {
  const cfg = _configTriggerAtual();

  if (cfg.buscarNF) {
    try {
      buscarNfNovasDoDia();
    } catch (e) {
      Logger.log('Erro buscarNfNovasDoDia (trigger diário): ' + e.stack);
    }
  }

  if (cfg.syncPrecificacao) {
    try {
      atualizarPrecificacao();
    } catch (e) {
      Logger.log('Erro atualizarPrecificacao (trigger diário): ' + e.stack);
    }
  }
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

  // 3. Exibe resultado bruto numa aba própria de diagnóstico (não usa mais
  // ABA_DASHBOARD — essa aba foi removida, o Dashboard agora é só o painel HTML)
  let ws = ss.getSheetByName(ABA_DIAGNOSTICO);
  if (!ws) ws = ss.insertSheet(ABA_DIAGNOSTICO);
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

// ── Limpeza única: aba "Dashboard" legada ─────────────────────────────────────
//
// O Dashboard virou 100% o painel HTML (06_Dashboard.gs) — essa aba parou de
// ser escrita e só guarda a última tabela de KPIs congelada. Idempotente: não
// dá erro se a aba já não existir (pode ser rodada mais de uma vez à toa).
function removerAbaDashboardAntiga() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(ABA_DASHBOARD);
  if (!ws) {
    ss.toast('Aba "Dashboard" já não existe — nada a fazer.', 'BouwObra', 6);
    return;
  }
  ss.deleteSheet(ws);
  ss.toast('✅ Aba "Dashboard" (legada) removida.', 'BouwObra', 6);
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
