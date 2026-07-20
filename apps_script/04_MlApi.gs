// ============================================================
// 04_MlApi.gs — Mercado Livre: listings, pedidos e taxas
// ============================================================

const ML_USER_ID_PROP = () => getProps().getProperty('ML_USER_ID') || '1180812007';

// O ML guarda o SKU em dois lugares: campo direto 'seller_sku' (legado, nem
// sempre preenchido) ou dentro de attributes[] com id 'SELLER_SKU' (ficha
// técnica do anúncio). Verifica os dois.
function extrairSellerSku(item) {
  const direto = String(item.seller_sku || '').trim();
  if (direto) return direto;
  const attrs = item.attributes || [];
  for (const attr of attrs) {
    if (attr.id === 'SELLER_SKU') {
      let val = attr.value_name || '';
      if (!val && attr.values && attr.values.length) val = attr.values[0].name || '';
      return String(val).trim();
    }
  }
  return '';
}

// ── Mapa SKU → dados do anúncio ───────────────────────────────────────────────

// Pagina TODOS os anúncios do vendedor e retorna dict SKU → {mlbId, price, status, categoryId, title}
function buildSkuMlbMap() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('Mapeando anúncios ML por SKU...', 'BouwObra', -1);

  const allIds = [];
  let offset = 0;
  const limit = 50;
  while (true) {
    const data = mlGet(`/users/${ML_USER_ID_PROP()}/items/search`, { limit, offset });
    if (!data || !data.results) break;
    allIds.push(...data.results);
    const total = (data.paging || {}).total || 0;
    offset += limit;
    if (offset >= total || !data.results.length) break;
    Utilities.sleep(100);
  }

  const skuMap = {};
  for (let i = 0; i < allIds.length; i += 20) {
    const chunk = allIds.slice(i, i + 20);
    const items = mlGetBatch(chunk, 'id,title,price,status,category_id,seller_sku,attributes');
    items.forEach(item => {
      const sku = extrairSellerSku(item);
      if (sku) {
        skuMap[sku] = {
          mlbId:      item.id,
          price:      parseFloat(item.price) || 0,
          status:     item.status || '',
          categoryId: item.category_id || '',
          title:      item.title || '',
        };
      }
    });
    Utilities.sleep(100);
  }
  return skuMap;
}

// ── Taxas ML ──────────────────────────────────────────────────────────────────

// Cache de taxas em memória (por execução)
const _feesCache_ = {};

function getMlItemFees(mlbId, price) {
  if (_feesCache_[mlbId]) return _feesCache_[mlbId];
  try {
    const data = mlGet(`/users/${ML_USER_ID_PROP()}/items/${mlbId}/fees`, { price });
    if (data && (data.sale_fee_amount !== undefined)) {
      const saleRs = parseFloat(data.sale_fee_amount) || 0;
      const freteRs = parseFloat(data.shipping_fee_amount || data.shipping_fee || 0);
      const pct = price > 0 ? Math.round(saleRs / price * 10000) / 100 : 12;
      const result = { taxaRs: Math.round(saleRs * 100) / 100, taxaPct: pct, freteRs: Math.round(freteRs * 100) / 100 };
      _feesCache_[mlbId] = result;
      return result;
    }
  } catch (e) { /* fallback */ }
  // Fallback: 12% (taxa padrão gold_special)
  const fallback = { taxaRs: Math.round(price * 0.12 * 100) / 100, taxaPct: 12, freteRs: 0 };
  _feesCache_[mlbId] = fallback;
  return fallback;
}

// ── Pedidos ───────────────────────────────────────────────────────────────────

function _isoDate(d) {
  // Formata Date → "2026-07-01T00:00:00.000-03:00"
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T00:00:00.000-03:00`;
}

function _isoDateFim(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T23:59:59.000-03:00`;
}

function getMlPedidos(dataInicio, dataFim) {
  const todos = [];
  const userId = ML_USER_ID_PROP();
  let offset = 0;
  while (true) {
    const data = mlGet('/orders/search', {
      seller:                    userId,
      'order.status':            'paid',
      'order.date_created.from': _isoDate(dataInicio),
      'order.date_created.to':   _isoDateFim(dataFim),
      sort:                      'date_desc',
      limit:                     50,
      offset,
    });
    if (!data || !data.results) break;
    todos.push(...data.results);
    const total = (data.paging || {}).total || 0;
    offset += 50;
    if (offset >= total || !data.results.length) break;
    Utilities.sleep(150);
  }
  return todos;
}

function getKpisPedidos() {
  const hoje = new Date();
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  const pedidosMes  = getMlPedidos(inicioMes, hoje);
  const pedidosHoje = getMlPedidos(hoje, hoje);

  const vendasBrutas = pedidosMes.reduce((s, o) => s + (parseFloat(o.total_amount) || 0), 0);
  const qtdMes       = pedidosMes.length;
  const ticketMedio  = qtdMes > 0 ? vendasBrutas / qtdMes : 0;

  return {
    vendasBrutas:  Math.round(vendasBrutas * 100) / 100,
    pedidosMes:    qtdMes,
    pedidosHoje:   pedidosHoje.length,
    ticketMedio:   Math.round(ticketMedio * 100) / 100,
  };
}

function getStatusAnuncios() {
  let active = 0, paused = 0, offset = 0;
  while (true) {
    const data = mlGet(`/users/${ML_USER_ID_PROP()}/items/search`, { limit: 50, offset });
    if (!data || !data.results || !data.results.length) break;
    const items = mlGetBatch(data.results, 'id,status');
    items.forEach(it => {
      if (it.status === 'active') active++;
      else if (it.status === 'paused') paused++;
    });
    const total = (data.paging || {}).total || 0;
    offset += 50;
    if (offset >= total) break;
    Utilities.sleep(100);
  }
  return { active, paused };
}

function statusMl(s) {
  return { active: 'Ativo', paused: 'Pausado', closed: 'Fechado', migrated: 'Migrado' }[s] || (s || '—');
}
