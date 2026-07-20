// ============================================================
// 01_Config.gs — Constantes globais
// ============================================================

const ML_BASE    = 'https://api.mercadolibre.com';
const TINY_BASE  = 'https://erp.tiny.com.br/public-api/v3';
const TINY_TOKEN_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';

// OAuth2 — autorização inicial (roda direto no Apps Script, sem depender do Python).
// Mesmos redirect_uri já cadastrados nos apps ML/Tiny (usados pelo fluxo Python
// historicamente) — nenhuma configuração externa adicional é necessária.
const ML_AUTH_URL       = 'https://auth.mercadolivre.com.br/authorization';
const ML_REDIRECT_URI   = 'https://bouwobraequipamentos.com.br/';
const TINY_AUTH_URL     = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
const TINY_REDIRECT_URI = 'http://localhost:8080/callback';

// Regime Lucro Real
const ICMS_VENDA   = 0.18;
const PIS_VENDA    = 0.0165;
const COFINS_VENDA = 0.076;
const PIS_COMPRA   = 0.0165;
const COFINS_COMPRA = 0.076;

// Nomes das abas
const ABA_PRECIFICACAO = 'Precificação';
const ABA_DASHBOARD    = 'Dashboard';
const ABA_CACHE_NF     = 'Cache NF';       // aba oculta

// Cabeçalhos da aba Precificação
const HEADERS_PREC = [
  'ID ML',                     // A  0
  'SKU',                       // B  1
  'Nome',                      // C  2
  'Categoria',                 // D  3
  'Preço de Venda (R$)',       // E  4
  'Taxa ML (%)',               // F  5
  'RT (%)',                    // G  6
  'Frete (R$)',                // H  7
  'ICMS Venda (R$)',           // I  8
  'PIS Venda (R$)',            // J  9
  'COFINS Venda (R$)',         // K  10
  'Comissão + Frete ML (R$)', // L  11
  'Custo NF c/ IPI (R$)',     // M  12
  'ICMS Compra — crédito (R$)',   // N  13
  'PIS Compra — crédito (R$)',    // O  14
  'COFINS Compra — crédito (R$)', // P  15
  'Imposto Recuperável (R$)', // Q  16
  'Margem Líquida (R$)',      // R  17
  'Margem Líquida (%)',       // S  18  ← usada para coloração
  'Status Anúncio',           // T  19
  'Última Atualização',       // U  20
];

const MARGEM_COL_IDX = 18; // índice 0-based da coluna Margem %

// Abas auxiliares
const ABA_ALERTAS = 'Alertas';

// Cabeçalhos do Cache NF — 9 colunas com valores absolutos (R$)
const HEADERS_CACHE_NF = [
  'SKU',               // A 0
  'Custo Base (R$)',   // B 1
  'IPI (R$)',          // C 2
  'ICMS Crédito (R$)', // D 3
  'PIS Crédito (R$)',  // E 4
  'COFINS Crédito (R$)', // F 5
  'NF Número',         // G 6
  'NF Data',           // H 7
  'Atualizado em',     // I 8
];
