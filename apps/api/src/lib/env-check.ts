// Fail-fast validation of the production configuration. It only reports variable NAMES and rules, never values.
export type EnvReport = { errors: string[]; warnings: string[] };

const PLACEHOLDER = /replace[-_ ]?with|changeme|change[-_ ]me|your[-_ ]|example|secret123|password|default/i;
const is32Bytes = (value: string) => (/^[\da-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')).length === 32;

// Shared by the API and the worker: both must talk to the same database and open the same encrypted values (WhatsApp pairing, AI key, MFA secrets).
function checkMfaKey(env: NodeJS.ProcessEnv, errors: string[]) {
  if (!env.MFA_ENCRYPTION_KEY) errors.push('MFA_ENCRYPTION_KEY: obrigatória (32 bytes, hex ou base64).');
  else if (!is32Bytes(env.MFA_ENCRYPTION_KEY)) errors.push('MFA_ENCRYPTION_KEY: deve ter 32 bytes (hex ou base64).');
}

function checkDatabaseUrl(env: NodeJS.ProcessEnv, errors: string[], warnings: string[]) {
  const url = env.DATABASE_URL;
  if (!url) { errors.push('DATABASE_URL: obrigatória.'); return; }
  try {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol)) errors.push('DATABASE_URL: deve ser uma URL PostgreSQL.');
    if (/neon\.tech$/i.test(parsed.hostname) && !['require', 'verify-full', 'verify-ca'].includes(parsed.searchParams.get('sslmode') ?? '')) errors.push('DATABASE_URL: o Neon exige sslmode=require.');
    if (['localhost', '127.0.0.1'].includes(parsed.hostname)) warnings.push('DATABASE_URL: aponta para o próprio host; confirme que é o banco de produção.');
  } catch { errors.push('DATABASE_URL: URL inválida.'); }
}

export function checkProductionEnv(env: NodeJS.ProcessEnv): EnvReport {
  const errors: string[] = []; const warnings: string[] = [];
  const jwt = env.JWT_SECRET ?? '';
  if (jwt.length < 32) errors.push('JWT_SECRET: mínimo de 32 caracteres.');
  else if (PLACEHOLDER.test(jwt) || new Set(jwt).size < 10) errors.push('JWT_SECRET: valor de exemplo ou de baixa entropia; gere com `openssl rand -base64 48`.');

  checkMfaKey(env, errors);
  checkDatabaseUrl(env, errors, warnings);

  for (const name of ['CORS_ORIGIN', 'RM_RESTAURANT_URL', 'RM_ADMIN_URL'] as const) if (!env[name]) errors.push(`${name}: obrigatória em produção.`);
  if (env.CORS_ORIGIN?.split(',').some(origin => origin.trim() === '*')) errors.push('CORS_ORIGIN: não use "*" em produção; liste as origens exatas.');

  if (env.FISCAL_ENCRYPTION_KEY && !is32Bytes(env.FISCAL_ENCRYPTION_KEY)) errors.push('FISCAL_ENCRYPTION_KEY: deve ter 32 bytes (hex ou base64).');
  else if (!env.FISCAL_ENCRYPTION_KEY) warnings.push('FISCAL_ENCRYPTION_KEY: ausente; certificados e tokens fiscais não poderão ser salvos.');

  if (env.MIGRATION_REQUIRE_BACKUP !== 'false') {
    if (!env.MIGRATION_BACKUP_DIR) warnings.push('MIGRATION_BACKUP_DIR: ausente; a RM Smart Migration não poderá gerar backup e ficará bloqueada. Use volume persistente.');
    if (!env.MIGRATION_BACKUP_ENCRYPTION_KEY) warnings.push('MIGRATION_BACKUP_ENCRYPTION_KEY: ausente; a RM Smart Migration ficará bloqueada.');
    else if (!is32Bytes(env.MIGRATION_BACKUP_ENCRYPTION_KEY)) errors.push('MIGRATION_BACKUP_ENCRYPTION_KEY: deve ter 32 bytes (hex ou base64).');
  }
  if (env.DEV_DISABLE_MFA === 'true') warnings.push('DEV_DISABLE_MFA: ignorada em produção.');
  return { errors, warnings };
}

// Called from the API entry point only; tests importing the app are unaffected.
export function assertProductionEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const { errors, warnings } = checkProductionEnv(env);
  for (const warning of warnings) console.warn(`[config] ${warning}`);
  if (errors.length > 0) { console.error(`[config] Configuração de produção inválida:\n - ${errors.join('\n - ')}`); process.exit(1); }
}

// The worker needs far less than the API (no JWT, CORS, fiscal or backup settings) but must point at the same database and keys. Without this check a
// misconfigured worker stays "Live" on the host while every task fails, so it refuses to start instead.
export function checkWorkerEnv(env: NodeJS.ProcessEnv): EnvReport {
  const errors: string[] = []; const warnings: string[] = [];
  checkDatabaseUrl(env, errors, warnings);
  checkMfaKey(env, errors);
  if (!env.RM_RESTAURANT_URL) warnings.push('RM_RESTAURANT_URL: ausente; o robô do WhatsApp não consegue enviar o link da loja.');
  if (env.WHATSAPP_TEMPLATES) { try { JSON.parse(env.WHATSAPP_TEMPLATES); } catch { errors.push('WHATSAPP_TEMPLATES: deve ser um JSON válido.'); } }
  const cloudSettings = [env.WHATSAPP_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID, env.WHATSAPP_TEMPLATES].filter(Boolean).length;
  if (cloudSettings > 0 && cloudSettings < 3) warnings.push('WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_TEMPLATES devem ser definidos juntos; a API oficial do WhatsApp ficará desligada.');
  if (Boolean(env.AI_API_KEY) !== Boolean(env.AI_MODEL)) warnings.push('AI_API_KEY e AI_MODEL devem ser definidos juntos; a IA por variáveis de ambiente ficará desligada (a configuração do painel admin continua valendo).');
  return { errors, warnings };
}

// Called from the worker entry point only.
export function assertWorkerEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const { errors, warnings } = checkWorkerEnv(env);
  for (const warning of warnings) console.warn(`[config] ${warning}`);
  if (errors.length > 0) { console.error(`[config] Configuração do worker inválida:\n - ${errors.join('\n - ')}`); process.exit(1); }
}
