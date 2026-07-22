// ============================================================
// 03_TinyApi.gs — Tiny ERP: produtos e Notas Fiscais
// ============================================================

// ── Produtos ──────────────────────────────────────────────────────────────────

// /produtos pagina por offset/limit (igual /notas) — o parâmetro "pagina" é
// aceito mas IGNORADO pela API, sempre retornando a partir do offset 0.
function getTinyProdutos() {
  const todos = [];
  let offset = 0;
  while (true) {
    const data = tinyGet('/produtos', { situacao: 'A', offset: offset, limit: 100 });
    const inner = (data.data) || data;
    const itens = inner.itens || inner.produtos || inner.items || (Array.isArray(inner) ? inner : []);
    if (!itens.length) break;
    todos.push(...itens);
    const pag = inner.paginacao || inner.pagination || {};
    const total = parseInt(pag.total || 0, 10);
    offset += 100;
    if ((total && offset >= total) || itens.length < 100) break;
    Utilities.sleep(150);
  }
  return todos;
}

function extrairSkuTiny(produto) {
  return String(produto.codigo || produto.sku || produto.code || '').trim();
}

// Resolve idProduto (ID interno Tiny) -> SKU atual, só para os IDs citados nas
// NFs da busca atual — GET /produtos/{id} direto, em lotes paralelos, sem
// varrer o catálogo inteiro. Usado porque o "codigo" de um item de NF pode
// ser o código usado na nota (às vezes do fornecedor), diferente do SKU atual
// do produto no Tiny. Exemplo real: NF 213583, item código "WPSRESENOINP46" ->
// idProduto 991633087 -> produto atual tem sku "10034034168445".
// Mesma lógica do lado Python (connectors/tiny/nf.py::_resolve_id_produto_sku).
function _resolverIdProdutoSku(idProdutosSet, ss) {
  const ids = Array.from(idProdutosSet).filter(Boolean);
  if (!ids.length) return {};
  if (ss) ss.toast(`Resolvendo ${ids.length} produto(s) (idProduto -> SKU)...`, 'BouwObra', -1);

  const mapa = {};
  const BATCH = 30;
  for (let i = 0; i < ids.length; i += BATCH) {
    const loteIds = ids.slice(i, i + BATCH);
    const respostas = tinyGetProdutosParalelo(loteIds);
    respostas.forEach((resp, j) => {
      if (!resp) return;
      const produto = resp.data || resp;
      const sku = extrairSkuTiny(produto);
      if (sku) mapa[loteIds[j]] = sku;
    });
    if (i + BATCH < ids.length) Utilities.sleep(100);
  }
  return mapa;
}

// ── Notas Fiscais de Entrada ───────────────────────────────────────────────────

function _extrairSkuItemNF(item) {
  const prod = item.produto || {};
  return String(prod.codigo || prod.sku || item.codigo || item.codigoProduto || '').trim();
}

function _extrairQtdItemNF(item) {
  return parseFloat(item.quantidade || item.qty || 1) || 1;
}

function _extrairValorUnitarioItemNF(item) {
  // Tenta campo unitário direto; depois calcula de valorTotal/qtd
  const unit = item.valorUnitario || item.valor_unitario || item.preco;
  if (unit !== undefined && unit !== null) return parseFloat(unit) || 0;
  const total = parseFloat(item.valorTotal || item.valor_total || 0);
  const qty   = _extrairQtdItemNF(item);
  return qty > 0 ? total / qty : 0;
}

function _extrairIpiPct(item) {
  const ipiObj = item.ipi || item.impostoIpi || {};
  if (typeof ipiObj === 'object' && ipiObj !== null) {
    const v = ipiObj.percentual || ipiObj.aliquota;
    if (v !== undefined) return parseFloat(v) || 0;
  }
  return parseFloat(item.percentualIpi || item.ipi_pct || item.aliquotaIpi || 0) || 0;
}

