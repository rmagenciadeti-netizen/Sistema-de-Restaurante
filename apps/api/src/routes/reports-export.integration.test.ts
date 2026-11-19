import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('commercial reports and Excel/PDF exports', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'g'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const raw = (method: string, path: string, token: string, body?: unknown) => fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const call = async (method: string, path: string, token: string, body?: unknown) => { const response = await raw(method, path, token, body); return { status: response.status, body: (await response.json().catch(() => null)) as any }; };

  const id = randomBytes(4).toString('hex');
  const master = await prisma.user.create({ data: { name: 'Master', email: `master-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const tenant = await prisma.tenant.create({ data: { name: `Rel ${id}`, slug: `rel-${id}`, status: 'ACTIVE' } });
  // The restaurant users live in a tenant without a licence row (unrestricted), so only report permissions are exercised.
  const restaurant = await prisma.tenant.create({ data: { name: `Rest ${id}`, slug: `rest-${id}`, status: 'ACTIVE' } });
  const admin = await prisma.user.create({ data: { tenantId: restaurant.id, name: 'Admin', email: `admin-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const waiter = await prisma.user.create({ data: { tenantId: restaurant.id, name: 'Garçom', email: `waiter-${id}@test.local`, passwordHash: 'x', role: UserRole.WAITER } });
  const adminToken = signAccessToken({ userId: admin.id, tenantId: restaurant.id, unitId: null, role: UserRole.ADMIN });
  const waiterToken = signAccessToken({ userId: waiter.id, tenantId: restaurant.id, unitId: null, role: UserRole.WAITER });
  const plan = await prisma.saaSPlan.create({ data: { key: `rel-${id}`, name: `Plano Rel ${id}`, status: 'ACTIVE' } });
  await prisma.tenantLicense.create({ data: { tenantId: tenant.id, status: 'ACTIVE', planId: plan.id, billingPeriod: 'MONTHLY', contractedPrice: 200, discountPercent: 10 } });
  const now = new Date();
  await prisma.saaSInvoice.create({ data: { tenantId: tenant.id, planId: plan.id, reference: `P-${id}`, status: 'PAID', paidAt: now, subtotal: 230, discount: 23, total: 207, dueDate: now, items: [{ type: 'PLAN', label: 'Plano', amount: 200 }, { type: 'MODULE', key: 'delivery', label: 'Módulo Delivery', amount: 30 }] } });
  await prisma.saaSInvoice.create({ data: { tenantId: tenant.id, planId: plan.id, reference: `O-${id}`, status: 'OPEN', subtotal: 200, discount: 0, total: 200, dueDate: new Date(now.getTime() - 10 * 86_400_000), items: [] } });
  await prisma.auditLog.create({ data: { tenantId: tenant.id, actorUserId: master.id, action: 'SUBSCRIPTION_PLAN_CHANGED', entityType: 'TenantLicense', metadata: { direction: 'UPGRADE', from: { name: 'Antigo', price: '100' }, to: { name: 'Novo', price: '200' }, reason: 'teste' } } });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, restaurant.id] } } });
    await prisma.saaSPlan.deleteMany({ where: { id: plan.id } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });

  await t.test('only the master reads commercial reports', async () => {
    assert.equal((await call('GET', '/commercial/reports', adminToken)).status, 403);
    assert.equal((await call('GET', '/commercial/reports/delinquency', adminToken)).status, 403);
    assert.equal((await call('GET', '/commercial/reports/inexistente', masterToken)).status, 404);
    assert.equal((await call('GET', '/commercial/reports/delinquency?from=2026-12-31&to=2026-01-01', masterToken)).status, 400);
    const list = await call('GET', '/commercial/reports', masterToken);
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 12);
  });

  await t.test('reports are computed from real invoices, licences and audit entries', async () => {
    const byPlan = await call('GET', '/commercial/reports/subscriptions-by-plan', masterToken);
    const row = byPlan.body.rows.find((item: any) => item.plan === `Plano Rel ${id}`);
    assert.deepEqual([row.total, row.active, row.mrr], [1, 1, '180.00'], '200 less 10% negotiated discount');
    const revenue = await call('GET', '/commercial/reports/revenue-by-plan', masterToken);
    const planRevenue = revenue.body.rows.find((item: any) => item.plan === `Plano Rel ${id}`);
    assert.deepEqual([planRevenue.invoices, planRevenue.received, planRevenue.discounts], [1, '207.00', '23.00']);
    const modules = await call('GET', '/commercial/reports/revenue-by-module', masterToken);
    assert.equal(modules.body.rows.find((item: any) => item.module === 'Módulo Delivery').amount, '30.00');
    const delinquency = await call('GET', '/commercial/reports/delinquency', masterToken);
    const late = delinquency.body.rows.find((item: any) => item.reference === `O-${id}`);
    assert.ok(late.days >= 10);
    assert.equal(delinquency.body.rows.some((item: any) => item.reference === `P-${id}`), false, 'paid invoices are not delinquent');
    const changes = await call('GET', '/commercial/reports/plan-changes', masterToken);
    assert.deepEqual(changes.body.rows.filter((item: any) => item.tenant === `Rel ${id}`).map((item: any) => [item.direction, item.from, item.to]), [['Upgrade', 'Antigo', 'Novo']]);
  });

  await t.test('exports come as real Excel, PDF and CSV files', async () => {
    const xlsx = await raw('GET', '/commercial/reports/revenue-by-plan?format=xlsx', masterToken);
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.equal(Buffer.from(await xlsx.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    const pdf = await raw('GET', '/commercial/reports/delinquency?format=pdf', masterToken);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const csv = await raw('GET', '/commercial/reports/revenue-by-plan?format=csv', masterToken);
    assert.match(await csv.text(), /Recebido/);
  });

  await t.test('restaurant reports export in the same formats, with the same permissions', async () => {
    assert.equal((await raw('GET', '/reports/x/sales?format=xlsx', waiterToken)).status, 403, 'only financial profiles export reports');
    const xlsx = await raw('GET', '/reports/x/sales?format=xlsx', adminToken);
    assert.equal(xlsx.status, 200);
    assert.equal(Buffer.from(await xlsx.arrayBuffer()).readUInt32LE(0), 0x04034b50);
    const pdf = await raw('GET', '/reports/x/sales?format=pdf', adminToken);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    const table = { format: 'pdf', title: 'Distribuição', period: { from: '2026-06-01T00:00:00', to: '2026-06-30T23:59:59' }, columns: [{ key: 'name', label: 'Nome', type: 'text' }, { key: 'total', label: 'Total', type: 'money' }], rows: [{ name: 'Ana', total: 10.5 }] };
    assert.equal((await raw('POST', '/reports/render', waiterToken, table)).status, 403);
    const rendered = await raw('POST', '/reports/render', adminToken, table);
    assert.equal(rendered.status, 200);
    assert.equal(Buffer.from(await rendered.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
    assert.equal((await raw('POST', '/reports/render', adminToken, { ...table, format: 'exe' })).status, 400);
    assert.equal((await raw('POST', '/reports/render', adminToken, { ...table, columns: [] })).status, 400);
  });
});
