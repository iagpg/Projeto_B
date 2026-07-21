// ============================================================
// 02_Auth.gs — Gerenciamento de tokens e helpers HTTP
// ============================================================

function getProps() {
  return PropertiesService.getScriptProperties();
}

// ── Setup inicial (rodar UMA VEZ) ─────────────────────────────────────────────

// inicializarConfiguracoes está em credentials_local.gs (gitignored).
// Copie o template abaixo, salve como credentials_local.gs e preencha os valores.
/*
function inicializarConfiguracoes() {
  getProps().setProperties({
    'ML_CLIENT_ID':       'SEU_ML_CLIENT_ID',
    'ML_CLIENT_SECRET':   'SEU_ML_CLIENT_SECRET',
    'ML_USER_ID':         'SEU_ML_USER_ID',
    'ML_ACCESS_TOKEN':    'SEU_ML_ACCESS_TOKEN',
    'ML_REFRESH_TOKEN':   'SEU_ML_REFRESH_TOKEN',
    'TINY_CLIENT_ID':     'SEU_TINY_CLIENT_ID',
    'TINY_CLIENT_SECRET': 'SEU_TINY_CLIENT_SECRET',
    'TINY_ACCESS_TOKEN':  'SEU_TINY_ACCESS_TOKEN',
    'TINY_REFRESH_TOKEN': 'SEU_TINY_REFRESH_TOKEN',
  });
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ Configurações salvas!', 'BouwObra');
}
*/

// ── URL builder ───────────────────────────────────────────────────────────────

function buildQS(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ── Mercado Livre ─────────────────────────────────────────────────────────────

function refreshMlToken() {
  const p = getProps();
  const resp = UrlFetchApp.fetch(`${ML_BASE}/oauth/token`, {
    method: 'post',
    payload: buildQS({
      grant_type:    'refresh_token',
      client_id:     p.getProperty('ML_CLIENT_ID'),
      client_secret: p.getProperty('ML_CLIENT_SECRET'),
      refresh_token: p.getProperty('ML_REFRESH_TOKEN'),
    }),
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
  });
  const d = JSON.parse(resp.getContentText());
  if (!d.access_token) throw new Error('Falha ao renovar token ML: ' + JSON.stringify(d));
  p.setProperty('ML_ACCESS_TOKEN', d.access_token);
  if (d.refresh_token) p.setProperty('ML_REFRESH_TOKEN', d.refresh_token);
  return d.access_token;
}

function mlGet(path, params, retry) {
  if (retry === undefined) retry = true;
  const p = getProps();
  const token = p.getProperty('ML_ACCESS_TOKEN');
  const url = ML_BASE + path + '?' + buildQS(Object.assign({ access_token: token }, params || {}));
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = resp.getResponseCode();
  if (code === 401 && retry) {
    refreshMlToken();
    return mlGet(path, params, false);
  }
  if (code === 429) {
    Utilities.sleep(3000);
    return mlGet(path, params, retry);
  }
  return JSON.parse(resp.getContentText());
}

function mlGetBatch(mlbIds, attributes) {
  if (!mlbIds || !mlbIds.length) return [];
  const p = getProps();
  const token = p.getProperty('ML_ACCESS_TOKEN');
  const url = `${ML_BASE}/items?ids=${mlbIds.join(',')}&attributes=${attributes}&access_token=${encodeURIComponent(token)}`;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() === 401) {
    refreshMlToken();
    return mlGetBatch(mlbIds, attributes);
  }
  const data = JSON.parse(resp.getContentText());
  if (!Array.isArray(data)) return [];
  return data.filter(e => e.code === 200 && e.body && e.body.id).map(e => e.body);
}

// ── Tiny ERP ──────────────────────────────────────────────────────────────────

function refreshTinyToken() {
  const p = getProps();
  const resp = UrlFetchApp.fetch(TINY_TOKEN_URL, {
    method: 'post',
    payload: buildQS({
      grant_type:    'refresh_token',
      client_id:     p.getProperty('TINY_CLIENT_ID'),
      client_secret: p.getProperty('TINY_CLIENT_SECRET'),
      refresh_token: p.getProperty('TINY_REFRESH_TOKEN'),
    }),
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
  });
  const d = JSON.parse(resp.getContentText());
  if (!d.access_token) throw new Error('Falha ao renovar token Tiny: ' + JSON.stringify(d));
  p.setProperty('TINY_ACCESS_TOKEN', d.access_token);
  if (d.refresh_token) p.setProperty('TINY_REFRESH_TOKEN', d.refresh_token);
  return d.access_token;
}

function tinyGet(path, params, retry) {
  if (retry === undefined) retry = true;
  const p = getProps();
  const token = p.getProperty('TINY_ACCESS_TOKEN');
  const qs = params ? '?' + buildQS(params) : '';
  const resp = UrlFetchApp.fetch(TINY_BASE + path + qs, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  });
  const code = resp.getResponseCode();
  if (code === 401 && retry) {
    refreshTinyToken();
    return tinyGet(path, params, false);
  }
  if (code === 429) {
    Utilities.sleep(3000);
    return tinyGet(path, params, retry);
  }

  const texto = resp.getContentText();
  try {
    return JSON.parse(texto);
  } catch (e) {
    // Corpo vazio/inválido (erro do Tiny, timeout, etc.) — erro claro em vez de
    // "Unexpected end of JSON input"
    throw new Error(`Tiny respondeu HTTP ${code} com corpo inválido: ${texto.substring(0, 200) || '(vazio)'}`);
  }
}

// Busca múltiplas NFs em paralelo (fetchAll) — endpoint correto: /notas/{id}
function tinyGetNfsParalelo(nfIds) {
  const p = getProps();
  const token = p.getProperty('TINY_ACCESS_TOKEN');
  const requests = nfIds.map(id => ({
    url: `${TINY_BASE}/notas/${id}`,
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  }));
  return UrlFetchApp.fetchAll(requests).map(resp => {
    if (resp.getResponseCode() !== 200) return null;
    try { return JSON.parse(resp.getContentText()); } catch(e) { return null; }
  });
}

// Busca detalhes de itens individuais em paralelo — GET /notas/{nfId}/itens/{idItem}
// pairs: [{nfId, idItem}]
function tinyGetItensParalelo(pairs) {
  const p = getProps();
  const token = p.getProperty('TINY_ACCESS_TOKEN');
  const requests = pairs.map(({ nfId, idItem }) => ({
    url: `${TINY_BASE}/notas/${nfId}/itens/${idItem}`,
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  }));
  return UrlFetchApp.fetchAll(requests).map(resp => {
    if (resp.getResponseCode() !== 200) return null;
    try { return JSON.parse(resp.getContentText()); } catch(e) { return null; }
  });
}
