import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('automations center: alerts become deduplicated, permission-aware notifications', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'i'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString('base64');
  const { app } = await import('../index');
  const { emailProviders } = await import('../lib/providers');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };
  const id = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE' } });
    const token = async (role: UserRole) => {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: `${role} ${label}`, email: `${role}-${label}-${id}@test.local`, passwordHash: 'x', role } });
      return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    };
    return { tenant, token };
  };
  const A = await makeTenant('auto'); const B = await makeTenant('autoother');
  const admin = await A.token(UserRole.ADMIN); const waiter = await A.token(UserRole.WAITER); const otherAdmin = await B.token(UserRole.ADMIN);
  t.after(async () => {
    emailProviders.clear();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  const day = 86_400_000;
  await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Farinha', unitOfMeasure: 'kg', currentStock: 2, minimumStock: 10 } });
  await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Leite', unitOfMeasure: 'l', currentStock: 5, minimumStock: 1, expiresAt: new Date(Date.now() + day) } });
  await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, description: 'Aluguel', type: 'EXPENSE', amount: 1000, dueAt: new Date(Date.now() - day) } });
  const list = async (token: string, query = '') => (await call('GET', `/notifications${query}`, token)).body;

  await t.test('running the rules creates one notification per situation and never repeats it', async () => {
    const first = await call('POST', '/notifications/run', admin, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const keys = (await list(admin)).items.map((item: any) => item.ruleKey).sort();
    assert.deepEqual(keys, ['expiring', 'lowStock', 'payables']);
    const second = await call('POST', '/notifications/run', admin, {});
    assert.equal(second.body.created, 0, 'same day, same situation: no new notification');
    assert.equal((await list(admin)).items.length, 3);
  });

  await t.test('financial notifications are hidden from non-financial roles and from other restaurants', async () => {
    const waiterView = await list(waiter);
    assert.deepEqual(waiterView.items.map((item: any) => item.ruleKey).sort(), ['expiring', 'lowStock']);
    assert.equal(waiterView.unread, 2);
    assert.deepEqual((await list(otherAdmin)).items, []);
    assert.equal((await call('POST', '/notifications/run', waiter, {})).status, 403);
    const payable = (await list(admin)).items.find((item: any) => item.ruleKey === 'payables');
    assert.equal((await call('POST', `/notifications/${payable.id}/read`, waiter)).status, 404);
    assert.equal((await call('POST', `/notifications/${payable.id}/read`, otherAdmin)).status, 404);
  });

  await t.test('reading marks notifications and unread counter follows', async () => {
    const payable = (await list(admin)).items.find((item: any) => item.ruleKey === 'payables');
    assert.equal((await call('POST', `/notifications/${payable.id}/read`, admin)).status, 204);
    assert.equal((await list(admin)).unread, 2);
    assert.equal((await call('POST', '/notifications/read-all', admin)).body.updated, 2);
    assert.equal((await list(admin, '?unread=1')).items.length, 0);
  });

  await t.test('disabled rules stay silent and the master switch stops everything', async () => {
    await prisma.notification.deleteMany({ where: { tenantId: A.tenant.id } });
    const saved = await call('PUT', '/settings/automations', admin, { rules: { lowStock: false } });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    await call('POST', '/notifications/run', admin, {});
    assert.deepEqual((await list(admin)).items.map((item: any) => item.ruleKey).sort(), ['expiring', 'payables']);
    await prisma.notification.deleteMany({ where: { tenantId: A.tenant.id } });
    await call('PUT', '/settings/automations', admin, { enabled: false });
    assert.equal((await call('POST', '/notifications/run', admin, {})).body.created, 0);
  });

  await t.test('e-mail copies go to the configured recipients only when a provider exists', async () => {
    await prisma.notification.deleteMany({ where: { tenantId: A.tenant.id } });
    const sent: { to: string; subject: string }[] = [];
    emailProviders.register({ name: 'smtp', send: async message => { sent.push({ to: message.to, subject: message.subject }); } });
    const saved = await call('PUT', '/settings/automations', admin, { enabled: true, rules: { lowStock: true }, emailTo: ['dono@restaurante.test'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const run = await call('POST', '/notifications/run', admin, {});
    assert.equal(run.body.created, 3);
    assert.equal(run.body.emailed, 3);
    assert.deepEqual([...new Set(sent.map(item => item.to))], ['dono@restaurante.test']);
    assert.equal(await prisma.notification.count({ where: { tenantId: A.tenant.id, emailedAt: { not: null } } }), 3);
  });
});
