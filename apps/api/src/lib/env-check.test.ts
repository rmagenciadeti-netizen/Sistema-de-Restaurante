import assert from 'node:assert/strict';
import test from 'node:test';
import { checkProductionEnv } from './env-check';

const good = { NODE_ENV: 'production', JWT_SECRET: 'q7Zk2mVx9LpR4tYw8NbC3dFhJ6sA1gUe0oIiXzMn', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'), DATABASE_URL: 'postgresql://u:p@ep-x.neon.tech/db?sslmode=require', CORS_ORIGIN: 'https://app.example', RM_RESTAURANT_URL: 'https://app.example', RM_ADMIN_URL: 'https://admin.example', MIGRATION_BACKUP_DIR: '/data/b', MIGRATION_BACKUP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('hex'), FISCAL_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64') } as NodeJS.ProcessEnv;

test('a complete production configuration passes without errors', () => assert.deepEqual(checkProductionEnv(good), { errors: [], warnings: [] }));

test('example and weak secrets, bad keys, missing origins and Neon without SSL are refused; messages never contain values', () => {
  const bad = { ...good, JWT_SECRET: 'replace-with-a-random-secret-at-least-32-characters', MFA_ENCRYPTION_KEY: 'curta', DATABASE_URL: 'postgresql://u:SENHA-SECRETA@ep-x.neon.tech/db', CORS_ORIGIN: '*', RM_ADMIN_URL: '' } as NodeJS.ProcessEnv;
  const { errors } = checkProductionEnv(bad);
  assert.equal(errors.length, 5, errors.join('|'));
  assert.ok(errors.some(e => e.startsWith('JWT_SECRET')) && errors.some(e => e.startsWith('MFA_ENCRYPTION_KEY')) && errors.some(e => /sslmode/.test(e)) && errors.some(e => e.startsWith('CORS_ORIGIN')) && errors.some(e => e.startsWith('RM_ADMIN_URL')));
  assert.equal(errors.join().includes('SENHA-SECRETA') || errors.join().includes('curta'), false);
  assert.ok(checkProductionEnv({ ...good, JWT_SECRET: 'a'.repeat(40) }).errors.some(e => e.startsWith('JWT_SECRET')), 'low entropy');
});

test('backup variables only warn (the migration stays blocked), a malformed backup key is an error', () => {
  const missing = { ...good, MIGRATION_BACKUP_DIR: '', MIGRATION_BACKUP_ENCRYPTION_KEY: '' } as NodeJS.ProcessEnv;
  const result = checkProductionEnv(missing);
  assert.equal(result.errors.length, 0); assert.equal(result.warnings.length, 2);
  assert.equal(checkProductionEnv({ ...good, MIGRATION_BACKUP_ENCRYPTION_KEY: 'xx' } as NodeJS.ProcessEnv).errors.length, 1);
});
