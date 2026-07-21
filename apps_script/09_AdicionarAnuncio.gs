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
      <p style="color: #777; font-size: 11px;">Family ID pode demorar — a API não filtra por
         grupo, então é preciso escanear todos os anúncios do vendedor.</p>
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
  const output = HtmlService.createHtmlOutput(html).setWidth(420).setHeight(250);
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
  const mlData = montarMlDataCompleto(
    item.id, item.title, item.status, item.category_id, item.listing_type_id,
    parseFloat(item.price) || 0
  );
  const timestamp = new Date().toLocaleString('pt-BR');
  const [row, uncertainCols] = calcularLinha(sku, mlData, custoData, timestamp);

  const linhaGravada = _gravarOuAtualizarLinha(row, uncertainCols);
  return '✅ ' + mlbId + ' (SKU ' + sku + ') gravado na linha ' + linhaGravada + ' da Precificação.';
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
//
// O parâmetro family_id no endpoint de busca é ignorado pela API ML (retorna o
// catálogo inteiro, sem filtrar) — confirmado tanto aqui quanto em
// scripts/check_promotions.py. A única forma confiável é escanear TODOS os
// itens do vendedor e comparar o campo family_id item a item.
//
// A paginação normal (limit/offset) trava em offset ~1000 (erro 400) — acima
// disso é preciso usar search_type=scan + scroll_id (paginação tipo Elasticsearch).

function _buscarVariacoesGrupo(familyId) {
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

function _adicionarGrupoVariacoes(familyId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const mlbIds = _buscarVariacoesGrupo(familyId);
  if (!mlbIds.length) {
    return '❌ Nenhuma variação encontrada para o Family ID ' + familyId;
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
    return '❌ Nenhuma variação com SKU cadastrado no grupo ' + familyId;
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

  let msg = '✅ Grupo ' + familyId + ': pai + ' + linhas.length + ' variações adicionadas (linha ' + startRow + ').';
  if (semSku.length) msg += ' ' + semSku.length + ' variação(ões) sem SKU ignorada(s).';
  return msg;
}