function _extrairIcmsPct(item) {
  const icmsObj = item.icms || item.impostoIcms || {};
  if (typeof icmsObj === 'object' && icmsObj !== null) {
    const v = icmsObj.percentual || icmsObj.aliquota;
    if (v !== undefined) return parseFloat(v) || 0;
  }
  return parseFloat(item.percentualIcms || item.icms_pct || item.aliquotaIcms || 0) || 0;
}

function _extrairItensNota(nota) {
  return nota.itens || nota.items || nota.produtos || nota.products || [];
}

// Retorna lista de {id, numero, data} das NFs de entrada.
// dataInicioCustom/dataFimCustom (opcional, "YYYY-MM-DD") sobrepõem mesesAtras
// — útil pra buscar um período histórico específico. numeroCustom (opcional)
// busca só essa NF (ignora datas).
function _listarNfIds(mesesAtras, dataInicioCustom, dataFimCustom, numeroCustom) {
  const fmtDate = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  let dataInicial, dataFinal;
  if (!numeroCustom) {
    const hoje = new Date();
    const inicio = new Date(hoje);
    inicio.setMonth(inicio.getMonth() - mesesAtras);
    dataInicial = dataInicioCustom || fmtDate(inicio);
    dataFinal   = dataFimCustom || fmtDate(hoje);
  }

  const nfHeaders = [];
  let offset = 0;
  while (true) {
    const params = { tipo: 'E', limit: 100, offset: offset };
    if (numeroCustom) {
      params.numero = numeroCustom;
    } else {
      params.dataInicial = dataInicial;
      params.dataFinal   = dataFinal;
    }
    const data = tinyGet('/notas', params);
    const inner = (data.data) || data;
    const itens = inner.itens || inner.notas || inner.items || (Array.isArray(inner) ? inner : []);
    if (!itens.length) break;
    nfHeaders.push(...itens.map(n => ({
      id:     n.id,
      numero: String(n.numero || n.number || ''),
      data:   String(n.dataEmissao || n.data || n.date || ''),
    })));
    const pag = inner.paginacao || inner.pagination || {};
    const total = parseInt(pag.total || 0, 10);
    offset += 100;
    if (offset >= total || itens.length < 100) break;
    Utilities.sleep(150);
  }
  return nfHeaders;
}

// ── Build do Cache de Custos ───────────────────────────────────────────────────

