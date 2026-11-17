# RM Restaurant SaaS

Monólito modular para restaurantes, com Next.js, TypeScript, PostgreSQL/Prisma e Docker. Integrações fiscais, WhatsApp, pagamentos e impressão física requerem provedor, contrato/homologação e configuração próprios; a API não finge envio ou autorização de terceiros.

## Desenvolvimento local

1. Copie `.env.example` para `.env`; configure segredo JWT aleatório com 32+ caracteres, origens CORS exatas e credenciais fortes. Em cada terminal, exporte as variáveis para os comandos dos workspaces: `set -a; . ./.env; set +a` (use apenas um `.env` confiável).
2. Inicie o banco: `docker compose up -d postgres`.
3. Instale pacotes: `npm ci`.
4. Gere e revise a migração inicial em um banco de desenvolvimento vazio, conforme a seção de migrações abaixo.
5. Crie o Master: `npm run seed:master`. O seed recusa qualquer conta existente com o mesmo e-mail; não altera nem promove contas.
6. Inicie `npm run dev:api` e `npm run dev` em terminais separados.

## Verificação da API

Na raiz do repositório, com Node.js 20:

```sh
npm ci
DATABASE_URL=postgresql://localhost:5432/validation npm run db:validate
DATABASE_URL=postgresql://localhost:5432/validation npm run db:generate
npm run build --workspace apps/api
npm run test --workspace apps/api
```

Validação e geração do cliente não conectam ao banco; a URL acima é apenas um exemplo para esses comandos. A CI executa esta mesma sequência, sem testar migrações ou integração com PostgreSQL.

## Migrações e dados existentes

Ainda não há uma migração Prisma inicial versionada. Não use `db:deploy` como se criasse o schema antes de gerar e revisar essa migração. Em um banco de desenvolvimento **vazio e descartável**, configure `DATABASE_URL` em `.env`, exporte as variáveis como acima e execute:

```sh
npm run db:migrate --workspace packages/db -- --name init --create-only
```

Revise o SQL gerado e seus efeitos, aplique-o ao banco de desenvolvimento com `npm run db:migrate`, valide o resultado e versione a pasta de migração. Em implantação, faça backup, revise o histórico de migrações e só então execute `npm run db:deploy` contra o banco correto. Não execute `migrate dev` em produção.

Para um banco que já contém dados ou tabelas, não aplique cegamente uma migração inicial de banco vazio nem use comandos de reset: compare o schema real, preserve backups e siga o procedimento oficial de [baseline de banco existente](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining) com revisão operacional antes de marcar qualquer migração como aplicada.

## Módulos e endpoints novos

- CRUD parcial/soft delete: atualizações em `/employees/:id`, `/products/:id` e `/units/:id`; registros operacionais usam status, preservando histórico.
- Produção/KDS: `GET /production/kds?sectorId=...`, `PATCH /production/items/:id/status`.
- Estoque e fichas: `GET|POST /inventory/ingredients`, `POST /inventory/ingredients/:id/movements`, `GET /inventory/movements`, `GET|PUT /inventory/recipes/:productId`.
- Caixa/pagamentos: `POST|GET /cash/sessions`, `POST /cash/sessions/:id/close`, `POST|GET /cash/payments`.
- Entrega: `GET|POST /delivery`, `PATCH /delivery/:id/status`.
- WhatsApp: `POST|GET /whatsapp/outbox`. O endpoint apenas enfileira um registro auditável; envio real requer adaptador de provedor oficial e worker configurado.
- Financeiro e relatórios: `GET|POST /financial/entries`, `GET /financial/summary`, `GET /reports/overview?from=ISO&to=ISO`.

Rotas privadas exigem token Bearer. Os escopos tenant/unidade vêm do usuário autenticado no banco. O login tem limitação de tentativas em memória por processo, CORS aceita origens configuradas, o corpo JSON tem limite e erros internos não são expostos ao cliente. Os demais endpoints não têm limitação de requisições na API: configure e teste limites no proxy/gateway. Para múltiplas instâncias ou proxy reverso, configure e teste também uma estratégia compartilhada de limitação do login e confiança no proxy antes de expor a API. Testes ainda são iniciais e devem ser ampliados com testes de integração de isolamento de tenant antes de produção.

## Limitações relevantes

A primeira versão de estoque exige ajustes manuais; consumo automático por ficha técnica ao confirmar pedido, compras, transferências e inventário guiado ainda devem ser desenvolvidos. Caixa e relatórios são gerenciais, não conciliação contábil. Não há integração fiscal, pagamento em cartão/PIX, WhatsApp oficial, impressão de produção ou delivery de terceiros sem adaptadores e homologações reais. Não exponha em produção antes de executar a validação Prisma/TypeScript, migrações, testes de integração e revisão de segurança, incluindo permissões por perfil e escopo de unidades.

Antes de qualquer implantação, revise também `npm audit` e atualize dependências vulneráveis com testes de compatibilidade, configure HTTPS e segredos reais, verifique backups e restauração, e teste concorrência de caixa/pagamentos e isolamento entre tenants com um PostgreSQL real. Esta etapa é um endurecimento inicial, não uma certificação de prontidão para produção.
