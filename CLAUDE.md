# Regra Matriz do Projeto

> **Todo o projeto deve seguir rigorosamente as instruções definidas em `instruções.txt`.**
> Este arquivo é a regra matriz. Qualquer decisão arquitetural, implementação ou integração deve estar alinhada com ela.

---

## Resumo dos Princípios Fundamentais

### AI-First Integration Platform
A IA nunca conhece detalhes de APIs, autenticação, OAuth, paginação, rate limits ou formatos de resposta. Toda complexidade é encapsulada na arquitetura. A IA apenas executa **Tools** padronizadas (ex: `buscar_produto()`, `consultar_estoque()`, `emitir_nf()`).

### Arquitetura Modular
```
connectors/
    tiny/
    mercadolivre/
    shopee/
    amazon/
    google-ads/
    meta-ads/
    ...
```
Cada connector é independente. Adicionar um novo nunca altera os existentes.

### Independência via Interfaces
Services dependem de interfaces, nunca de implementações concretas:
- `IProductConnector`
- `IOrderConnector`
- `IInventoryConnector`
- `IInvoiceConnector`
- `ICustomerConnector`

### Contrato Estável das Tools
Tools são a API pública para agentes de IA e devem permanecer estáveis. Trocar um connector não altera nenhuma Tool.

### Princípios de Design
Modularidade · Escalabilidade · Extensibilidade · Baixo acoplamento · Alta coesão · Reutilização · Interfaces bem definidas · Inversão de dependência · Forte tipagem · Padronização de respostas · DDD · Tool-Oriented Architecture · AI-First Design

---

## Integrações Previstas

| Categoria | Sistemas |
|---|---|
| Marketplaces | Mercado Livre, Amazon, Shopee, Magalu |
| ERP | Tiny |
| E-commerce | Nuvemshop |
| Marketing | Google Ads, Meta Ads, TikTok Ads |
| BI | Power BI, Looker Studio |
| Logística | Melhor Envio, Frenet, Intelipost |
| Financeiro | Mercado Pago, PagBank |
| Comunicação | WhatsApp Business, Gmail, Slack |

---

*Fonte: `instruções.txt` — leia o arquivo completo para detalhes e exemplos.*
