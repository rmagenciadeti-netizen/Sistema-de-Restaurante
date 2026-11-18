import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

const enabled = process.env.RUN_DB_TESTS === '1';

test('appearance: restaurant default, personal override, priority and tenant isolation', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const id = randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Look ${id}`, slug: `look-${id}`, status: 'ACTIVE' } });
  const other = await prisma.tenant.create({ data: { name: `Look2 ${id}`, slug: `look2-${id}`, status: 'ACTIVE' } });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
    await prisma.$disconnect();
  });
  const mk = async (tenantId: string, role: UserRole, name: string) => {
    const user = await prisma.user.create({ data: { tenantId, name, email: `${name}-${id}@test.local`, passwordHash: 'x', role } });
    return signAccessToken({ userId: user.id, tenantId, unitId: null, role });
  };
  const admin = await mk(tenant.id, UserRole.ADMIN, 'admin');
  const waiter = await mk(tenant.id, UserRole.WAITER, 'waiter');
  const otherAdmin = await mk(other.id, UserRole.ADMIN, 'other');
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  await t.test('defaults to the RM identity', async () => {
    const result = await call('GET', '/appearance', waiter);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.effective, { source: 'TENANT', value: { mode: 'DARK', primary: 'GOLD', sidebar: 'BLACK' } });
  });

  await t.test('only management saves the restaurant theme, with validation, and it is isolated per tenant', async () => {
    const theme = { mode: 'LIGHT', primary: 'BLUE', sidebar: 'NAVY', allowUserOverride: true };
    assert.equal((await call('PUT', '/settings/appearance', waiter, theme)).status, 403);
    assert.equal((await call('PUT', '/settings/appearance', admin, { ...theme, primary: 'PINK' })).status, 400);
    assert.equal((await call('PUT', '/settings/appearance', admin, theme)).status, 200);
    assert.equal((await call('GET', '/appearance', waiter)).body.effective.value.primary, 'BLUE');
    assert.equal((await call('GET', '/appearance', otherAdmin)).body.effective.value.primary, 'GOLD');
  });

  await t.test('personal preference wins, can be reset and is blocked when the restaurant disables it', async () => {
    const mine = { mode: 'DARK', primary: 'GREEN', sidebar: 'WHITE' };
    assert.equal((await call('PUT', '/appearance/me', waiter, { ...mine, mode: 'NEON' })).status, 400);
    const saved = await call('PUT', '/appearance/me', waiter, mine);
    assert.deepEqual(saved.body.effective, { source: 'USER', value: mine });
    assert.equal((await call('GET', '/appearance', admin)).body.effective.source, 'TENANT');
    await call('PUT', '/settings/appearance', admin, { mode: 'LIGHT', primary: 'BLUE', sidebar: 'NAVY', allowUserOverride: false });
    assert.equal((await call('GET', '/appearance', waiter)).body.effective.source, 'TENANT');
    assert.equal((await call('PUT', '/appearance/me', waiter, mine)).status, 403);
    await call('PUT', '/settings/appearance', admin, { mode: 'LIGHT', primary: 'BLUE', sidebar: 'NAVY', allowUserOverride: true });
    const reset = await call('DELETE', '/appearance/me', waiter);
    assert.equal(reset.body.user, null);
    assert.equal(reset.body.effective.source, 'TENANT');
  });
});
