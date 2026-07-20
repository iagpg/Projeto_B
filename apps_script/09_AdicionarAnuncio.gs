// ============================================================
// 09_AdicionarAnuncio.gs — Adicionar anúncio manualmente (MLB ou Family ID)
// ============================================================
//
// Aba separada da Precificação de propósito: a Precificação é reescrita do
// zero (ws.clearContents/clearFormats) a cada Sincronizar Tudo, então qualquer
// área fixa dentro dela seria apagada. Aqui o usuário cola um MLB ID (anúncio
// individual) ou um Family ID / item_group_id (grupo de variações) e roda pelo
// menu — a linha (ou o bloco pai+variações) é gravada direto na Precificação.

const ABA_ADICIONAR       = 'Adicionar Anúncio';
const ADICIONAR_INPUT_CELL = 'B3';

function garantirAbaAdicionar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(ABA_ADICIONAR);
  if (ws) return ws;

  ws = ss.insertSheet(ABA_ADICIONAR);
  ws.getRange('A1').setValue('Adicionar anúncio manualmente à Precificação')
    .setFontWeight('bold').setFontSize(13);
  ws.getRange('A3').setValue('Cole aqui →').setFontWeight('bold');
  ws.getRange('A5').setValue(
    'Depois de colar, use o menu BouwObra → ➕ Adicionar Anúncio.\n\n' +
    'MLB ID (ex: MLB3633227036) → adiciona ou atualiza 1 linha na Precificação.\n\n' +
    'Family ID / item_group_id (14+ dígitos) → adiciona a linha "pai" (média das ' +
    'variações) + uma linha por variação, agrupadas — use o "+"/"−" que aparece ' +
    'na lateral esquerda da planilha para expandir/recolher.'
  ).setWrap(true);
  ws.setColumnWidth(1, 500);
  ws.getRange(ADICIONAR_INPUT_CELL).setBackground('#fff3cd').setFontWeight('bold');
  return ws;
}

function adicionarAnuncioManual() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ws = garantirAbaAdicionar();
  const bruto = String(ws.getRange(ADICIONAR_INPUT_CELL).getValue() || '').trim();

  if (!bruto) {
    ss.toast('Cole um MLB ID ou Family ID na célula ' + ADICIONAR_INPUT_CELL + ' antes de rodar.', 'BouwObra', 8);
    return;
  }

  // Mesma convenção de scripts/check_promotions.py: 7-13 dígitos = anúncio
  // individual, 14+ dígitos = grupo de variações (family_id / item_group_id).
  const digitos = bruto.replace(/\D/g, '');
  const ehGrupo = digitos.length >= 14;

  ss.toast('Processando ' + bruto + '...', 'BouwObra', -1);

  try {
    if (ehGrupo) {
      _adicionarGrupoVariacoes(digitos);
    } else {
      const mlbId = bruto.toUpperCase().startsWith('MLB') ? bruto.toUpperCase() : ('MLB' + digitos);
      _adicionarAnuncioIndividual(mlbId);
    }
  } catch (e) {
    ss.toast('Erro: ' + e.message, 'BouwObra', 10);
    Logger.log('Erro adicionarAnuncioManual: ' + e.stack);
  }
}

function _buscarAnuncio(mlbId) {
  return mlGet(`/items/${mlbId}`, {
    attributes: 'id,title,price,status,category_id,seller_sku,attributes,listing_type_id',
  });
}

// ── Anúncio individual ────────────────────────────────────────────────────────

function _adicionarAnuncioIndividual(mlbId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const item = _buscarAnuncio(mlbId);
  if (!item || !item.id) {
    ss.toast('Anúncio não encontrado: ' + mlbId, 'BouwObra', 8);
    return;
  }

  const sku = extrairSellerSku(item);
  if (!sku) {
    ss.toast('Anúncio ' + mlbId + ' não tem SKU cadastrado (campo "Código" vazio no ML).', 'BouwObra', 10);
    return;
  }

  const custoData = lerCacheNF()[sku] || null;
  const mlData = montarMlDataCompleto(
    item.id, item.title, item.status, item.category_id, item.listing_type_id,
    parseFloat(item.price) || 0
  );
  const timestamp = new Date().toLocaleString('pt-BR');
  const [row, uncertainCols] = calcularLinha(sku, mlData, custoData, timestamp);

  const linhaGravada = _gravarOuAtualizarLinha(row, uncertainCols);
  ss.toast('✅ ' + mlbId + ' (SKU ' + sku + ') gravado na linha ' + linhaGravada + ' da Precificação.', 'BouwObra', 8);
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

  return targetRow;
}

