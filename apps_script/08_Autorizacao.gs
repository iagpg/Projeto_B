// ============================================================
// 08_Autorizacao.gs — Autorização OAuth2 inicial (Tiny e ML)
// ============================================================
//
// Elimina a dependência do projeto Python para obter o PRIMEIRO
// refresh token. O dia a dia (renovar o access token quando expira)
// já é 100% automático via refreshMlToken()/refreshTinyToken() em
// 02_Auth.gs — isso aqui só precisa rodar uma vez, ou de novo se o
// refresh token for revogado (raro).
//
// Uso: menu BouwObra → 🔐 Autorização OAuth → Autorizar ML / Autorizar Tiny.

// ── Helpers PKCE (exigido pelo Mercado Livre) ─────────────────────────────────

function _pkceVerifier() {
  const bytes = [];
  for (let i = 0; i < 64; i++) bytes.push(Math.floor(Math.random() * 256));
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function _pkceChallenge(verifier) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, verifier);
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

// ── Dialog compartilhado ──────────────────────────────────────────────────────
// O usuário abre o link, autoriza no navegador, copia o "code" da URL de
// redirecionamento (a página de destino pode falhar ao carregar — o code
// continua visível na barra de endereço) e cola de volta no dialog.

function _mostrarDialogoAutorizacao(titulo, authUrl, nomeFuncaoServidor) {
  const html = `
    <div style="font-family: Arial, sans-serif; font-size: 13px; padding: 4px;">
      <p><b>1.</b> Clique no link abaixo, faça login e autorize o app:</p>
      <p><a href="${authUrl}" target="_blank">Abrir autorização — ${titulo}</a></p>
      <p><b>2.</b> Depois de autorizar, a página de destino pode falhar ao carregar
         (é esperado). Copie o valor de <code>code=</code> na barra de endereço do
         navegador (tudo entre <code>code=</code> e o próximo <code>&amp;</code>, se houver).</p>
      <p><b>3.</b> Cole o code abaixo e clique em Salvar:</p>
      <input type="text" id="code" style="width: 95%; padding: 4px;">
      <br><br>
      <button onclick="salvar()">Salvar</button>
      <p id="resultado" style="color: #333; font-weight: bold;"></p>
    </div>
    <script>
      function salvar() {
        var code = document.getElementById('code').value.trim();
        document.getElementById('resultado').innerText = 'Trocando code por token...';
        google.script.run
          .withSuccessHandler(function(msg) { document.getElementById('resultado').innerText = msg; })
          .withFailureHandler(function(err) { document.getElementById('resultado').innerText = 'Erro: ' + err.message; })
          .${nomeFuncaoServidor}(code);
      }
    </script>
  `;
  const output = HtmlService.createHtmlOutput(html).setWidth(480).setHeight(340);
  SpreadsheetApp.getUi().showModalDialog(output, titulo);
}

// ── Mercado Livre (PKCE) ──────────────────────────────────────────────────────

function autorizarML() {
  const p = getProps();
  const verifier  = _pkceVerifier();
  const challenge = _pkceChallenge(verifier);
  p.setProperty('ML_PKCE_VERIFIER_TEMP', verifier);

  const authUrl = ML_AUTH_URL + '?' + buildQS({
    response_type:         'code',
    client_id:             p.getProperty('ML_CLIENT_ID'),
    redirect_uri:          ML_REDIRECT_URI,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    scope:                 'read:orders offline_access',
  });

  _mostrarDialogoAutorizacao('Autorização Mercado Livre', authUrl, 'trocarCodeML');
}

function trocarCodeML(code) {
  const p = getProps();
  const verifier = p.getProperty('ML_PKCE_VERIFIER_TEMP');
  if (!verifier) throw new Error('Verifier PKCE não encontrado — rode "Autorizar Mercado Livre" novamente.');

  const resp = UrlFetchApp.fetch(`${ML_BASE}/oauth/token`, {
    method: 'post',
    payload: buildQS({
      grant_type:    'authorization_code',
      client_id:     p.getProperty('ML_CLIENT_ID'),
      client_secret: p.getProperty('ML_CLIENT_SECRET'),
      code:          code,
      redirect_uri:  ML_REDIRECT_URI,
      code_verifier: verifier,
    }),
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
  });
  const d = JSON.parse(resp.getContentText());
  if (!d.access_token) throw new Error('Falha ao obter token ML: ' + JSON.stringify(d));

  p.setProperty('ML_ACCESS_TOKEN', d.access_token);
  if (d.refresh_token) p.setProperty('ML_REFRESH_TOKEN', d.refresh_token);
  p.deleteProperty('ML_PKCE_VERIFIER_TEMP');

  return '✅ Mercado Livre autorizado com sucesso! Tokens salvos.';
}

// ── Tiny ERP ──────────────────────────────────────────────────────────────────

function autorizarTiny() {
  const p = getProps();
  const authUrl = TINY_AUTH_URL + '?' + buildQS({
    client_id:     p.getProperty('TINY_CLIENT_ID'),
    redirect_uri:  TINY_REDIRECT_URI,
    response_type: 'code',
    scope:         'openid offline_access',
  });

  _mostrarDialogoAutorizacao('Autorização Tiny ERP', authUrl, 'trocarCodeTiny');
}

function trocarCodeTiny(code) {
  const p = getProps();
  const resp = UrlFetchApp.fetch(TINY_TOKEN_URL, {
    method: 'post',
    payload: buildQS({
      grant_type:    'authorization_code',
      client_id:     p.getProperty('TINY_CLIENT_ID'),
      client_secret: p.getProperty('TINY_CLIENT_SECRET'),
      code:          code,
      redirect_uri:  TINY_REDIRECT_URI,
    }),
    contentType: 'application/x-www-form-urlencoded',
    muteHttpExceptions: true,
  });
  const d = JSON.parse(resp.getContentText());
  if (!d.access_token) throw new Error('Falha ao obter token Tiny: ' + JSON.stringify(d));

  p.setProperty('TINY_ACCESS_TOKEN', d.access_token);
  if (d.refresh_token) p.setProperty('TINY_REFRESH_TOKEN', d.refresh_token);

  return '✅ Tiny autorizado com sucesso! Tokens salvos.';
}
