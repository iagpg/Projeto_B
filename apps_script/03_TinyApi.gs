// ============================================================
// 03_TinyApi.gs — Tiny ERP: produtos e Notas Fiscais
// ============================================================

// ── Produtos ──────────────────────────────────────────────────────────────────

function getTinyProdutos() {
  const todos = [];
  let pagina = 1;
  while (true) {
    const data = tinyGet('/produtos', { situacao: 'A', pagina: pagina, limite: 100 });
    const inner = (data.data) || data;
    const itens = inner.itens || inner.produtos || inner.items || (Array.isArray(inner) ? inner : []);
    if (!itens.length) break;
    todos.push(...itens);
    const pag = inner.paginacao || inner.pagination || {};
    const totalPag = parseInt(pag.totalPaginas || pag.totalPages || 1, 10);
    if (pagina >= totalPag) break;
    pagina++;
    Utilities.sleep(150);
  }
  return todos;
}

function extrairSkuTiny(produto) {
  return String(produto.codigo || produto.sku || produto.code || '').trim();
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

// Retorna lista de {id, numero, data} das NFs de entrada autorizadas
function _listarNfIds(mesesAtras) {
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setMonth(inicio.getMonth() - mesesAtras);
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

  const nfHeaders = [];
  let pagina = 1;
  while (true) {
    const data = tinyGet('/notas-fiscais', {
      tipo:       'E',
      situacao:   'A',
      dataInicio: fmt(inicio),
      dataFim:    fmt(hoje),
      pagina:     pagina,
      limite:     100,
    });
    const inner = (data.data) || data;
    const itens = inner.itens || inner.notas || inner.items || (Array.isArray(inner) ? inner : []);
    if (!itens.length) break;
    nfHeaders.push(...itens.map(n => ({
      id:     n.id,
      numero: String(n.numero || n.number || ''),
      data:   String(n.dataEmissao || n.data || n.date || ''),
    })));
    const pag = inner.paginacao || inner.pagination || {};
    const totalPag = parseInt(pag.totalPaginas || pag.totalPages || 1, 10);
    if (pagina >= totalPag) break;
    pagina++;
    Utilities.sleep(150);
  }
  return nfHeaders;
}

// ── Build do Cache de Custos ───────────────────────────────────────────────────

// Roda as NFs em paralelo (fetchAll em lotes de 30) e grava na aba "Cache NF"
function atualizarCacheNF() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Buscando notas fiscais de entrada...', 'BouwObra', -1);

  const nfHeaders = _listarNfIds(12);
  ss.toast(`${nfHeaders.length} NFs encontradas. Buscando detalhes...`, 'BouwObra', -1);

  const costMap = {}; // sku → {custoBase, ipiPct, icmsPct, nfNumero, nfData}
  const BATCH = 30;

  for (let i = 0; i < nfHeaders.length; i += BATCH) {
    const lote = nfHeaders.slice(i, i + BATCH);
    const respostas = tinyGetNfsParalelo(lote.map(n => n.id));

    respostas.forEach((resp, j) => {
      if (!resp) return;
      const nfHdr = lote[j];
      const inner = resp.data || resp;
      const nota  = inner.nota || inner;
      const itens = _extrairItensNota(nota);

      itens.forEach(item => {
        const sku = _extrairSkuItemNF(item);
        if (!sku || costMap[sku]) return; // mantém a mais recente (NFs vêm desc.)

        const qty   = _extrairQtdItemNF(item);
        const valor = _extrairValorUnitarioItemNF(item);
        if (valor <= 0 || qty <= 0) return;

        costMap[sku] = {
          custoBase: Math.round(valor * 10000) / 10000,
          ipiPct:    _extrairIpiPct(item),
          icmsPct:   _extrairIcmsPct(item),
          nfNumero:  nfHdr.numero,
          nfData:    nfHdr.data,
        };
      });
    });
    Utilities.sleep(100);
  }

  // Gravar na aba Cache NF (oculta)
  const agora = new Date().toLocaleString('pt-BR');
  const rows = Object.entries(costMap).map(([sku, d]) => [
    sku, d.custoBase, d.ipiPct, d.icmsPct, d.nfNumero, d.nfData, agora
  ]);

  let ws = ss.getSheetByName(ABA_CACHE_NF);
  if (!ws) {
    ws = ss.insertSheet(ABA_CACHE_NF);
    ws.hideSheet();
  }
  ws.clearContents();
  ws.getRange(1, 1, 1, HEADERS_CACHE_NF.length).setValues([HEADERS_CACHE_NF]);
  if (rows.length) {
    ws.getRange(2, 1, rows.length, HEADERS_CACHE_NF.length).setValues(rows);
  }

  ss.toast(`✅ Cache NF atualizado: ${rows.length} SKUs mapeados.`, 'BouwObra', 6);
  return costMap;
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
      custoBase: parseFloat(row[1]) || 0,
      ipiPct:    parseFloat(row[2]) || 0,
      icmsPct:   parseFloat(row[3]) || 0,
      nfNumero:  String(row[4]),
      nfData:    String(row[5]),
    };
  });
  return map;
}
