import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { once } from 'node:events';
import { prisma } from './prisma';

test('API security controls and tenant authentication', async () => {
  process.env.CORS_ORIGIN = 'http://localhost:3000,https://restaurant.example';
  process.env.JWT_SECRET = 'a-secret-with-at-least-32-characters';
  const { app, parseAllowedOrigins } = await import('../index');
  assert.deepEqual(parseAllowedOrigins(undefined), []);
  assert.deepEqual(parseAllowedOrigins(' https://restaurant.example, http://localhost:3000 '), ['https://restaurant.example', 'http://localhost:3000']);
  for (const invalid of ['*', 'null', 'https://restaurant.example/path', 'https://user@restaurant.example']) {
    assert.throws(() => parseAllowedOrigins(invalid), /exact HTTP/);
  }
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const originalFindUnique = prisma.user.findUnique;
  const passwordHash = bcrypt.hashSync('correct-password', 4);
  let tenantStatus = 'TRIAL';
  let accountStatus = 'ACTIVE';
  let tenantId: string | null = 'tenant-1';
  let authVersion = 0;
  let databaseFails = false;
  (prisma.user as any).findUnique = async (args: any) => {
    if (databaseFails) throw new Error('private database details');
    if (args.select && !args.select.status) return { id: 'user-1', name: 'User', email: 'user@example.com', role: 'ADMIN', tenantId: 'tenant-1', unitId: null };
    return { id: 'user-1', name: 'User', email: 'user@example.com', passwordHash, role: 'ADMIN', status: accountStatus, tenantId, unitId: null, authVersion, tenant: tenantId ? { status: tenantStatus, license: null, modules: [] } : null };
  };
  const login = () => fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'user@example.com', password: 'correct-password' }) });
  try {
    const health = await fetch(`${base}/health`, { headers: { origin: 'https://restaurant.example' } });
    assert.equal(health.headers.get('access-control-allow-origin'), 'https://restaurant.example');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-powered-by'), null);
    const attacker = { headers: { origin: 'https://restaurant.example.attacker.test' } };
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'development';
      assert.equal((await fetch(`${base}/health`, attacker)).headers.get('access-control-allow-origin'), attacker.headers.origin);
      process.env.NODE_ENV = 'production';
      const rejected = await fetch(`${base}/health`, attacker);
      assert.equal(rejected.status, 403);
      assert.equal(rejected.headers.get('access-control-allow-origin'), null);
    } finally {
      if (originalEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnv;
    }
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const malformed = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), { message: 'Invalid JSON body' });
    const oversized = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(1024 * 1024) }) });
    assert.equal(oversized.status, 413);

    const trial = await login();
    assert.equal(trial.status, 200);
    const { accessToken } = await trial.json() as { accessToken: string };
    const me = () => fetch(`${base}/auth/me`, { headers: { authorization: 'Bearer' + ' ' + accessToken } });
    assert.equal((await me()).status, 200);
    authVersion = 1;
    assert.equal((await me()).status, 401, 'changing the credential version revokes existing sessions');
    authVersion = 0;
    tenantId = null;
    assert.equal((await login()).status, 401);
    assert.equal((await me()).status, 403);
    tenantId = 'tenant-1';
    tenantStatus = 'ACTIVE';
    assert.equal((await login()).status, 200);
    for (const status of ['SUSPENDED', 'BLOCKED']) {
      tenantStatus = status;
      assert.equal((await login()).status, 401);
      assert.equal((await me()).status, 403);
    }
    tenantStatus = 'TRIAL';
    accountStatus = 'BLOCKED';
    assert.equal((await login()).status, 401);
    assert.equal((await me()).status, 401);
    accountStatus = 'ACTIVE';
    databaseFails = true;
    const failure = await me();
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { message: 'Internal server error' });
    databaseFails = false;
    let response: Response | undefined;
    for (let i = 0; i < 12; i++) {
      response = await login();
      if (response.status === 429) break;
    }
    assert.equal(response?.status, 429);
    assert.equal(response?.headers.get('x-ratelimit-limit'), null);
    assert(response?.headers.get('ratelimit'));
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const apiLimitResponses = await Promise.all(Array.from({ length: 300 }, () => fetch(`${base}/health`)));
    assert(apiLimitResponses.some(result => result.status === 429));
  } finally {
    (prisma.user as any).findUnique = originalFindUnique;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  }
});