// ── Grupo de variações (Family ID) ────────────────────────────────────────────

function _buscarVariacoesGrupo(itemGroupId) {
  const data = mlGet(`/users/${ML_USER_ID_PROP()}/items/search`, { item_group_id: itemGroupId });
  return (data && data.results) || [];
}

function _adicionarGrupoVariacoes(itemGroupId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mlbIds = _buscarVariacoesGrupo(itemGroupId);
  if (!mlbIds.length) {
    ss.toast('Nenhuma variação encontrada para o Family ID ' + itemGroupId, 'BouwObra', 8);
    return;
  }

  const cacheNF = lerCacheNF();
  const timestamp = new Date().toLocaleString('pt-BR');
  const linhas = []; // [row, uncertainCols]
  const semSku = [];

  mlbIds.forEach(mlbId => {
    const item = _buscarAnuncio(mlbId);
    if (!item || !item.id) return;
    const sku = extrairSellerSku(item);
    if (!sku) { semSku.push(mlbId); return; }

    const custoData = cacheNF[sku] || null;
    const mlData = montarMlDataCompleto(
      item.id, item.title, item.status, item.category_id, item.listing_type_id,
      parseFloat(item.price) || 0
    );
    linhas.push(calcularLinha(sku, mlData, custoData, timestamp));
  });

  if (!linhas.length) {
    ss.toast('Nenhuma variação com SKU cadastrado no grupo ' + itemGroupId, 'BouwObra', 10);
    return;
  }

  // Linha "pai" = média das colunas numéricas (E..V) — cada variação pode ter
  // preço praticado, frete e custo diferentes entre si.
  const NUMERIC_COLS = [];
  for (let c = 4; c <= 21; c++) NUMERIC_COLS.push(c);

  const primeiraLinha = linhas[0][0];
  const paiRow = new Array(HEADERS_PREC.length).fill('');
  paiRow[0] = 'GRUPO ' + itemGroupId;
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

  let ws = ss.getSheetByName(ABA_PRECIFICACAO);
  if (!ws) ws = ss.insertSheet(ABA_PRECIFICACAO);
  if (ws.getLastRow() < 1) {
    ws.getRange(1, 1, 1, HEADERS_PREC.length).setValues([HEADERS_PREC]);
    ws.setFrozenRows(1);
  }
  const startRow = ws.getLastRow() + 1;

  const todasLinhas    = [paiRow, ...linhas.map(([row]) => row)];
  const todosUncertain = [paiUncertain, ...linhas.map(([, cols]) => cols)];

  ws.getRange(startRow, 1, todasLinhas.length, HEADERS_PREC.length).setValues(todasLinhas);
  const cores = todasLinhas.map((row, i) => _coresParaLinha(row, todosUncertain[i]));
  ws.getRange(startRow, 1, todasLinhas.length, HEADERS_PREC.length).setBackgrounds(cores);
  _aplicarDropdownStatus(ws, startRow, todasLinhas.length);
  _formatarColunas(ws, startRow + todasLinhas.length - 1);

  // Agrupa as linhas de variação (não a linha "pai") para poder recolher/expandir
  try {
    const rangeVariacoes = ws.getRange(startRow + 1, 1, linhas.length, 1);
    rangeVariacoes.shiftRowGroupDepth(1);
    ws.getRowGroup(startRow + 1, 1).collapse();
  } catch (e) {
    Logger.log('Aviso: nao foi possivel agrupar/recolher as linhas: ' + e.message);
  }

  let msg = '✅ Grupo ' + itemGroupId + ': pai + ' + linhas.length + ' variações adicionadas (linha ' + startRow + ').';
  if (semSku.length) msg += ' ' + semSku.length + ' variação(ões) sem SKU ignorada(s).';
  ss.toast(msg, 'BouwObra', 10);
}