// Busca detalhes + impostos por item pra uma lista de headers de NF
// {id, numero, data}. Reutilizado pelo sync padrão (12 meses) e pela busca por
// período/NF específica.
//
// Estrutura em fases (mesmo padrão do lado Python em connectors/tiny/nf.py):
// busca TUDO primeiro (detalhes das NFs, depois idProduto->SKU, depois
// impostos dos itens) e só no final faz o cálculo, em memória, sem nenhuma
// chamada de API na etapa de cálculo. Evita alternar 1 chamada/1 cálculo, que
// é o que facilita estourar o rate limit do Tiny.
function _processarNfHeaders(nfHeaders, ss) {
  const BATCH = 30;

  // ── Fase 1: buscar o detalhe de TODAS as NFs ────────────────────────────────
  if (ss) ss.toast(`Buscando detalhes de ${nfHeaders.length} NF(s)...`, 'BouwObra', -1);
  const itensPorNf = {}; // nfId -> itens[] (crus, da resposta da API)

  for (let i = 0; i < nfHeaders.length; i += BATCH) {
    const lote = nfHeaders.slice(i, i + BATCH);
    const respostas = tinyGetNfsParalelo(lote.map(n => n.id));

    respostas.forEach((resp, j) => {
      if (!resp) return;
      const nfHdr = lote[j];
      const inner = resp.data || resp;
      const nota  = inner.nota || inner;
      itensPorNf[nfHdr.id] = nota.itens || nota.items || nota.produtos || [];
    });
    if (i + BATCH < nfHeaders.length) Utilities.sleep(100);
  }

  // ── Fase 2: resolver idProduto -> SKU só p/ os IDs citados nestas NFs ───────
  const idProdutosCitados = new Set();
  Object.values(itensPorNf).forEach(itens => {
    itens.forEach(item => {
      const id = parseInt(item.idProduto || 0, 10);
      if (id) idProdutosCitados.add(id);
    });
  });
  const idProdutoSku = _resolverIdProdutoSku(idProdutosCitados, ss);

  // ── Fase 3: montar a lista de itens pendentes (ainda sem impostos) ─────────
  const pendingItems = []; // {nfId, nfNumero, nfData, idItem, sku, qty, unit, descricao}
  nfHeaders.forEach(nfHdr => {
    const itens = itensPorNf[nfHdr.id] || [];
    itens.forEach(item => {
      // O "codigo" do item pode ser o código usado na nota (às vezes do
      // fornecedor), diferente do SKU atual do produto — idProduto é estável
      // e sempre aponta pro produto certo (ver _resolverIdProdutoSku).
      const idProduto = parseInt(item.idProduto || 0, 10);
      const sku = idProdutoSku[idProduto] || String(item.codigo || '').trim();
      if (!sku) return;
      const idItem   = parseInt(item.idItem || item.id || 0, 10);
      const qty      = parseFloat(item.quantidade || 1) || 1;
      const unit     = parseFloat(item.valorUnitario || 0);
      const descricao = String(item.descricao || '').trim();
      if (unit <= 0) return;
      pendingItems.push({ nfId: nfHdr.id, nfNumero: nfHdr.numero, nfData: nfHdr.data,
                          idItem, sku, qty, unit, descricao });
    });
  });

  if (ss) ss.toast(`${pendingItems.length} itens. Buscando impostos...`, 'BouwObra', -1);

  // ── Fase 4: buscar os impostos de TODOS os itens ────────────────────────────
  const validPairs = pendingItems.filter(it => it.idItem > 0);
  const impostosPorPar = {}; // "nfId:idItem" -> resposta de impostos

  for (let i = 0; i < validPairs.length; i += BATCH) {
    const lote = validPairs.slice(i, i + BATCH);
    const respostas = tinyGetItensParalelo(lote.map(it => ({ nfId: it.nfId, idItem: it.idItem })));
    respostas.forEach((resp, j) => {
      const it = lote[j];
      impostosPorPar[`${it.nfId}:${it.idItem}`] = resp || {};
    });
    if (i + BATCH < validPairs.length) Utilities.sleep(100);
  }

  // ── Fase 5: cálculo final — puro em memória, nenhuma chamada de API aqui ───
  const costMap = {}; // sku → custo com valores absolutos
  const _impVal = obj => (obj && typeof obj === 'object') ? (parseFloat(obj.valorImposto || obj.valor || 0) || 0) : 0;
  const _rnd4   = v => Math.round(v * 10000) / 10000;

  pendingItems.forEach(it => {
    if (costMap[it.sku]) return; // mantém a NF mais recente por SKU (primeira encontrada)
    const taxes = it.idItem > 0 ? (impostosPorPar[`${it.nfId}:${it.idItem}`] || {}) : {};
    costMap[it.sku] = {
      custoBase:     _rnd4(it.unit),
      ipiValor:      _rnd4(_impVal(taxes.ipi)     / it.qty),
      icmsCredito:   _rnd4(_impVal(taxes.icms)    / it.qty),
      pisCredito:    _rnd4(_impVal(taxes.pis)     / it.qty),
      cofinsCredito: _rnd4(_impVal(taxes.cofins)  / it.qty),
      nfNumero:      it.nfNumero,
      nfData:        it.nfData,
      descricao:     it.descricao,
    };
  });

  return costMap;
}

