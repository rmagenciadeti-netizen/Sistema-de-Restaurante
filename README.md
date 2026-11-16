# RM Restaurant SaaS

Monólito modular para restaurantes, com Next.js, TypeScript, PostgreSQL/Prisma e Docker. Integrações fiscais, WhatsApp, pagamentos e impressão física requerem provedor, contrato/homologação e configuração próprios; a API não finge envio ou autorização de terceiros.

## Desenvolvimento local

1. Copie `.env.example` para `.env`; configure segredo JWT aleatório com 32+ caracteres e credenciais fortes.
2. Inicie o banco: `docker compose up -d postgres`.
3. Instale pacotes: `npm install`.
4. Gere o cliente e aplique migração: `npm run db:generate && npm run db:migrate`.
5. Crie o Master: `npm run seed:master`.
6. Inicie `npm run dev:api` e `npm run dev` em terminais separados.
7. Testes disponíveis: `npm run test --workspace apps/api`.

## Módulos e endpoints novos

- CRUD parcial/soft delete: atualizações em `/employees/:id`, `/products/:id` e `/units/:id`; registros operacionais usam status, preservando histórico.
- Produção/KDS: `GET /production/kds?sectorId=...`, `PATCH /production/items/:id/status`.
- Estoque e fichas: `GET|POST /inventory/ingredients`, `POST /inventory/ingredients/:id/movements`, `GET /inventory/movements`, `GET|PUT /inventory/recipes/:productId`.
- Caixa/pagamentos: `POST|GET /cash/sessions`, `POST /cash/sessions/:id/close`, `POST|GET /cash/payments`.
- Entrega: `GET|POST /delivery`, `PATCH /delivery/:id/status`.
- WhatsApp: `POST|GET /whatsapp/outbox`. O endpoint apenas enfileira um registro auditável; envio real requer adaptador de provedor oficial e worker configurado.
- Financeiro e relatórios: `GET|POST /financial/entries`, `GET /financial/summary`, `GET /reports/overview?from=ISO&to=ISO`.

Rotas privadas exigem token Bearer. Os escopos tenant/unidade vêm do contexto autenticado. O login tem limitação de tentativas, CORS aceita origens configuradas, o corpo JSON tem limite e erros internos não são expostos ao cliente. Testes ainda são iniciais e devem ser ampliados com testes de integração de isolamento de tenant antes de produção.

## Limitações relevantes

A primeira versão de estoque exige ajustes manuais; consumo automático por ficha técnica ao confirmar pedido, compras, transferências e inventário guiado ainda devem ser desenvolvidos. Caixa e relatórios são gerenciais, não conciliação contábil. Não há integração fiscal, pagamento em cartão/PIX, WhatsApp oficial, impressão de produção ou delivery de terceiros sem adaptadores e homologações reais. Não exponha em produção antes de executar a validação Prisma/TypeScript, migrações, testes de integração e revisão de segurança.
