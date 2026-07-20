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

// Pagina TODOS os anúncios do vendedor e retorna dict SKU → {mlbId, price, status, categoryId, listingTypeId, title}
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
    const items = mlGetBatch(chunk, 'id,title,price,status,category_id,seller_sku,attributes,listing_type_id');
    items.forEach(item => {
      const sku = extrairSellerSku(item);
      if (sku) {
        skuMap[sku] = {
          mlbId:         item.id,
          price:         parseFloat(item.price) || 0,
          status:        item.status || '',
          categoryId:    item.category_id || '',
          listingTypeId: item.listing_type_id || '',
          title:         item.title || '',
        };
      }
    });
    Utilities.sleep(100);
  }
  return skuMap;
}

// ── Taxas ML ──────────────────────────────────────────────────────────────────
//
// GET /users/{id}/items/{id}/fees está quebrado (retorna {}) — a taxa real vem
// de GET /sites/MLB/listing_prices?price=...&category_id=..., filtrando pelo
// listing_type_id do próprio anúncio (Clássico=12%, Premium=17% etc.).
//
// categoryId/listingTypeId já vêm de buildSkuMlbMap() (mesmo lote de busca dos
// anúncios) — não é preciso buscar o item de novo aqui. Cache por categoria+tipo
// (a % de comissão é estável nesse par, não muda por SKU), o que reduz bastante
// as chamadas repetidas quando muitos produtos compartilham categoria.
const _feesCache_ = {};

function getMlItemFees(price, categoryId, listingTypeId) {
  const cacheKey = categoryId + '|' + listingTypeId;
  if (_feesCache_[cacheKey]) {
    const cached = _feesCache_[cacheKey];
    return {
      taxaRs: Math.round(price * cached.taxaPct / 100 * 100) / 100,
      taxaPct: cached.taxaPct,
      incerto: cached.incerto,
    };
  }

  try {
    if (!categoryId || !listingTypeId) throw new Error('category_id/listing_type_id ausente');

    const options = mlGet('/sites/MLB/listing_prices', { price, category_id: categoryId });
    if (!Array.isArray(options)) throw new Error('resposta inválida de listing_prices');

    const match = options.find(o => o.listing_type_id === listingTypeId);
    if (!match) throw new Error(`listing_type_id '${listingTypeId}' não encontrado`);

    const saleRs = parseFloat(match.sale_fee_amount) || 0;
    const pct = match.percentage_fee !== undefined
      ? parseFloat(match.percentage_fee)
      : (price > 0 ? Math.round(saleRs / price * 10000) / 100 : ML_TAXA_DEFAULT);

    _feesCache_[cacheKey] = { taxaPct: pct, incerto: false };
    return { taxaRs: Math.round(saleRs * 100) / 100, taxaPct: pct, incerto: false };
  } catch (e) {
    // Fallback: taxa default — valor NÃO confirmado pela API
    _feesCache_[cacheKey] = { taxaPct: ML_TAXA_DEFAULT, incerto: true };
    return {
      taxaRs: Math.round(price * ML_TAXA_DEFAULT / 100 * 100) / 100,
      taxaPct: ML_TAXA_DEFAULT,
      incerto: true,
    };
  }
}

// ── Preço praticado (promoções) ───────────────────────────────────────────────
//
// Um anúncio pode ter várias promoções cadastradas (campanhas, SMART, DEAL,
// cupons) simultaneamente, mas só uma vale de fato no momento — a Meli aplica
// ao comprador a MENOR entre as "type": "promotion" cuja janela start_time/
// end_time (canal channel_marketplace) contém o instante atual.

function getPrecoPraticado(mlbId, precoBase) {
  try {
    const data   = mlGet(`/items/${mlbId}/prices`);
    const prices = (data && data.prices) || [];
    const agora  = new Date();

    const validas = prices
      .filter(p => p.type === 'promotion')
      .filter(p => {
        const cond = p.conditions || {};
        if (!(cond.context_restrictions || []).includes('channel_marketplace')) return false;
        if (cond.start_time && agora < new Date(cond.start_time)) return false;
        if (cond.end_time && agora > new Date(cond.end_time)) return false;
        return p.amount !== undefined && p.amount !== null;
      })
      .map(p => parseFloat(p.amount));

    if (validas.length) {
      return { precoPraticado: Math.min(...validas), promoAtiva: true, incerto: false };
    }
    return { precoPraticado: precoBase, promoAtiva: false, incerto: false };
  } catch (e) {
    return { precoPraticado: precoBase, promoAtiva: false, incerto: true };
  }
}

// ── RT (Redução de Tarifa) ────────────────────────────────────────────────────
//
// Parte do desconto de uma promoção SMART que a própria Meli banca reduzindo
// a comissão de venda, em vez do vendedor. Fonte: campo "meli_percentage" da
// promoção ativa (mesma cujo "price" bate com o preço praticado), em
// GET /seller-promotions/items/{id}. A API só expõe esse percentual arredondado
// a 1 casa decimal, então o valor calculado pode diferir alguns centavos do
// exibido no painel do ML (por isso "incerto": true sempre que há bônus).

function getItemPromotions(mlbId) {
  try {
    const data = mlGet(`/seller-promotions/items/${mlbId}`, { app_version: 'v2' });
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function getTaxaBonus(mlbId, precoBase, precoPraticado) {
  try {
    const promos = getItemPromotions(mlbId);
    for (const promo of promos) {
      if (promo.status !== 'started') continue;
      const precoPromo = promo.price;
      if (precoPromo === undefined || precoPromo === null) continue;
      if (Math.round(precoPromo * 100) !== Math.round(precoPraticado * 100)) continue;

      if (promo.meli_percentage) {
        const rtValor = Math.round(precoBase * promo.meli_percentage / 100 * 100) / 100;
        return { rtValor, incerto: true };
      }
      return { rtValor: 0, incerto: false };
    }
    return { rtValor: 0, incerto: false };
  } catch (e) {
    return { rtValor: 0, incerto: true };
  }
}

// ── Frete (Mercado Envios / Full) ─────────────────────────────────────────────
//
// Custo de frete que o vendedor paga por essa venda — em anúncios Full/
// Fulfillment, esse custo é cobrado do vendedor mesmo com frete "grátis" para
// o comprador, reduzindo a margem real.
// Fonte: GET /users/{seller}/shipping_options/free?item_id={id}
//        → coverage.all_country.list_cost

function getFreteEnvio(mlbId) {
  try {
    const data = mlGet(`/users/${ML_USER_ID_PROP()}/shipping_options/free`, { item_id: mlbId });
    const cost = data && data.coverage && data.coverage.all_country && data.coverage.all_country.list_cost;
    if (cost === undefined || cost === null) throw new Error('list_cost ausente');
    return { freteRs: Math.round(parseFloat(cost) * 100) / 100, incerto: false };
  } catch (e) {
    return { freteRs: 0, incerto: true };
  }
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
