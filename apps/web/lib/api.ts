# RM Restaurant SaaS

Monólito modular para operação de restaurantes, com Next.js, TypeScript, PostgreSQL/Prisma e Docker. Este repositório está em desenvolvimento: integrações fiscais, WhatsApp, pagamentos, impressão local e conformidade trabalhista exigem configuração, homologação e testes próprios; não são simuladas como integrações reais.

## Executar localmente

1. Copie `.env.example` para `.env`, configure um `JWT_SECRET` aleatório com pelo menos 32 caracteres e altere as credenciais de desenvolvimento.
2. Suba o PostgreSQL: `docker compose up -d postgres`.
3. Instale dependências: `npm install`.
4. Gere o client e aplique o schema: `npm run db:generate && npm run db:migrate`.
5. Crie o usuário Master com as variáveis de ambiente configuradas: `npm run seed:master`.
6. Inicie API e web em terminais separados: `npm run dev:api` e `npm run dev`.

## Login inicial

A interface web agora contém fluxo básico de login:
- `/login` para autenticação
- `/dashboard` para painel autenticado
- `/` para landing page do SaaS

Credenciais padrão esperadas no seed master:
- e-mail: `admin@example.com`
- senha: valor configurado em `MASTER_ADMIN_PASSWORD` do `.env`

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

As operações autenticadas exigem `Authorization: Bearer <token>`. O tenant é obtido do próprio usuário autenticado, nunca de um `tenantId` arbitrário enviado pelo cliente.
