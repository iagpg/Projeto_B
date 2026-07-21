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

// Taxa ML default (fallback quando a API de taxas está indisponível)
const ML_TAXA_DEFAULT = 12.0;

// Nomes das abas
const ABA_PRECIFICACAO = 'Precificação';
const ABA_DASHBOARD    = 'Dashboard';
const ABA_CACHE_NF     = 'Cache NF';       // aba oculta

// Cabeçalhos da aba Precificação
const HEADERS_PREC = [
  'ID ML',                         // A  0
  'SKU',                           // B  1
  'Nome',                          // C  2
  'Categoria',                     // D  3
  'Preço Base (R$)',               // E  4  — preço "cheio" do anúncio, sem promoção
  'Preço Praticado (R$)',          // F  5  — preço vigente agora (com promoção, se houver); usado no cálculo
  'Taxa ML (%)',                   // G  6
  'RT (R$)',                       // H  7  — Redução de Tarifa: comissão bancada pela Meli em promoções SMART
  'Frete (R$)',                    // I  8
  'ICMS Venda (R$)',               // J  9
  'PIS Venda (R$)',                // K  10
  'COFINS Venda (R$)',             // L  11
  'Comissão + Frete ML (R$)',      // M  12
  'PIS Crédito s/ Comissão+Frete (R$)',    // N  13 — confirmado com a contadora (12/06/2026)
  'COFINS Crédito s/ Comissão+Frete (R$)', // O  14 — idem
  'Custo NF c/ IPI (R$)',          // P  15
  'ICMS Compra — crédito (R$)',    // Q  16
  'PIS Compra — crédito (R$)',     // R  17
  'COFINS Compra — crédito (R$)',  // S  18
  'Imposto Recuperável (R$)',      // T  19
  'Margem Líquida (R$)',           // U  20
  'Margem Líquida (%)',            // V  21  ← usada para coloração
  'Status Anúncio',                // W  22
  'Última Atualização',            // X  23
];

const MARGEM_COL_IDX = 21; // índice 0-based da coluna Margem %

// Coloração fixa (independente da margem):
//   crédito — valores que beneficiam a margem (créditos fiscais + bônus RT) → verde claro
//   débito  — valores que reduzem a margem (encargos de venda e custo)     → vermelho claro
//   margem  — R$ e % da margem líquida, coloridos pela faixa de desempenho
const CREDITO_COLS = [7, 13, 14, 16, 17, 18, 19]; // RT, PIS/COFINS créd. s/ comissão+frete, ICMS/PIS/COFINS créd. compra, Imposto Recuperável
const DEBITO_COLS  = [8, 9, 10, 11, 12, 15];        // Frete, ICMS/PIS/COFINS venda, Comissão+Frete, Custo NF
const MARGEM_COLS  = [20, MARGEM_COL_IDX];          // Margem Líquida (R$) e (%)

// Status Anúncio (W) — dropdown + cor fixa por valor
const STATUS_COL_IDX = 22;
const STATUS_OPTIONS = ['Ativo', 'Pausado', 'Fechado', 'Migrado', '—'];

// Abas auxiliares
const ABA_ALERTAS = 'Alertas';
const ABA_SIMULACAO_PRECO = 'Simulação Preço'; // aba oculta

// Cabeçalhos da Simulação de Preço — editar a coluna F (Preço Praticado) na
// Precificação grava aqui o preço original (1x) e o preço simulado, pra
// sobreviver a uma re-sincronização completa (que reescreve a aba inteira) e
// permitir reverter pro preço real do ML.
const HEADERS_SIMULACAO_PRECO = [
  'SKU',                 // A 0
  'Preço Original (R$)', // B 1
  'Preço Simulado (R$)', // C 2
  'Ativado em',          // D 3
];

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
