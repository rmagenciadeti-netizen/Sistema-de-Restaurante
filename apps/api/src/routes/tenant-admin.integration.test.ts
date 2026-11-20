import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('SaaS admin: simple module release per company (enforced by the backend) and full company editing', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'm'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    return { status: response.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() as any };
  };
  const id = randomBytes(4).toString('hex');
  const master = await prisma.user.create({ data: { name: 'Master', email: `master-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const A = await prisma.tenant.create({ data: { name: `Empresa A ${id}`, slug: `emp-a-${id}`, status: 'ACTIVE' } });
  const B = await prisma.tenant.create({ data: { name: `Empresa B ${id}`, slug: `emp-b-${id}`, status: 'ACTIVE' } });
  const adminA = await prisma.user.create({ data: { tenantId: A.id, name: 'Admin A', email: `a-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const adminB = await prisma.user.create({ data: { tenantId: B.id, name: 'Admin B', email: `b-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const tokenA = signAccessToken({ userId: adminA.id, tenantId: A.id, unitId: null, role: UserRole.ADMIN });
  const tokenB = signAccessToken({ userId: adminB.id, tenantId: B.id, unitId: null, role: UserRole.ADMIN });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: [A.id, B.id] } } });
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });

  await t.test('the module screen is master-only and lists every catalogued module with its linked routes', async () => {
    assert.equal((await call('GET', `/tenants/${A.id}/modules`, tokenA)).status, 403);
    assert.equal((await call('PUT', `/tenants/${A.id}/modules`, tokenA, { modules: ['pos'] })).status, 403);
    const view = await call('GET', `/tenants/${A.id}/modules`, masterToken);
    assert.equal(view.status, 200, view.text);
    assert.equal(view.body.restricted, false);
    assert.ok(view.body.modules.length >= 10 && view.body.modules.every((item: any) => item.enabled), 'unlicensed companies keep everything open');
    const delivery = view.body.modules.find((item: any) => item.key === 'delivery');
    assert.ok(delivery.apiRoutes.includes('/delivery') && delivery.apiRoutes.includes('/couriers'), 'API routes are linked automatically');
  });

  await t.test('ticking modules and saving enforces the release on the backend, per company', async () => {
    assert.equal((await call('GET', '/couriers', tokenA)).status, 200, 'unlicensed: open');
    const saved = await call('PUT', `/tenants/${A.id}/modules`, masterToken, { modules: ['pos'] });
    assert.equal(saved.status, 200, saved.text);
    const view = (await call('GET', `/tenants/${A.id}/modules`, masterToken)).body;
    assert.equal(view.restricted, true); assert.equal(view.license.status, 'ACTIVE');
    assert.deepEqual(view.modules.filter((item: any) => item.enabled).map((item: any) => item.key), ['pos']);
    assert.equal((await call('GET', '/couriers', tokenA)).status, 403, 'delivery not released');
    assert.equal((await call('GET', '/couriers', tokenB)).status, 200, 'the other company is untouched');
    assert.equal((await call('PUT', `/tenants/${A.id}/modules`, masterToken, { modules: ['pos', 'delivery'] })).status, 200);
    assert.equal((await call('GET', '/couriers', tokenA)).status, 200, 'released immediately');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'TENANT_MODULES_UPDATED', tenantId: A.id }, orderBy: { createdAt: 'desc' } });
    assert.deepEqual([(audit.metadata as any).added, (audit.metadata as any).removed], [['delivery'], []]);
  });

  await t.test('saving modules keeps the license (status, plan, price) and respects it', async () => {
    await prisma.tenantLicense.update({ where: { tenantId: A.id }, data: { status: 'SUSPENDED', contractedPrice: 199.9, maxUsers: 7 } });
    assert.equal((await call('PUT', `/tenants/${A.id}/modules`, masterToken, { modules: ['pos', 'delivery', 'reports'] })).status, 200);
    const license = await prisma.tenantLicense.findUniqueOrThrow({ where: { tenantId: A.id } });
    assert.deepEqual([license.status, Number(license.contractedPrice), license.maxUsers], ['SUSPENDED', 199.9, 7]);
    assert.equal((await call('GET', '/couriers', tokenA)).status, 403, 'a suspended license blocks the modules even when ticked');
  });

  await t.test('a blocked customer (pending or expired license) is diagnosed and fixed for real from the module screen', async () => {
    const C = await prisma.tenant.create({ data: { name: `Cliente C ${id}`, slug: `cli-c-${id}`, status: 'ACTIVE' } });
    const adminC = await prisma.user.create({ data: { tenantId: C.id, name: 'Admin C', email: `c-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
    const tokenC = signAccessToken({ userId: adminC.id, tenantId: C.id, unitId: null, role: UserRole.ADMIN });
    try {
      await prisma.tenantLicense.create({ data: { tenantId: C.id, status: 'PENDING' } });
      await prisma.tenantModule.createMany({ data: [{ tenantId: C.id, moduleKey: 'pos', source: 'PLAN' }, { tenantId: C.id, moduleKey: 'delivery', source: 'PLAN' }] });
      assert.equal((await call('GET', '/orders', tokenC)).status, 403, 'pending license blocks the restaurant');
      const diagnostics = await call('GET', '/tenants/license-diagnostics', masterToken);
      const row = diagnostics.body.items.find((item: any) => item.id === C.id);
      assert.deepEqual([row.access, row.licenseStatus, row.modules], ['BLOCKED', 'PENDING', 2]);
      assert.ok(row.reasons.some((reason: string) => reason.includes('PENDING')));
      assert.ok(diagnostics.body.summary.blocked >= 1);
      assert.equal((await call('GET', '/tenants/license-diagnostics', tokenC)).status, 403, 'master only');

      assert.equal((await call('PUT', `/tenants/${C.id}/modules`, masterToken, { modules: ['pos', 'delivery'], status: 'ACTIVE', validUntil: '2020-01-01T00:00:00.000Z' })).status, 200);
      assert.equal((await call('GET', '/orders', tokenC)).status, 403, 'expired license blocks');
      assert.equal((await call('GET', '/tenants/license-diagnostics', masterToken)).body.items.find((item: any) => item.id === C.id).reasons[0].includes('vencida'), true);

      assert.equal((await call('PUT', `/tenants/${C.id}/modules`, masterToken, { modules: ['pos', 'delivery'], validUntil: null })).status, 200);
      assert.equal((await call('GET', '/orders', tokenC)).status, 200, 'released: persisted in the database, effective immediately');
      assert.equal((await call('GET', '/couriers', tokenC)).status, 200);
      const stored = await prisma.tenantLicense.findUniqueOrThrow({ where: { tenantId: C.id } });
      assert.deepEqual([stored.status, stored.validUntil], ['ACTIVE', null]);
      assert.equal((await call('GET', '/tenants/license-diagnostics', masterToken)).body.items.find((item: any) => item.id === C.id).access, 'OK');
    } finally { await prisma.tenant.delete({ where: { id: C.id } }); }
  });

  await t.test('unknown modules and broken dependencies are rejected without changing anything', async () => {
    assert.equal((await call('PUT', `/tenants/${B.id}/modules`, masterToken, { modules: ['nao-existe'] })).status, 400);
    const withDependency = (await call('GET', `/tenants/${B.id}/modules`, masterToken)).body.modules.find((item: any) => item.dependsOn.length > 0);
    if (withDependency) assert.equal((await call('PUT', `/tenants/${B.id}/modules`, masterToken, { modules: [withDependency.key] })).status, 400, 'dependency missing');
    assert.equal(await prisma.tenantLicense.count({ where: { tenantId: B.id } }), 0, 'no license was created by a rejected save');
    assert.equal((await call('PUT', `/tenants/${randomBytes(4).toString('hex')}-0000-4000-8000-000000000000`, masterToken, { modules: ['pos'] })).status, 404);
  });

  await t.test('editing a company: validation, persistence, list refresh, uniqueness, audit and permissions', async () => {
    assert.equal((await call('PATCH', `/tenants/${A.id}`, tokenA, { name: 'Hack' })).status, 403, 'restaurant users cannot edit companies');
    assert.equal((await call('PATCH', `/tenants/${A.id}`, masterToken, { company: { document: '11.222.333/0001-82' } })).status, 400, 'invalid CNPJ');
    assert.equal((await call('PATCH', `/tenants/${A.id}`, masterToken, { company: { email: 'sem-arroba' } })).status, 400, 'invalid e-mail');
    assert.equal((await call('PATCH', `/tenants/${A.id}`, masterToken, { name: ' ' })).status, 400, 'required name');
    const ok = await call('PATCH', `/tenants/${A.id}`, masterToken, { name: `Empresa A Editada ${id}`, company: { legalName: 'A Comércio de Alimentos LTDA', tradeName: 'Bistrô A', document: '11222333000181', email: 'Contato@A.test', phone: '(11) 98888-7777', responsibleName: 'Maria', state: 'sp', city: 'São Paulo', zip: '01001-000' } });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.body.company.document, ok.body.company.email, ok.body.company.state], ['11.222.333/0001-81', 'contato@a.test', 'SP']);
    const detail = await call('GET', `/tenants/${A.id}`, masterToken);
    assert.equal(detail.body.tenant.name, `Empresa A Editada ${id}`); assert.equal(detail.body.company.tradeName, 'Bistrô A');
    const listed = (await call('GET', '/tenants', masterToken)).body.items.find((item: any) => item.id === A.id);
    assert.deepEqual([listed.name, listed.company.document, listed.company.responsibleName], [`Empresa A Editada ${id}`, '11.222.333/0001-81', 'Maria']);
    assert.equal((await call('PATCH', `/tenants/${B.id}`, masterToken, { company: { document: '11.222.333/0001-81' } })).status, 409, 'CNPJ already used by another company');
    assert.equal((await call('PATCH', `/tenants/${B.id}`, masterToken, { slug: `emp-a-${id}` })).status, 409, 'slug already used');
    assert.equal((await call('GET', `/tenants/${B.id}`, masterToken)).body.company.document, '', 'the other company was not changed');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'TENANT_UPDATED', tenantId: A.id } });
    assert.ok((audit.metadata as any).changed['company.document'] && (audit.metadata as any).changed.name, 'before/after recorded');
    assert.equal(audit.actorUserId, master.id);
    const noop = await call('PATCH', `/tenants/${A.id}`, masterToken, { company: { tradeName: 'Bistrô A' } });
    assert.deepEqual([noop.status, noop.body.changedFields], [200, []]);
    assert.equal((await call('GET', '/tenants/provisioning', masterToken)).status, 200, 'fixed-path routes are not captured by :id');
  });
});
