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
npm run test --workspace apps/api   # testes com banco real: RUN_DB_TESTS=1 e DATABASE_URL de um banco migrado e descartável
npm run test --workspace apps/print-agent
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
- Estoque e fichas: interface em `/inventory` e endpoints `GET|POST /inventory/ingredients`, `POST /inventory/ingredients/:id/movements`, `GET /inventory/movements`, `GET|PUT /inventory/recipes/:productId`. Ao avançar um pedido de `OPEN` para `PREPARING`, a API baixa atomicamente o estoque da receita e registra movimentações; sem receita, mantém o fluxo sem baixa. A transição exige saldo suficiente e não pode ser repetida ou revertida pelo fluxo de status.
- Caixa/pagamentos: interface em `/cash` para abertura/fechamento de caixa e registro manual de pagamentos em pedidos com saldo, usando `POST|GET /cash/sessions`, `POST /cash/sessions/:id/close`, `POST|GET /cash/payments`. A interface mostra saldos e diferenças, mas PIX/cartões não são cobrados nem confirmados por provedor externo.
- Entrega: `GET|POST /delivery`, `PATCH /delivery/:id/status`; zonas e taxas em `GET|POST /delivery/zones`, `PATCH /delivery/zones/:id`. Pedidos `DELIVERY` com `deliveryZoneId` somam a taxa e respeitam o pedido mínimo.
- Motor central de pedidos (`apps/api/src/lib/order-engine.ts`): PDV, garçom, QR da mesa e demais canais usam `createOrder`, que valida produtos/mesa/cupom/zona por empresa e unidade, calcula desconto, taxa de serviço (percentual da unidade em pedidos de mesa, dispensável com `applyServiceFee:false`) e taxa de entrega, vincula/cria o cliente e enfileira a impressão dos setores com impressão automática, tudo em transação serializável.
- Produção e impressão: setores (`GET|POST /production/sectors`, `PATCH /production/sectors/:id`) ligados a impressoras (`GET|POST /printing/printers`, `PATCH /printing/printers/:id`, `POST /printing/printers/:id/test`). O produto conhece só o setor; o setor conhece a impressora principal. Cada pedido gera um ticket por setor na fila `PrintJob` (`GET /printing/jobs`, `POST /printing/jobs/:id/retry`, `POST /printing/orders/:orderId/print` para reimpressão). Setor sem impressora ativa gera job `FAILED` reenviável.
- Agente de impressão (`apps/print-agent`): serviço Node sem dependências para o computador do restaurante. Crie o agente em `POST /printing/agents` (o token aparece uma única vez; só o hash é guardado) e execute `RM_API_URL=https://.../api/v1 RM_AGENT_TOKEN=rmagt_... npm start --workspace apps/print-agent`. Ele busca jobs em `/print-agent/jobs/next`, imprime em ESC/POS via TCP (porta 9100) e confirma em `/print-agent/jobs/:id/result` (até 3 tentativas; jobs presos em impressão por mais de 2 minutos são reabertos). Impressoras USB/compartilhadas/seriais ainda não são suportadas pelo agente; empacotamento como instalador Windows não está incluído.
- Adicionais e combos: grupos de adicionais (`GET|POST /catalog/modifier-groups`, `PATCH /catalog/modifier-groups/:id`, `POST /catalog/modifier-groups/:id/options`, `PATCH /catalog/modifier-options/:id`) com mínimo/máximo, preço e setor próprio por opção, vinculados a produtos em `PUT /catalog/products/:id/modifier-groups`. Combos em `PUT /catalog/products/:id/combo`: cobrados em uma linha, com cada componente produzido/impresso no seu setor. Pedidos aceitam `items[].modifiers: [{optionId, quantity}]`.
- Mesas e QR: `GET|POST /tables`, `PATCH /tables/:id`, `POST /tables/:id/rotate-qr`. O QR aponta para `/m/<token>` no site; a API pública (`GET /public/tables/:token/menu`, `POST /public/tables/:token/orders`) tem limite próprio, no máximo 10 pedidos abertos por mesa e não permite que pedidos anônimos alterem clientes existentes.
- CRM e LGPD: `GET|POST /customers`, `GET|PATCH /customers/:id`, pontos de fidelidade (1 por real inteiro ao concluir o pedido), `GET /customers/:id/export` e `POST /customers/:id/anonymize` (gerência). Ao ficar `READY`, pedidos com cliente enfileiram a mensagem `order_ready` no outbox.
- Compras e inventário: `GET|POST /purchasing/suppliers`, `GET|POST /purchasing/orders`, `POST /purchasing/orders/:id/receive|cancel`. O recebimento atualiza estoque, custo médio ponderado e gera conta a pagar. `POST /inventory/counts` aplica inventário guiado com ajustes auditáveis.
- Cupons e reservas: `GET|POST|PATCH /coupons` (percentual ou fixo, validade, mínimo, limite de usos aplicado atomicamente) e `GET|POST|PATCH /reservations` (bloqueia a mesma mesa em janela de 90 minutos e respeita capacidade).
- Permissões por perfil (`apps/api/src/lib/permissions.ts`): gerência (`ADMIN`, `MANAGER`) cadastra; financeiro acessa financeiro/relatórios/compras; caixa e garçom vendem; cozinha acessa KDS e fila; entregador acessa entregas.
- Outbox WhatsApp: `apps/api/src/lib/whatsapp-worker.ts` define a interface `WhatsappProvider` e o processamento da fila; nenhum provedor real está incluído, então nada é marcado como enviado sem adaptador configurado.
- WhatsApp: `POST|GET /whatsapp/outbox`. O endpoint apenas enfileira um registro auditável; envio real requer adaptador de provedor oficial e worker configurado.
- Financeiro e relatórios: `GET|POST /financial/entries`, `GET /financial/summary`, `GET /reports/overview?from=ISO&to=ISO`, `GET /reports/waiters?from=ISO&to=ISO` (vendas e taxa de serviço concluídas por atendente, base para regras de gorjeta/comissão; as regras de rateio em si ainda não são calculadas).

