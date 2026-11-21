# Publicação: GitHub → Vercel (web e admin) + Render (API e worker) + Neon (PostgreSQL)

Estado: o repositório está pronto; **as contas Vercel, Render e Neon ainda precisam ser conectadas por quem tem acesso a elas** (não há credenciais nem integração GitHub configurada). Nada abaixo foi executado em produção.

## 1. Neon (banco de produção, separado do desenvolvimento)
1. Projeto/branch de produção novo; copie duas strings: **com pooler** (`DATABASE_URL` da API) e **direta** (`DATABASE_DIRECT_URL`, só migrations). Ambas com `sslmode=require`.
2. Antes da primeira migration em banco com dados: conferir a janela de restauração (PITR) do plano e anotar o horário (ponto de retorno).
3. Banco já existente: não rode a migration inicial às cegas (ver README, "baseline"). Banco vazio: `migrate deploy` aplica todas as migrations (todas aditivas; testado em banco vazio e em upgrade com dados).

## 2. Render (`render.yaml`, Blueprint)
- *New › Blueprint* apontando para este repositório/branch `main`. Cria `rm-restaurant-api` (health check `/api/v1/health`) e `rm-restaurant-worker`, ambos com deploy automático.
- Preencha as variáveis `sync: false` (lista em `.env.example`; a API recusa subir com segredos fracos, `env-check.ts`). `CORS_ORIGIN`, `RM_RESTAURANT_URL` e `RM_ADMIN_URL` = URLs finais do Vercel.
- `preDeployCommand` roda `prisma migrate deploy` com a conexão direta antes de cada deploy; se falhar, o deploy não troca a versão em execução.
- O disco `/var/data` guarda os backups da RM Smart Migration (exige plano com disco).
- `TEF_ENABLE_SIMULATOR` e `DEV_DISABLE_MFA` **não** devem existir em produção.

### Worker (`rm-restaurant-worker`)
- Variáveis: `DATABASE_URL`, `MFA_ENCRYPTION_KEY` e `RM_RESTAURANT_URL` vêm **da própria API** (`fromService` no `render.yaml`, atualizadas a cada sync do Blueprint): mesmo banco, mesmas chaves, nada para copiar. As variáveis `AI_*` são opcionais.
- Em produção o worker **recusa subir** (e o deploy falha, mantendo a versão anterior) se faltar/estiver inválida `DATABASE_URL` ou `MFA_ENCRYPTION_KEY`, ou se o banco não responder após 6 tentativas; o motivo aparece no log (só nomes, nunca valores).
- Logs: `Worker started`, `database connection OK`, linhas de evento (`scheduled orders released=N`, `automation notifications created=N`) e um resumo `[worker] heartbeat ...` a cada 5 min (`WORKER_LOG_EVERY_MS`).
- **Prova de que está processando** (não só "Live"): `GET /api/v1/health/worker` na API → `200` com `"status":"up"`, idade do heartbeat, `commit` em execução e, por tarefa (`scheduling`, `automations`, `outbox`), `runs`/`processed`/`failures`. `503` = `degraded` (vivo, mas uma tarefa falha/parou), `down` (parou ou sem heartbeat há >45 s) ou `absent` (nunca reportou). Verificação automática: `node scripts/verify-worker.mjs https://<api>.onrender.com [--commit <sha>]`.
- A migration `worker_heartbeat` (tabela do heartbeat) roda no `preDeployCommand` da API; até ela terminar o worker apenas registra "heartbeat could not be saved" e segue trabalhando.

