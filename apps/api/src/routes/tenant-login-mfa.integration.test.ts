import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('login: MFA is enforced only for MASTER_ADMIN, never for restaurant users', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.DEV_DISABLE_MFA = 'false';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  const suffix = randomBytes(4).toString('hex');
  const password = 'Senha-Forte-123!';
  const passwordHash = await bcrypt.hash(password, 4);
  const tenant = await prisma.tenant.create({ data: { name: `mfa ${suffix}`, slug: `mfa-${suffix}`, status: 'ACTIVE' } });
  // mfaEnabled on a restaurant user must not turn into a login challenge.
  const staff = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Dono', email: `dono-${suffix}@test.local`, passwordHash, role: UserRole.ADMIN, mfaEnabled: true } });
  const master = await prisma.user.create({ data: { name: 'Master', email: `master-${suffix}@test.local`, passwordHash, role: UserRole.MASTER_ADMIN } });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.user.deleteMany({ where: { id: { in: [staff.id, master.id] } } });
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
    await prisma.$disconnect();
  });

  const staffLogin = await call('POST', '/auth/login', undefined, { identifier: staff.email, password });
  assert.equal(staffLogin.status, 200);
  assert.equal(typeof staffLogin.body.accessToken, 'string');
  for (const key of ['mfaRequired', 'mfaSetupRequired', 'mfaChallenge', 'mfaSetupToken']) assert.equal(key in staffLogin.body, false, key);
  assert.equal((await call('GET', '/auth/me', staffLogin.body.accessToken)).status, 200, 'restaurant sessions work without MFA verification');

  const masterLogin = await call('POST', '/auth/login', undefined, { identifier: master.email, password });
  assert.equal(masterLogin.status, 200);
  assert.equal('accessToken' in masterLogin.body, false);
  assert.equal(masterLogin.body.mfaSetupRequired, true);
});
