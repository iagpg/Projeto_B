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

// Retorna lista de {id, numero, data} das NFs de entrada
function _listarNfIds(mesesAtras) {
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setMonth(inicio.getMonth() - mesesAtras);
  const fmtDate = d => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };

  const nfHeaders = [];
  let offset = 0;
  while (true) {
    const data = tinyGet('/notas', {
      tipo:        'E',
      dataInicial: fmtDate(inicio),
      dataFinal:   fmtDate(hoje),
      limit:       100,
      offset:      offset,
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
    const total = parseInt(pag.total || 0, 10);
    offset += 100;
    if (offset >= total || itens.length < 100) break;
    Utilities.sleep(150);
  }
  return nfHeaders;
}

// ── Build do Cache de Custos ───────────────────────────────────────────────────

// Busca NF detalhes + impostos por item em lotes e grava na aba "Cache NF"
function atualizarCacheNF() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Buscando notas fiscais de entrada...', 'BouwObra', -1);

  const nfHeaders = _listarNfIds(12);
  ss.toast(`${nfHeaders.length} NFs encontradas. Buscando itens...`, 'BouwObra', -1);

  // Fase 1: buscar detalhes das NFs para extrair lista de itens
  const pendingItems = []; // {nfId, nfNumero, nfData, idItem, sku, qty, unit, descricao}
  const BATCH = 30;

  for (let i = 0; i < nfHeaders.length; i += BATCH) {
    const lote = nfHeaders.slice(i, i + BATCH);
    const respostas = tinyGetNfsParalelo(lote.map(n => n.id));

    respostas.forEach((resp, j) => {
      if (!resp) return;
      const nfHdr = lote[j];
      const inner = resp.data || resp;
      const nota  = inner.nota || inner;
      const itens = nota.itens || nota.items || nota.produtos || [];

      itens.forEach(item => {
        const sku = String(item.codigo || '').trim();
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
    Utilities.sleep(100);
  }

  ss.toast(`${pendingItems.length} itens. Buscando impostos...`, 'BouwObra', -1);

  // Fase 2: buscar impostos por item (GET /notas/{nfId}/itens/{idItem}) em lotes
  const costMap = {}; // sku → custo com valores absolutos
  const _impVal = obj => (obj && typeof obj === 'object') ? (parseFloat(obj.valorImposto || obj.valor || 0) || 0) : 0;
  const _rnd4   = v => Math.round(v * 10000) / 10000;
  const validPairs = pendingItems.filter(it => it.idItem > 0);

  for (let i = 0; i < validPairs.length; i += BATCH) {
    const lote = validPairs.slice(i, i + BATCH);
    const respostas = tinyGetItensParalelo(lote.map(it => ({ nfId: it.nfId, idItem: it.idItem })));

    respostas.forEach((resp, j) => {
      const it = lote[j];
      if (costMap[it.sku]) return; // mantém NF mais recente
      const taxes = resp || {};
      costMap[it.sku] = {
        custoBase:     _rnd4(it.unit),
        ipiValor:      _rnd4(_impVal(taxes.ipi)    / it.qty),
        icmsCredito:   _rnd4(_impVal(taxes.icms)   / it.qty),
        pisCredito:    _rnd4(_impVal(taxes.pis)     / it.qty),
        cofinsCredito: _rnd4(_impVal(taxes.cofins)  / it.qty),
        nfNumero:      it.nfNumero,
        nfData:        it.nfData,
        descricao:     it.descricao,
      };
    });
    Utilities.sleep(100);
  }

  // Itens sem idItem: registra custo base sem impostos detalhados
  pendingItems.filter(it => it.idItem === 0).forEach(it => {
    if (costMap[it.sku]) return;
    costMap[it.sku] = {
      custoBase: _rnd4(it.unit), ipiValor: 0, icmsCredito: 0,
      pisCredito: 0, cofinsCredito: 0,
      nfNumero: it.nfNumero, nfData: it.nfData, descricao: it.descricao,
    };
  });

  // Gravar na aba Cache NF (oculta)
  const agora = new Date().toLocaleString('pt-BR');
  const rows = Object.entries(costMap).map(([sku, d]) => [
    sku, d.custoBase, d.ipiValor, d.icmsCredito, d.pisCredito, d.cofinsCredito,
    d.nfNumero, d.nfData, agora,
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
      custoBase:     parseFloat(row[1]) || 0,
      ipiValor:      parseFloat(row[2]) || 0,
      icmsCredito:   parseFloat(row[3]) || 0,
      pisCredito:    parseFloat(row[4]) || 0,
      cofinsCredito: parseFloat(row[5]) || 0,
      nfNumero:      String(row[6]),
      nfData:        String(row[7]),
    };
  });
  return map;
}
