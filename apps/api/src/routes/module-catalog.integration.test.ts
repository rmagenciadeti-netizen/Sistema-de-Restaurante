import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { MODULE_CATALOG } from '../lib/licensing';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('module catalog loads itself from the code and releases modules per company without manual keys', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'c'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  };
  const id = randomBytes(4).toString('hex');
  const master = await prisma.user.create({ data: { name: 'Master', email: `master-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const tenant = await prisma.tenant.create({ data: { name: `Cat ${id}`, slug: `cat-${id}`, status: 'ACTIVE' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Admin', email: `adm-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const adminToken = signAccessToken({ userId: admin.id, tenantId: tenant.id, unitId: null, role: UserRole.ADMIN });
  const original = await prisma.saaSModule.findUnique({ where: { key: 'pos' } });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (original) await prisma.saaSModule.update({ where: { key: 'pos' }, data: { name: original.name, monthlyPrice: original.monthlyPrice } });
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });

  // Simulates a database that lacks a module the code already enforces, and one whose commercial data was edited in the admin panel.
  await prisma.saaSModule.deleteMany({ where: { key: 'network' } });
  await prisma.saaSModule.update({ where: { key: 'pos' }, data: { name: 'PDV personalizado', monthlyPrice: 99 } });

  await t.test('every module the system enforces appears, once, without anyone typing keys; edited data is kept', async () => {
    const view = await call('GET', `/tenants/${tenant.id}/modules`, masterToken);
    assert.equal(view.status, 200, JSON.stringify(view.body));
    assert.deepEqual(view.body.modules.map((item: any) => item.key).sort(), MODULE_CATALOG.map(item => item.key).sort());
    assert.equal(await prisma.saaSModule.count({ where: { key: 'network' } }), 1);
    const network = view.body.modules.find((item: any) => item.key === 'network');
    assert.deepEqual([network.category, network.apiRoutes], ['Gestão', ['/network']]);
    const pos = await prisma.saaSModule.findUniqueOrThrow({ where: { key: 'pos' } });
    assert.deepEqual([pos.name, Number(pos.monthlyPrice)], ['PDV personalizado', 99]);
    const catalog = await call('GET', '/commercial/modules', masterToken);
    assert.equal(catalog.body.items.filter((item: any) => item.key === 'network').length, 1, 'no duplicates in the commercial catalog');
  });

  await t.test('ticking releases the module in the database and the company gets access; unticking takes it away', async () => {
    assert.equal((await call('PUT', `/tenants/${tenant.id}/modules`, masterToken, { modules: ['pos', 'financial'] })).status, 200);
    assert.equal((await call('GET', '/network/comparison', adminToken)).status, 403, 'not released yet');
    assert.deepEqual((await prisma.tenantModule.findMany({ where: { tenantId: tenant.id } })).map(row => row.moduleKey).sort(), ['financial', 'pos']);
    assert.equal((await call('PUT', `/tenants/${tenant.id}/modules`, masterToken, { modules: ['pos', 'financial', 'network'] })).status, 200);
    assert.equal((await call('GET', '/network/comparison', adminToken)).status, 200, 'released');
    const reloaded = await call('GET', `/tenants/${tenant.id}/modules`, masterToken);
    assert.deepEqual(reloaded.body.modules.filter((item: any) => item.enabled).map((item: any) => item.key).sort(), ['financial', 'network', 'pos']);
    assert.equal((await call('PUT', `/tenants/${tenant.id}/modules`, masterToken, { modules: ['pos', 'financial'] })).status, 200);
    assert.equal((await call('GET', '/network/comparison', adminToken)).status, 403, 'removed again');
  });

  await t.test('unknown keys are refused and companies cannot edit their own modules', async () => {
    assert.equal((await call('PUT', `/tenants/${tenant.id}/modules`, masterToken, { modules: ['pos', 'inventado'] })).status, 400);
    assert.notEqual((await call('PUT', `/tenants/${tenant.id}/modules`, adminToken, { modules: MODULE_CATALOG.map(item => item.key) })).status, 200);
  });
});