Rotas privadas exigem token Bearer. Os escopos tenant/unidade vêm do usuário autenticado no banco. O login limita tentativas a 10 por 15 minutos; a API aplica um limite geral de 300 requisições por 15 minutos, ambos em memória por processo. CORS aceita origens configuradas, o corpo JSON tem limite e erros internos não são expostos ao cliente. Para múltiplas instâncias, configure um armazenamento compartilhado de limites; atrás de proxy, ajuste e teste `trust proxy` de acordo com sua topologia e aplique limites no gateway antes de expor a API. Há testes de integração com PostgreSQL real cobrindo isolamento entre empresas, permissões, pedidos, impressão, QR, compras e reservas; amplie-os para os demais módulos antes de produção.

## Limitações relevantes

Estoque: consumo automático por ficha técnica ao iniciar o preparo, compras com custo médio e inventário guiado; transferências entre unidades ainda não existem. Cancelar um pedido não estorna estoque nem cupom. Caixa e relatórios são gerenciais, não conciliação contábil. Não há emissão fiscal (NFC-e/NF-e), pagamento em cartão/PIX, WhatsApp oficial, integrações de delivery de terceiros (iFood etc.), comissões, escalas nem baixa de estoque por adicionais; todos dependem de módulos e homologações reais ainda não implementados. Não exponha em produção antes de executar a validação Prisma/TypeScript, migrações, testes de integração e revisão de segurança, incluindo permissões por perfil e escopo de unidades.

Antes de qualquer implantação, revise também `npm audit` e atualize dependências vulneráveis com testes de compatibilidade, configure HTTPS e segredos reais, verifique backups e restauração, e teste concorrência de caixa/pagamentos e isolamento entre tenants com um PostgreSQL real. Esta etapa é um endurecimento inicial, não uma certificação de prontidão para produção.
