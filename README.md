# RM Restaurant SaaS

Monólito modular para operação de restaurantes, com Next.js, TypeScript, PostgreSQL/Prisma e Docker. Este repositório está em desenvolvimento: integrações fiscais, WhatsApp, pagamentos, impressão física e conformidade trabalhista exigem configuração, homologação e testes próprios; não são simuladas como integrações reais.

## Executar localmente

1. Copie `.env.example` para `.env`, configure um `JWT_SECRET` aleatório com pelo menos 32 caracteres e altere as credenciais de desenvolvimento.
2. Suba o PostgreSQL: `docker compose up -d postgres`.
3. Instale dependências: `npm install`.
4. Gere o client e aplique o schema: `npm run db:generate && npm run db:migrate`.
5. Crie o usuário Master com as variáveis de ambiente configuradas: `npm run seed:master`.
6. Inicie API e web em terminais separados: `npm run dev:api` e `npm run dev`.

## API inicial

- `GET /api/v1/health` — health check público.
- `POST /api/v1/auth/login` — login por email/senha; retorna token Bearer.
- `GET /api/v1/tenants` e `/stats/summary` — Master Admin.
- `GET|POST /api/v1/units` — contexto autenticado do tenant.
- `GET /api/v1/dashboard/master` — métricas agregadas reais disponíveis no banco.
- `GET /api/v1/dashboard/restaurant` — indicadores do tenant.
- `GET|POST /api/v1/employees`, `/products`, `/production/sectors` e `/orders` — operações com escopo de tenant no backend.
- `GET /api/v1/production/kds` — itens ativos encaminhados ao setor de produção.
- `PATCH /api/v1/orders/:id/status` — transição inicial de status do pedido.

Operações protegidas exigem `Authorization: Bearer <token>`. O tenant é obtido do usuário autenticado, nunca de um `tenantId` arbitrário enviado pelo cliente. Para produção, configure TLS, segredos fortes, rate limiting, backups testados e políticas de autorização por função/unidade antes de expor a API.

## Escopo implementado e limitações

A fundação inclui autenticação por token, escopo de tenant/unidade, migração inicial por Prisma, auditoria básica, cadastro inicial de funcionários/produtos/setores, pedidos com preços recalculados a partir do catálogo e agregações reais para os dashboards. Ainda não é um ERP completo: planos/assinaturas e cobrança, permissões granulares, mesas e comandas, estoque/fichas técnicas, adicionais/combos, caixa/pagamentos, comissão e gorjetas, impressora/agente/KDS com transições, fiscal, delivery, CRM, WhatsApp, suporte SaaS, LGPD operacional e relatórios avançados precisam ser implementados e validados em etapas. PostgreSQL RLS, testes automatizados, documentação OpenAPI e hardening operacional também são pendências explícitas; não declare o produto pronto para produção sem elas.
