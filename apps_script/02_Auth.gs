// ============================================================
// 02_Auth.gs — Gerenciamento de tokens e helpers HTTP
// ============================================================

function getProps() {
  return PropertiesService.getScriptProperties();
}

// ── Setup inicial (rodar UMA VEZ) ─────────────────────────────────────────────

function inicializarConfiguracoes() {
  // Preencha os valores abaixo e execute esta função UMA VEZ no Apps Script.
  // Após salvar, os tokens ficam no PropertiesService (criptografados pelo Google)
  // e este arquivo pode ficar sem segredos no repositório Git.
  getProps().setProperties({
    // Mercado Livre
    'ML_CLIENT_ID':     '',
    'ML_CLIENT_SECRET': '',
    'ML_USER_ID':       '',
    'ML_ACCESS_TOKEN':  '',
    'ML_REFRESH_TOKEN': '',
    // Tiny ERP
    'TINY_CLIENT_ID':     '',
    'TINY_CLIENT_SECRET': '',
    'TINY_ACCESS_TOKEN':  '',
    'TINY_REFRESH_TOKEN': '',
  });
  SpreadsheetApp.getActiveSpreadsheet().toast('✅ Configurações salvas com sucesso!', 'BouwObra');
}

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
  return JSON.parse(resp.getContentText());
}

// Busca múltiplas NFs em paralelo (fetchAll)
function tinyGetNfsParalelo(nfIds) {
  const p = getProps();
  const token = p.getProperty('TINY_ACCESS_TOKEN');
  const requests = nfIds.map(id => ({
    url: `${TINY_BASE}/notas-fiscais/${id}`,
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true,
  }));
  return UrlFetchApp.fetchAll(requests).map((resp, i) => {
    if (resp.getResponseCode() !== 200) return null;
    try { return JSON.parse(resp.getContentText()); } catch(e) { return null; }
  });
}
