# RM Restaurant SaaS

Monólito modular para operação de restaurantes, com Next.js, TypeScript, PostgreSQL/Prisma e Docker. A interface web conecta-se às APIs autenticadas de empresas, unidades, funcionários, produtos, produção e pedidos. Este projeto continua em desenvolvimento; integrações fiscais, WhatsApp, pagamentos, impressão física e conformidade trabalhista dependem de configuração, homologação e testes específicos.

## Executar localmente

1. Copie `.env.example` para `.env`, configure um `JWT_SECRET` aleatório com pelo menos 32 caracteres e altere as credenciais de desenvolvimento.
2. Suba o PostgreSQL: `docker compose up -d postgres`.
3. Instale dependências: `npm install`.
4. Gere o client e aplique o schema: `npm run db:generate && npm run db:migrate`.
5. Crie o usuário Master: `npm run seed:master`.
6. Inicie API e web em terminais separados: `npm run dev:api` e `npm run dev`.

## Interface disponível

- `/login` — login por e-mail/senha.
- `/dashboard` — painel Master ou do restaurante, conforme o papel autenticado.
- `/companies` — listagem, criação de empresa com unidade e administrador inicial, e alteração de status (Master).
- `/units` — listar/criar unidades do tenant.
- `/employees` — listar/cadastrar funcionários.
- `/products` — catálogo e associação ao setor de produção.
- `/orders` — criação de pedido no motor central e atualização inicial de status.

Todas as rotas privadas usam token Bearer. O tenant vem do usuário autenticado. Não envie nem confie em `tenantId` fornecido pelo navegador. Empresa criada pelo Master inicia em período de teste; a política de acesso considera `TRIAL` utilizável. Status de bloqueio/suspensão impede o login.

## Limitações

As telas são uma primeira interface operacional, não um ERP completo. Ainda faltam permissões granulares por ação, edição de todas as entidades no frontend, mesas e comandas com fluxo completo, pagamento/caixa, estoque, adicionais e combos, comissões e taxa de serviço, KDS com transições por item, impressão local, fiscal, integrações externas, testes automatizados, RLS e documentação OpenAPI. Não publicar como sistema de produção antes de implementar e validar essas proteções e processos.