// Normaliza uma data pra "YYYY-MM-DD" em texto puro. Aceita tanto o formato
// já limpo quanto um objeto Date (ou o texto longo que String(dateObj) produz,
// tipo "Fri Jul 25 2025 00:00:00 GMT-0300..."), pra desfazer a corrupção
// descrita acima quando encontrada.
function _normalizarDataISO(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  const d = new Date(s);
  if (isNaN(d.getTime())) return s; // não deu pra interpretar, devolve como veio
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dia = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dia}`;
}

// Grava o costMap na aba Cache NF.
// merge=false: substitui a aba inteira (sync padrão de 12 meses).
// merge=true: mescla com o que já existe, mantendo por SKU a NF com nfData
// mais recente — usado pela busca de período/NF específica, pra não apagar o
// que já estava cacheado de fora desse período.
function _gravarCacheNF(costMap, merge) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(ABA_CACHE_NF);
  if (!ws) {
    ws = ss.insertSheet(ABA_CACHE_NF);
    ws.hideSheet();
  }

  let final = costMap;
  if (merge) {
    final = lerCacheNF(); // {sku: {custoBase,...,nfNumero,nfData}} — nfData já normalizada
    Object.entries(costMap).forEach(([sku, novo]) => {
      const atual = final[sku];
      const dataNova  = _normalizarDataISO(novo.nfData);
      const dataAtual = atual ? _normalizarDataISO(atual.nfData) : '';
      if (!atual || dataNova >= dataAtual) {
        final[sku] = novo;
      }
    });
  }

  const agora = new Date().toLocaleString('pt-BR');
  const rows = Object.entries(final).map(([sku, d]) => [
    sku, d.custoBase, d.ipiValor, d.icmsCredito, d.pisCredito, d.cofinsCredito,
    d.nfNumero, _normalizarDataISO(d.nfData), agora,
  ]);

  ws.clearContents();
  ws.getRange(1, 1, 1, HEADERS_CACHE_NF.length).setValues([HEADERS_CACHE_NF]);
  if (rows.length) {
    // Força texto nas colunas que o Sheets tende a reinterpretar como número/data
    // (SKU com zero à esquerda, número da NF, data da NF) ANTES de escrever —
    // sem isso "2026-06-25" vira uma data de verdade e "059467" perde o zero à
    // esquerda, do mesmo jeito que já corrigimos no lado Python (RAW em vez de
    // USER_ENTERED).
    ws.getRange(2, 1, rows.length, 1).setNumberFormat('@');   // SKU
    ws.getRange(2, 7, rows.length, 2).setNumberFormat('@');   // NF Número, NF Data
    ws.getRange(2, 1, rows.length, HEADERS_CACHE_NF.length).setValues(rows);
  }

  return final;
}

// Busca NF detalhes + impostos por item em lotes e grava na aba "Cache NF"
// (sync padrão: últimos 12 meses, substitui a aba inteira)
function atualizarCacheNF() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Buscando notas fiscais de entrada...', 'BouwObra', -1);

  const nfHeaders = _listarNfIds(12);
  ss.toast(`${nfHeaders.length} NFs encontradas. Buscando itens...`, 'BouwObra', -1);

  const costMap = _processarNfHeaders(nfHeaders, ss);
  const final = _gravarCacheNF(costMap, false);

  ss.toast(`✅ Cache NF atualizado: ${Object.keys(final).length} SKUs mapeados.`, 'BouwObra', 6);
  return costMap;
}

// ── Busca por período específico ou NF específica ─────────────────────────────
//
// Diferente do sync padrão: MESCLA com o cache existente em vez de substituir
// (útil pra preencher um período histórico que o sync de 12 meses não cobre,
// sem apagar os dados mais recentes que já estão lá).

function mostrarDialogoBuscarNF() {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 13px; padding: 4px;">
      <p><b>Opção 1 — período específico:</b></p>
      <p>
        Data início: <input type="date" id="desde"><br><br>
        Data fim: <input type="date" id="ate">
      </p>
      <p><b>Opção 2 — uma NF específica</b> (preenche em vez do período):</p>
      <p><input type="text" id="numero" style="width: 95%; padding: 4px;" placeholder="Número da NF, ex: 059467"></p>
      <button onclick="processar()">Buscar</button>
      <p id="resultado" style="color: #333; font-weight: bold;"></p>
    </div>
    <script>
      function processar() {
        var desde  = document.getElementById('desde').value;
        var ate    = document.getElementById('ate').value;
        var numero = document.getElementById('numero').value.trim();
        if (!desde && !ate && !numero) return;
        document.getElementById('resultado').innerText = 'Buscando...';
        google.script.run
          .withSuccessHandler(function(msg) { document.getElementById('resultado').innerText = msg; })
          .withFailureHandler(function(err) { document.getElementById('resultado').innerText = 'Erro: ' + err.message; })
          .processarBuscarNFDialog(desde, ate, numero);
      }
    </script>
  `;
  const output = HtmlService.createHtmlOutput(html).setWidth(420).setHeight(320);
  SpreadsheetApp.getUi().showModalDialog(output, 'Buscar NF de Compra (Tiny)');
}

