// Fail-fast validation of the production configuration. It only reports variable NAMES and rules, never values.
export type EnvReport = { errors: string[]; warnings: string[] };

const PLACEHOLDER = /replace[-_ ]?with|changeme|change[-_ ]me|your[-_ ]|example|secret123|password|default/i;
const is32Bytes = (value: string) => (/^[\da-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64')).length === 32;

export function checkProductionEnv(env: NodeJS.ProcessEnv): EnvReport {
  const errors: string[] = []; const warnings: string[] = [];
  const jwt = env.JWT_SECRET ?? '';
  if (jwt.length < 32) errors.push('JWT_SECRET: mínimo de 32 caracteres.');
  else if (PLACEHOLDER.test(jwt) || new Set(jwt).size < 10) errors.push('JWT_SECRET: valor de exemplo ou de baixa entropia; gere com `openssl rand -base64 48`.');

  if (!env.MFA_ENCRYPTION_KEY) errors.push('MFA_ENCRYPTION_KEY: obrigatória (32 bytes, hex ou base64).');
  else if (!is32Bytes(env.MFA_ENCRYPTION_KEY)) errors.push('MFA_ENCRYPTION_KEY: deve ter 32 bytes (hex ou base64).');

  const url = env.DATABASE_URL;
  if (!url) errors.push('DATABASE_URL: obrigatória.');
  else {
    try {
      const parsed = new URL(url);
      if (!/^postgres(ql)?:$/.test(parsed.protocol)) errors.push('DATABASE_URL: deve ser uma URL PostgreSQL.');
      if (/neon\.tech$/i.test(parsed.hostname) && !['require', 'verify-full', 'verify-ca'].includes(parsed.searchParams.get('sslmode') ?? '')) errors.push('DATABASE_URL: o Neon exige sslmode=require.');
      if (['localhost', '127.0.0.1'].includes(parsed.hostname)) warnings.push('DATABASE_URL: aponta para o próprio host; confirme que é o banco de produção.');
    } catch { errors.push('DATABASE_URL: URL inválida.'); }
  }

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
