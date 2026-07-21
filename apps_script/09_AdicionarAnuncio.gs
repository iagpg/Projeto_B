// ============================================================
// 09_AdicionarAnuncio.gs — Adicionar anúncio manualmente (MLB ou Family ID)
// ============================================================
//
// Diálogo modal (mesmo padrão de 08_Autorizacao.gs): o usuário cola um MLB ID
// (anúncio individual) ou um Family ID (grupo de variações) e clica em
// Adicionar — a linha (ou o bloco pai+variações) é gravada direto na
// Precificação, sem precisar de uma aba/célula fixa auxiliar.

function mostrarDialogoAdicionarAnuncio() {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 13px; padding: 4px;">
      <p>Cole o <b>MLB ID</b> (ex: MLB3633227036) ou o <b>Family ID</b>
         (14+ dígitos) do anúncio:</p>
      <input type="text" id="valor" style="width: 95%; padding: 4px;"
             placeholder="MLB3633227036 ou 8548824233871185">
      <br><br>
      <button onclick="processar()">Adicionar</button>
      <p id="resultado" style="color: #333; font-weight: bold;"></p>
    </div>
    <script>
      function processar() {
        var valor = document.getElementById('valor').value.trim();
        if (!valor) return;
        document.getElementById('resultado').innerText = 'Processando ' + valor + '...';
        google.script.run
          .withSuccessHandler(function(msg) { document.getElementById('resultado').innerText = msg; })
          .withFailureHandler(function(err) { document.getElementById('resultado').innerText = 'Erro: ' + err.message; })
          .processarAdicionarAnuncioDialog(valor);
      }
    </script>
  `;
  const output = HtmlService.createHtmlOutput(html).setWidth(420).setHeight(210);
  SpreadsheetApp.getUi().showModalDialog(output, 'Adicionar Anúncio à Precificação');
}

function processarAdicionarAnuncioDialog(bruto) {
  bruto = String(bruto || '').trim();
  if (!bruto) return 'Cole um MLB ID ou Family ID.';

  // Mesma convenção de scripts/check_promotions.py: 7-13 dígitos = anúncio
  // individual, 14+ dígitos = grupo de variações (family_id).
  const digitos = bruto.replace(/\D/g, '');
  const ehGrupo = digitos.length >= 14;

  try {
    if (ehGrupo) {
      return _adicionarGrupoVariacoes(digitos);
    }
    const mlbId = bruto.toUpperCase().startsWith('MLB') ? bruto.toUpperCase() : ('MLB' + digitos);
    return _adicionarAnuncioIndividual(mlbId);
  } catch (e) {
    Logger.log('Erro processarAdicionarAnuncioDialog: ' + e.stack);
    return '❌ Erro: ' + e.message;
  }
}

function _buscarAnuncio(mlbId) {
  return mlGet(`/items/${mlbId}`, {
    attributes: 'id,title,price,status,category_id,seller_sku,attributes,listing_type_id',
  });
}

// ── Anúncio individual ────────────────────────────────────────────────────────

function _adicionarAnuncioIndividual(mlbId) {
  const item = _buscarAnuncio(mlbId);
  if (!item || !item.id) {
    return '❌ Anúncio não encontrado: ' + mlbId;
  }

  const sku = extrairSellerSku(item);
  if (!sku) {
    return '❌ Anúncio ' + mlbId + ' não tem SKU cadastrado (campo "Código" vazio no ML).';
  }

  const custoData = lerCacheNF()[sku] || null;
  const simulacao = lerSimulacoesPreco()[sku] || null;
  const precoOverride = simulacao ? simulacao.precoSimulado : null;
  const mlData = montarMlDataCompleto(
    item.id, item.title, item.status, item.category_id, item.listing_type_id,
    parseFloat(item.price) || 0, precoOverride
  );
  const timestamp = new Date().toLocaleString('pt-BR');
  const [row, uncertainCols] = calcularLinha(sku, mlData, custoData, timestamp);

  const linhaGravada = _gravarOuAtualizarLinha(row, uncertainCols);
  return '✅ ' + mlbId + ' (SKU ' + sku + ') gravado na linha ' + linhaGravada + ' da Precificação.'
       + (simulacao ? ` (simulação ativa: R$ ${simulacao.precoSimulado.toFixed(2)})` : '');
}

// Grava uma linha na Precificação: atualiza no lugar se o SKU já existir
// (coluna B), senão adiciona ao final. Retorna o número da linha gravada.
function _gravarOuAtualizarLinha(row, uncertainCols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(ABA_PRECIFICACAO);
  if (!ws) ws = ss.insertSheet(ABA_PRECIFICACAO);

  if (ws.getLastRow() < 1) {
    ws.getRange(1, 1, 1, HEADERS_PREC.length).setValues([HEADERS_PREC]);
    ws.setFrozenRows(1);
  }

  const sku = row[1];
  const lastRow = ws.getLastRow();
  let targetRow = lastRow + 1;
  if (lastRow >= 2) {
    const skus = ws.getRange(2, 2, lastRow - 1, 1).getValues().map(r => r[0]);
    const idx = skus.indexOf(sku);
    if (idx >= 0) targetRow = idx + 2;
  }

  ws.getRange(targetRow, 1, 1, HEADERS_PREC.length).setValues([row]);
  ws.getRange(targetRow, 1, 1, HEADERS_PREC.length).setBackgrounds([_coresParaLinha(row, uncertainCols)]);
  _aplicarDropdownStatus(ws, targetRow, 1);
  _formatarColunas(ws, targetRow - 1);
  ws.getRange(targetRow, 6).setNote(_textoNotaSimulacao(lerSimulacoesPreco()[sku]));

  return targetRow;
}

// ── Grupo de variações (Family ID) ────────────────────────────────────────────
//
// GET /sites/MLB/user-products-families/{familyId} retorna os user_products_ids
// (uma "User Product" por variação) direto, sem precisar escanear o catálogo.
// Cada user_product_id é então resolvido pro MLB ID ativo via
// /users/{seller}/items/search?user_product_id=X — esse filtro (ao contrário de
// family_id) funciona de verdade. Às vezes retorna 2 itens pro mesmo
// user_product_id (o anúncio antigo fechado por migração + o atual) — fica
// com o de melhor status (ativo > pausado > fechado).
const _ORDEM_STATUS_ = { active: 0, paused: 1, closed: 2 };

function _resolverMembrosPorFamilia(familyId) {
  const fam = mlGet(`/sites/MLB/user-products-families/${familyId}`, {});
  const upIds = (fam && fam.user_products_ids) || [];
  if (!upIds.length) return [];

  const membros = [];
  upIds.forEach(upId => {
    const data = mlGet(`/users/${ML_USER_ID_PROP()}/items/search`, { user_product_id: upId });
    const ids = (data && data.results) || [];
    if (!ids.length) return;
    if (ids.length === 1) { membros.push(ids[0]); return; }

    const detalhes = mlGetBatch(ids, 'id,status');
    detalhes.sort((a, b) => (_ORDEM_STATUS_[a.status] ?? 9) - (_ORDEM_STATUS_[b.status] ?? 9));
    if (detalhes.length) membros.push(detalhes[0].id);
    Utilities.sleep(30);
  });
  return membros;
}

// Fallback: só usado se o endpoint de família acima falhar/vier vazio.
// Escaneia TODOS os itens do vendedor e compara o campo family_id item a item
// (a paginação normal trava em offset ~1000 — usa search_type=scan + scroll_id).
function _resolverMembrosPorVarredura(familyId) {
  const allIds = [];
  let data = mlGet(`/users/${ML_USER_ID_PROP()}/items/search`, { search_type: 'scan', limit: 100 });
  allIds.push(...((data && data.results) || []));
  let scrollId = data && data.scroll_id;

  while (scrollId) {
    data = mlGet(`/users/${ML_USER_ID_PROP()}/items/search`, { search_type: 'scan', scroll_id: scrollId, limit: 100 });
    const results = (data && data.results) || [];
    if (!results.length) break;
    allIds.push(...results);
    scrollId = data.scroll_id;
    Utilities.sleep(50);
  }

  const membros = [];
  for (let i = 0; i < allIds.length; i += 20) {
    const chunk = allIds.slice(i, i + 20);
    const items = mlGetBatch(chunk, 'id,family_id');
    items.forEach(item => {
      if (item.family_id && String(item.family_id) === String(familyId)) membros.push(item.id);
    });
    Utilities.sleep(50);
  }
  return membros;
}

function _buscarVariacoesGrupo(familyId) {
  try {
    const membros = _resolverMembrosPorFamilia(familyId);
    if (membros.length) return membros;
  } catch (e) {
    Logger.log('Aviso: endpoint de familia falhou, caindo pra varredura: ' + e.message);
  }
  return _resolverMembrosPorVarredura(familyId);
}

// Calcula o bloco pai+variações de uma família (puro — não escreve na planilha).
// Retorna { erro } se não achar nada, ou { paiRow, paiUncertain, linhasVariacoes,
// uncertainVariacoes, semSkuCount }.
function _construirBlocoGrupo(familyId) {
  const mlbIds = _buscarVariacoesGrupo(familyId);
  if (!mlbIds.length) {
    return { erro: 'Nenhuma variação encontrada para o Family ID ' + familyId };
  }

  const cacheNF = lerCacheNF();
  const simulacoes = lerSimulacoesPreco();
  const timestamp = new Date().toLocaleString('pt-BR');
  const linhas = []; // [row, uncertainCols]
  const semSku = [];

  mlbIds.forEach(mlbId => {
    const item = _buscarAnuncio(mlbId);
    if (!item || !item.id) return;
    const sku = extrairSellerSku(item);
    if (!sku) { semSku.push(mlbId); return; }

    const custoData = cacheNF[sku] || null;
    const precoOverride = simulacoes[sku] ? simulacoes[sku].precoSimulado : null;
    const mlData = montarMlDataCompleto(
      item.id, item.title, item.status, item.category_id, item.listing_type_id,
      parseFloat(item.price) || 0, precoOverride
    );
    linhas.push(calcularLinha(sku, mlData, custoData, timestamp));
  });

  if (!linhas.length) {
    return { erro: 'Nenhuma variação com SKU cadastrado no grupo ' + familyId };
  }

  // Linha "pai" = média das colunas numéricas (E..V) — cada variação pode ter
  // preço praticado, frete e custo diferentes entre si.
  const NUMERIC_COLS = [];
  for (let c = 4; c <= 21; c++) NUMERIC_COLS.push(c);

  const primeiraLinha = linhas[0][0];
  const paiRow = new Array(HEADERS_PREC.length).fill('');
  paiRow[0] = 'GRUPO ' + familyId;
  paiRow[1] = linhas.length + ' variações';
  paiRow[2] = primeiraLinha[2];
  paiRow[3] = primeiraLinha[3];
  NUMERIC_COLS.forEach(col => {
    const soma = linhas.reduce((s, [row]) => s + (parseFloat(row[col]) || 0), 0);
    paiRow[col] = _r2(soma / linhas.length);
  });
  paiRow[STATUS_COL_IDX] = primeiraLinha[STATUS_COL_IDX];
  paiRow[HEADERS_PREC.length - 1] = timestamp;

  // Se qualquer variação teve um valor estimado numa coluna, o "pai" (média)
  // herda essa incerteza também.
  const paiUncertain = [...new Set(linhas.flatMap(([, cols]) => cols))];

  return {
    paiRow, paiUncertain,
    linhasVariacoes: linhas.map(([row]) => row),
    uncertainVariacoes: linhas.map(([, cols]) => cols),
    semSkuCount: semSku.length,
  };
}

// Escreve o bloco pai+variações a partir de `startRow` (sobrescreve o que já
// estiver lá) e reagrupa as linhas de variação. Usado tanto pra adicionar
// (startRow = fim da planilha) quanto pra atualizar em lugar.
function _escreverBlocoGrupo(ws, startRow, bloco) {
  const todasLinhas    = [bloco.paiRow, ...bloco.linhasVariacoes];
  const todosUncertain = [bloco.paiUncertain, ...bloco.uncertainVariacoes];

  ws.getRange(startRow, 1, todasLinhas.length, HEADERS_PREC.length).setValues(todasLinhas);
  const cores = todasLinhas.map((row, i) => _coresParaLinha(row, todosUncertain[i]));
  ws.getRange(startRow, 1, todasLinhas.length, HEADERS_PREC.length).setBackgrounds(cores);
  _aplicarDropdownStatus(ws, startRow, todasLinhas.length);
  _formatarColunas(ws, startRow + todasLinhas.length - 1);

  const simulacoes = lerSimulacoesPreco();
  const notas = todasLinhas.map(row => [_textoNotaSimulacao(simulacoes[row[1]])]); // '' pra linha "pai" (sem SKU real)
  ws.getRange(startRow, 6, todasLinhas.length, 1).setNotes(notas);

  if (bloco.linhasVariacoes.length) {
    try {
      const rangeVariacoes = ws.getRange(startRow + 1, 1, bloco.linhasVariacoes.length, 1);
      rangeVariacoes.shiftRowGroupDepth(1);
      ws.getRowGroup(startRow + 1, 1).collapse();
    } catch (e) {
      Logger.log('Aviso: nao foi possivel agrupar/recolher as linhas: ' + e.message);
    }
  }
}

// Acha a extensão (início/fim) do bloco de um grupo já gravado, a partir da
// linha do "pai", usando a profundidade de agrupamento das linhas de variação
// (que ficam recolhidas logo abaixo dele).
function _acharBlocoGrupo(ws, paiRow) {
  const lastRow = ws.getLastRow();
  let fim = paiRow;
  for (let r = paiRow + 1; r <= lastRow; r++) {
    if (ws.getRowGroupDepth(r) < 1) break;
    fim = r;
  }
  return { inicio: paiRow, fim };
}

// Acha a linha do "pai" de um grupo já gravado na Precificação (coluna A ==
// "GRUPO {familyId}"), ou -1 se o grupo ainda não existir na planilha.
function _acharPaiGrupo(ws, familyId) {
  const lastRow = ws.getLastRow();
  if (lastRow < 2) return -1;
  const marcador = 'GRUPO ' + familyId;
  const colA = ws.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < colA.length; i++) {
    if (String(colA[i][0]) === marcador) return i + 2;
  }
  return -1;
}

// Recalcula um grupo e sobrescreve o bloco existente (inicioAntigo..fimAntigo),
// ajustando o número de linhas se a quantidade de variações mudou. Retorna o
// número de linhas do bloco novo (pai + variações).
function _atualizarGrupoNaPosicao(ws, inicioAntigo, fimAntigo, familyId) {
  const bloco = _construirBlocoGrupo(familyId);
  if (bloco.erro) throw new Error(bloco.erro);

  const nAntigo = fimAntigo - inicioAntigo + 1;
  const nNovo = 1 + bloco.linhasVariacoes.length;

  // Remove o agrupamento antigo das linhas de variação antes de mexer no tamanho
  if (fimAntigo > inicioAntigo) {
    const grupoAntigo = ws.getRowGroup(inicioAntigo + 1, 1);
    if (grupoAntigo) grupoAntigo.remove();
  }

  if (nNovo > nAntigo) {
    ws.insertRowsAfter(inicioAntigo, nNovo - nAntigo);
  } else if (nNovo < nAntigo) {
    ws.deleteRows(inicioAntigo + nNovo, nAntigo - nNovo);
  }

  _escreverBlocoGrupo(ws, inicioAntigo, bloco);
  return nNovo;
}

// Adiciona um grupo novo, ou atualiza em lugar se o Family ID já existir na
// Precificação (evita duplicar ao colar o mesmo Family ID de novo).
function _adicionarGrupoVariacoes(familyId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(ABA_PRECIFICACAO);
  if (!ws) ws = ss.insertSheet(ABA_PRECIFICACAO);
  if (ws.getLastRow() < 1) {
    ws.getRange(1, 1, 1, HEADERS_PREC.length).setValues([HEADERS_PREC]);
    ws.setFrozenRows(1);
  }

  const paiExistente = _acharPaiGrupo(ws, familyId);
  if (paiExistente > 0) {
    const antigo = _acharBlocoGrupo(ws, paiExistente);
    try {
      const n = _atualizarGrupoNaPosicao(ws, antigo.inicio, antigo.fim, familyId);
      return `✅ Grupo ${familyId} atualizado (linha ${paiExistente}, ${n - 1} variações).`;
    } catch (e) {
      return '❌ ' + e.message;
    }
  }

  const bloco = _construirBlocoGrupo(familyId);
  if (bloco.erro) return '❌ ' + bloco.erro;

  const startRow = ws.getLastRow() + 1;
  _escreverBlocoGrupo(ws, startRow, bloco);

  let msg = `✅ Grupo ${familyId}: pai + ${bloco.linhasVariacoes.length} variações adicionadas (linha ${startRow}).`;
  if (bloco.semSkuCount) msg += ` ${bloco.semSkuCount} variação(ões) sem SKU ignorada(s).`;
  return msg;
}

// ── Atualizar linha(s) selecionada(s) ─────────────────────────────────────────
//
// Reprocessa só o que está selecionado na aba Precificação (1 SKU individual,
// ou o bloco inteiro de um grupo se a linha "pai" — "GRUPO ..." — estiver na
// seleção), sem tocar no resto da planilha. Útil pra "essa NF não existia
// quando adicionei, agora existe — quero atualizar só esse item".

function atualizarSelecionadas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = ss.getSheetByName(ABA_PRECIFICACAO);
  const abaAtiva = ss.getActiveSheet();

  if (!ws || abaAtiva.getName() !== ABA_PRECIFICACAO) {
    ss.toast('Selecione linha(s) na aba Precificação primeiro.', 'BouwObra', 8);
    return;
  }

  const sel = ss.getActiveRange();
  if (!sel) {
    ss.toast('Nenhuma linha selecionada.', 'BouwObra', 6);
    return;
  }

  let r = Math.max(sel.getRow(), 2); // nunca processa o cabeçalho
  let fimVarredura = sel.getRow() + sel.getNumRows() - 1;

  let atualizados = 0;
  const erros = [];

  while (r <= fimVarredura) {
    const colA = String(ws.getRange(r, 1).getValue() || '').trim();

    if (colA.startsWith('GRUPO ')) {
      const familyId = colA.replace('GRUPO ', '').trim();
      const antigo = _acharBlocoGrupo(ws, r);
      const nAntigo = antigo.fim - antigo.inicio + 1;
      try {
        const nNovo = _atualizarGrupoNaPosicao(ws, antigo.inicio, antigo.fim, familyId);
        fimVarredura += (nNovo - nAntigo);
        r = antigo.inicio + nNovo;
        atualizados++;
      } catch (e) {
        erros.push(familyId);
        Logger.log('Erro ao atualizar grupo ' + familyId + ': ' + e.stack);
        r = antigo.fim + 1;
      }
      continue;
    }

    if (colA.toUpperCase().startsWith('MLB')) {
      try {
        _adicionarAnuncioIndividual(colA.toUpperCase());
        atualizados++;
      } catch (e) {
        erros.push(colA);
        Logger.log('Erro ao atualizar ' + colA + ': ' + e.stack);
      }
    }
    r++;
  }

  let msg = atualizados
    ? `✅ ${atualizados} item(ns) atualizado(s).`
    : 'Nenhum SKU/grupo reconhecido na seleção (coluna A precisa ser um MLB ID ou "GRUPO ...").';
  if (erros.length) msg += ` ${erros.length} erro(s): ${erros.join(', ')} (ver Execuções para detalhes).`;
  ss.toast(msg, 'BouwObra', 10);
}