function processarBuscarNFDialog(desde, ate, numero) {
  try {
    if (numero) return buscarNfPersonalizado(null, null, numero);
    if (desde || ate) return buscarNfPersonalizado(desde || null, ate || null, null);
    return 'Preencha um período ou um número de NF.';
  } catch (e) {
    Logger.log('Erro processarBuscarNFDialog: ' + e.stack);
    return '❌ Erro: ' + e.message;
  }
}

// Limite de NFs processadas por execução. Cada NF custa pelo menos 2
// chamadas (detalhe + impostos por item, em média ~3-4 itens/NF) — um
// período de vários meses (centenas de NFs) gera milhares de chamadas e
// estoura o limite de 6 minutos de execução do Apps Script. Acima do limite,
// processa só as NFs mais antigas do período e devolve o restante pra
// continuar numa próxima chamada (a gravação é merge, então nada se perde).
const _MAX_NF_POR_EXECUCAO = 100;

// Processa 1 lote (até _MAX_NF_POR_EXECUCAO NFs, as mais antigas do período) e
// grava (merge). Devolve dado estruturado -- usado tanto pelo diálogo manual
// (buscarNfPersonalizado, que formata como mensagem pro usuário) quanto pelo
// trigger diário automático (que precisa saber programaticamente se sobrou
// NF e a partir de qual data continuar, pra encadear os lotes sozinho, sem
// ninguém clicando "rodar de novo").
function _processarLoteNF(dataInicio, dataFim, numero, ss) {
  const nfHeaders = _listarNfIds(null, dataInicio, dataFim, numero);
  if (!nfHeaders.length) {
    return { encontradas: 0, processadas: 0, skus: 0, totalCache: 0, restante: false, ultimaData: null };
  }

  nfHeaders.sort((a, b) => (a.data || '').localeCompare(b.data || ''));
  const totalEncontradas = nfHeaders.length;
  const restante = totalEncontradas > _MAX_NF_POR_EXECUCAO;
  const lote = restante ? nfHeaders.slice(0, _MAX_NF_POR_EXECUCAO) : nfHeaders;

  const costMap = _processarNfHeaders(lote, ss);
  const final = _gravarCacheNF(costMap, true);

  return {
    encontradas: totalEncontradas,
    processadas: lote.length,
    skus: Object.keys(costMap).length,
    totalCache: Object.keys(final).length,
    restante,
    ultimaData: lote[lote.length - 1].data,
  };
}

