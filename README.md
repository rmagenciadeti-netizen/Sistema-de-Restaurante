# RM Restaurant SaaS

Monólito modular para restaurantes, com Next.js, TypeScript, PostgreSQL/Prisma e Docker. Integrações fiscais, WhatsApp, pagamentos e impressão física requerem provedor, contrato/homologação e configuração próprios; a API não finge envio ou autorização de terceiros.

## Desenvolvimento local

1. Copie `.env.example` para `.env`; configure segredo JWT aleatório com 32+ caracteres, origens CORS exatas e credenciais fortes. Em cada terminal, exporte as variáveis para os comandos dos workspaces: `set -a; . ./.env; set +a` (use apenas um `.env` confiável).
2. Inicie o PostgreSQL local: `docker compose up -d postgres`. No Compose de desenvolvimento, ele fica acessível apenas em `127.0.0.1:5432` e usa `postgres/postgres`; não reutilize essa credencial nem exponha essa configuração em produção.
3. Instale pacotes: `npm ci`.
4. Aplique a migração versionada em um banco local vazio: `npm run db:deploy`.
5. Crie o Master: `npm run seed:master`. O seed recusa qualquer conta existente com o mesmo e-mail; não altera nem promove contas.
6. Inicie `npm run dev:api` e `npm run dev` em terminais separados.

## Verificação da API

Na raiz do repositório, com Node.js 22:

```sh
npm ci
npm audit --audit-level=moderate
DATABASE_URL=postgresql://postgres@localhost:5432/validation?schema=public npm run db:validate
DATABASE_URL=postgresql://postgres@localhost:5432/validation?schema=public npm run db:generate
npm run build --workspace apps/api
npm run test --workspace apps/api
npm run lint --workspace apps/web
npm run build --workspace apps/web
```

Validação e geração do cliente não conectam ao banco; a URL acima é apenas um exemplo para esses comandos. Para testar `db:deploy` localmente, use o banco de desenvolvimento configurado no `.env`, após revisar a seção de migrações. A CI aplica as migrações em um serviço PostgreSQL 16 limpo e confere o status. O lint web emite avisos para alguns efeitos de carregamento e hidratação existentes; eles não são convertidos em erros de forma a não incentivar mudanças de comportamento fora desta etapa.

## Migrações e dados existentes

Uma migração Prisma inicial foi gerada em modo `--create-only`, inspecionada e aplicada com sucesso a um PostgreSQL 16 descartável e vazio. Ela cria as 20 tabelas do schema atual; nenhum SQL de remoção ou alteração de dados existentes foi gerado. A migração versionada pode ser aplicada a uma base local vazia com `npm run db:deploy`. Antes de implantá-la, revise o SQL e faça backup do banco alvo.

Para um banco que já contém dados ou tabelas, **não aplique cegamente** a migração inicial nem use comandos de reset. Compare o schema e o histórico reais, preserve backups e siga o procedimento oficial de [baseline de banco existente](https://www.prisma.io/docs/orm/prisma-migrate/workflows/baselining), revisando a SQL e executando `migrate resolve --applied` somente quando o schema existente corresponder integralmente à migração. Em implantação, use `npm run db:deploy`; nunca execute `migrate dev` em produção.

## Módulos e endpoints novos

- CRUD parcial/soft delete: atualizações em `/employees/:id`, `/products/:id` e `/units/:id`; registros operacionais usam status, preservando histórico.
- Produção/KDS: `GET /production/kds?sectorId=...`, `PATCH /production/items/:id/status`.
- Estoque e fichas: `GET|POST /inventory/ingredients`, `POST /inventory/ingredients/:id/movements`, `GET /inventory/movements`, `GET|PUT /inventory/recipes/:productId`.
- Caixa/pagamentos: `POST|GET /cash/sessions`, `POST /cash/sessions/:id/close`, `POST|GET /cash/payments`.
- Entrega: `GET|POST /delivery`, `PATCH /delivery/:id/status`.
- WhatsApp: `POST|GET /whatsapp/outbox`. O endpoint apenas enfileira um registro auditável; envio real requer adaptador de provedor oficial e worker configurado.
- Financeiro e relatórios: `GET|POST /financial/entries`, `GET /financial/summary`, `GET /reports/overview?from=ISO&to=ISO`.

Rotas privadas exigem token Bearer. Os escopos tenant/unidade vêm do usuário autenticado no banco. O login limita tentativas a 10 por 15 minutos; a API aplica um limite geral de 300 requisições por 15 minutos, ambos em memória por processo. CORS aceita origens configuradas, o corpo JSON tem limite e erros internos não são expostos ao cliente. Para múltiplas instâncias, configure um armazenamento compartilhado de limites; atrás de proxy, ajuste e teste `trust proxy` de acordo com sua topologia e aplique limites no gateway antes de expor a API. Testes ainda são iniciais e devem ser ampliados com testes de integração de isolamento de tenant antes de produção.

## Limitações relevantes

A primeira versão de estoque exige ajustes manuais; consumo automático por ficha técnica ao confirmar pedido, compras, transferências e inventário guiado ainda devem ser desenvolvidos. Caixa e relatórios são gerenciais, não conciliação contábil. Não há integração fiscal, pagamento em cartão/PIX, WhatsApp oficial, impressão de produção ou delivery de terceiros sem adaptadores e homologações reais. Não exponha em produção antes de executar a validação Prisma/TypeScript, migrações, testes de integração e revisão de segurança, incluindo permissões por perfil e escopo de unidades.

Antes de qualquer implantação, revise também `npm audit` e atualize dependências vulneráveis com testes de compatibilidade, configure HTTPS e segredos reais, verifique backups e restauração, e teste concorrência de caixa/pagamentos e isolamento entre tenants com um PostgreSQL real. Esta etapa é um endurecimento inicial, não uma certificação de prontidão para produção.
