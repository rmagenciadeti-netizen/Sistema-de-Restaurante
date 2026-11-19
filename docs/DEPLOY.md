# Publicação: GitHub → Vercel (web e admin) + Render (API e worker) + Neon (PostgreSQL)

Estado: o repositório está pronto; **as contas Vercel, Render e Neon ainda precisam ser conectadas por quem tem acesso a elas** (não há credenciais nem integração GitHub configurada). Nada abaixo foi executado em produção.

## 1. Neon (banco de produção, separado do desenvolvimento)
1. Projeto/branch de produção novo; copie duas strings: **com pooler** (`DATABASE_URL` da API) e **direta** (`DATABASE_DIRECT_URL`, só migrations). Ambas com `sslmode=require`.
2. Antes da primeira migration em banco com dados: conferir a janela de restauração (PITR) do plano e anotar o horário (ponto de retorno).
3. Banco já existente: não rode a migration inicial às cegas (ver README, "baseline"). Banco vazio: `migrate deploy` aplica as 55 migrations (todas aditivas; testado em banco vazio e em upgrade com dados).

## 2. Render (`render.yaml`, Blueprint)
- *New › Blueprint* apontando para este repositório/branch `main`. Cria `rm-restaurant-api` (health check `/api/v1/health`) e `rm-restaurant-worker`, ambos com deploy automático.
- Preencha as variáveis `sync: false` (lista em `.env.example`; a API recusa subir com segredos fracos, `env-check.ts`). `CORS_ORIGIN`, `RM_RESTAURANT_URL` e `RM_ADMIN_URL` = URLs finais do Vercel.
- `preDeployCommand` roda `prisma migrate deploy` com a conexão direta antes de cada deploy; se falhar, o deploy não troca a versão em execução.
- O disco `/var/data` guarda os backups da RM Smart Migration (exige plano com disco).
- `TEF_ENABLE_SIMULATOR` e `DEV_DISABLE_MFA` **não** devem existir em produção.

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