function buscarNfPersonalizado(dataInicio, dataFim, numero) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const label = numero ? `NF ${numero}` : `${dataInicio || '...'} até ${dataFim || 'hoje'}`;
  ss.toast(`Buscando ${label}...`, 'BouwObra', -1);

  const r = _processarLoteNF(dataInicio, dataFim, numero, ss);
  if (r.encontradas === 0) {
    return `❌ Nenhuma NF encontrada para ${label}.`;
  }

  if (!r.restante) {
    return `✅ ${label}: ${r.processadas} NF(s) lida(s), ${r.skus} SKU(s) processado(s) `
         + `(${r.totalCache} no cache total agora).`;
  }

  return `⚠️ Período grande (${r.encontradas} NFs) — processei as ${r.processadas} mais antigas (até ${r.ultimaData}). `
       + `${r.skus} SKU(s) atualizados agora (${r.totalCache} no cache total). `
       + `Rode de novo com início ${r.ultimaData} até ${dataFim || 'hoje'} para continuar o restante.`;
}

// ── Busca diária automática (trigger) ──────────────────────────────────────────
//
// Acha a data mais recente já cacheada (maior "NF Data" entre todos os SKUs
// da aba Cache NF) e busca NFs dessa data até hoje, encadeando os lotes de
// _MAX_NF_POR_EXECUCAO sozinho dentro da mesma execução (diferente do diálogo
// manual, aqui não tem ninguém pra clicar "rodar de novo"). Pára com margem
// de segurança antes do limite de 6 min do Apps Script -- se sobrar NF, a
// próxima execução do trigger continua de onde parou (a data mais recente
// cacheada vai ter avançado, então não reprocessa do zero).
const _TEMPO_LIMITE_TRIGGER_MS = 5 * 60 * 1000;

function _ultimaDataCacheNF() {
  const cache = lerCacheNF();
  let maior = '';
  Object.values(cache).forEach(c => {
    if (c.nfData && c.nfData > maior) maior = c.nfData;
  });
  return maior;
}

function buscarNfNovasDoDia() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const inicioExecucao = new Date().getTime();
  const hojeStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'America/Sao_Paulo', 'yyyy-MM-dd');

  let desde = _ultimaDataCacheNF() || hojeStr;
  let totalProcessadas = 0, totalSkus = 0, lotes = 0, encontradasUltimoLote = 0;

  while (true) {
    if (new Date().getTime() - inicioExecucao > _TEMPO_LIMITE_TRIGGER_MS) {
      Logger.log(`buscarNfNovasDoDia: parou por tempo (${lotes} lote(s)) -- continua de ${desde} na próxima execução.`);
      break;
    }

    const r = _processarLoteNF(desde, hojeStr, null, ss);
    lotes++;
    encontradasUltimoLote = r.encontradas;
    if (r.encontradas === 0) break;

    totalProcessadas += r.processadas;
    totalSkus += r.skus;
    if (!r.restante) break;
    desde = r.ultimaData; // encadeia o próximo lote a partir daqui, sem intervenção manual
  }

  const msg = `Busca diária de NF (${desde} até ${hojeStr}): ${totalProcessadas} NF(s) processada(s) `
            + `em ${lotes} lote(s), ${totalSkus} SKU(s) atualizados.`;
  Logger.log(msg);
  return msg;
}

// Lê o cache já gravado (rápido, sem chamada de API)
function lerCacheNF() {
  const ws = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ABA_CACHE_NF);
  if (!ws || ws.getLastRow() < 2) return {};
  const dados = ws.getRange(2, 1, ws.getLastRow() - 1, HEADERS_CACHE_NF.length).getValues();
  const map = {};
  dados.forEach(row => {
    const sku = String(row[0]).trim();
    if (!sku) return;
    map[sku] = {
      custoBase:     parseFloat(row[1]) || 0,
      ipiValor:      parseFloat(row[2]) || 0,
      icmsCredito:   parseFloat(row[3]) || 0,
      pisCredito:    parseFloat(row[4]) || 0,
      cofinsCredito: parseFloat(row[5]) || 0,
      nfNumero:      String(row[6]),
      nfData:        _normalizarDataISO(row[7]),
    };
  });
  return map;
}