### Atendente de IA do WhatsApp
- É o próprio robô do WhatsApp com inteligência conversacional: o cliente fala livremente, muda de assunto, faz várias perguntas numa mensagem, e o atendente consulta os **dados reais** do restaurante e executa **reservas e pedidos** no backend (ferramentas), sem fluxo fixo. Código em `apps/api/src/lib/whatsapp-agent/`.
- **Para funcionar** (nada novo a configurar no Render): robô ligado no painel (WhatsApp › chave "Robô de atendimento"), provedor de IA da plataforma configurado e verificado (RM Painel Admin › Serviços da plataforma; **o modelo precisa suportar chamada de ferramentas** — o "Testar conexão" agora mostra `toolCalling: ok`) e a empresa com o consentimento de IA externa ligado. Se algo faltar (ou o limite diário `ai.limits.llmCallsWhatsappDay` acabar, ou o provedor cair), o **robô clássico por palavras-chave atende** e o painel mostra o motivo; nada para de responder.
- Memória por cliente no banco (`WhatsappConversation.agentMemory`: perfil, reserva, pedido, entrega, pagamento, confirmações pendentes) e registro de ações em `WhatsappAgentAction`; ambos sobrevivem a reinícios do worker e a reconexões. Cada restaurante e cada cliente é isolado: as ferramentas nunca recebem tenant, telefone ou conversa do modelo.
- Regras que o **backend** garante (não dependem do prompt): reserva/pedido só é confirmado ao cliente depois que a ferramenta retorna ok; pedido, alteração e cancelamento exigem confirmação do cliente em mensagem posterior; operação executa uma vez (chave de deduplicação); valor máximo do pedido, prazo para alterar/cancelar, limite de pessoas, horário de funcionamento, mesas livres, estoque e zonas de entrega.
- Painel: WhatsApp › **Atendente de IA** (estado, personalidade, instruções, o que pode fazer, limites, registro de ações); "Testar robô" simula o atendente com dados reais sem gravar; em Conversas há o resumo do que o atendente sabe e fez. Verificação com um modelo real: `AGENT_LIVE_API_KEY=... DATABASE_URL=<banco local> node --import tsx apps/api/scripts/agent-live-check.ts`.
- `WHATSAPP_PARALLEL_CHATS` (padrão 4): quantas conversas o gerenciador atende ao mesmo tempo (cada cliente é atendido em ordem).

### WhatsApp (QR Code) e IA nos restaurantes
- **WhatsApp:** sem variáveis por cliente. A API (e o worker, se existir) inicia o serviço de sessões sozinho (`WHATSAPP_SESSIONS_MODE=auto`); só um processo opera por vez (eleição no banco) e assume se o outro cair ou for reiniciado. O pareamento fica **criptografado no banco** (chave `WHATSAPP_AUTH_ENCRYPTION_KEY`, ou `MFA_ENCRYPTION_KEY`; **não troque a chave** depois de existirem pareamentos, ou será preciso ler o QR de novo). O restaurante só precisa do módulo *WhatsApp* liberado no painel admin e ler o QR em *WhatsApp › Conexão*.
- **IA:** no RM Painel Admin › *Serviços da plataforma*, escolha provedor e modelo, informe a chave e clique em *Testar conexão*. A chave é guardada criptografada e nunca volta ao navegador. Alternativa por ambiente: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`. Sem chave válida o sistema exibe "IA não configurada"; só aparece "verificada" após uma chamada real bem-sucedida.

## 3. Vercel (dois projetos, mesmo repositório)
| Projeto | Root Directory | Install | Build |
|---|---|---|---|
| web (restaurante) | `apps/web` | `cd ../.. && npm ci` | `cd ../.. && npm run db:generate; npm run build --workspace apps/web` |
| admin (painel master) | `apps/admin` | `cd ../.. && npm ci` | `cd ../.. && npm run build --workspace apps/admin` |
- Variável nos dois: `API_INTERNAL_URL=https://<api-no-render>/api/v1` (o Next faz proxy `/api-proxy/*`).
- Branch de produção `main` (deploy automático); previews apontam para uma API de staging.

## 4. Pós-deploy (checklist)
`GET /api/v1/health` = 200; login no web e no admin; `prisma migrate status` = atualizado; um pedido de teste num restaurante de teste; isolamento entre dois restaurantes; logs do Render sem erros; PWA instalável via HTTPS.

## 5. Rollback
Render e Vercel: *Rollback* para o deploy anterior (código). Banco: as migrations são aditivas, então o código anterior continua compatível; para desfazer dados use o PITR do Neon (restaurar para o horário anotado) ou o dump de `docs/BACKUP.md`.
