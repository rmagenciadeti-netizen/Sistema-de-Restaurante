import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

type Report = { kind: string; columns: { key: string; label: string; type: string }[]; rows: Record<string, any>[]; totals?: Record<string, any> };

test('tabular reports and virtual store', { skip: process.env.RUN_DB_TESTS !== '1' }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null) as T };
  }
  const suffix = randomBytes(5).toString('hex');
  const tenants: string[] = [];
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });
  async function setup(label: string, settings: object = {}, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const tenant = await prisma.tenant.create({ data: { name: `Loja ${label}`, slug: `rep-${label}-${suffix}`, status } });
    tenants.push(tenant.id);
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    await prisma.tenantSettings.create({ data: { tenantId: tenant.id, settings } });
    const admin = await prisma.user.create({ data: { tenantId: tenant.id, unitId: unit.id, name: 'Admin', email: `admin-${label}-${suffix}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
    const waiter = await prisma.user.create({ data: { tenantId: tenant.id, unitId: unit.id, name: 'Garçom', email: `waiter-${label}-${suffix}@test.local`, passwordHash: 'x', role: UserRole.WAITER } });
    const token = (userId: string, role: UserRole) => signAccessToken({ userId, tenantId: tenant.id, unitId: unit.id, role });
    return { tenant, unit, admin: token(admin.id, UserRole.ADMIN), waiter: token(waiter.id, UserRole.WAITER) };
  }
  const A = await setup('a', { scheduling: { enabled: true, maxDaysAhead: 7, leadTime: '00:30' }, store: { allowBuyWhenClosed: false } });
  const B = await setup('b', { hours: { mode: 'CLOSED' } });
  const C = await setup('c', {}, 'SUSPENDED');

  const product = (tenantId: string, unitId: string, name: string, price: number, cost?: number) => prisma.product.create({ data: { tenantId, unitId, name, price, cost } });
  const [p1, p2, p3] = await Promise.all([product(A.tenant.id, A.unit.id, 'Picanha', 100, 40), product(A.tenant.id, A.unit.id, 'Salada', 30, 10), product(A.tenant.id, A.unit.id, 'Suco', 50, 20)]);
  const bProduct = await product(B.tenant.id, B.unit.id, 'Prato B', 20);
  const sale = (code: string, productId: string, quantity: number, unitPrice: number, extra: { discount?: number; serviceFee?: number } = {}) => {
    const subtotal = quantity * unitPrice;
    return prisma.order.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, code, status: 'COMPLETED', subtotal, discount: extra.discount ?? 0, serviceFee: extra.serviceFee ?? 0, total: subtotal - (extra.discount ?? 0) + (extra.serviceFee ?? 0), items: { create: { productId, quantity, unitPrice, total: subtotal } } } });
  };
  await sale(`R1-${suffix}`, p1.id, 8, 100);
  await sale(`R2-${suffix}`, p2.id, 5, 30);
  await sale(`R3-${suffix}`, p3.id, 1, 50, { discount: 5, serviceFee: 5 });
  await prisma.order.create({ data: { tenantId: B.tenant.id, unitId: B.unit.id, code: `RB-${suffix}`, subtotal: 999, total: 999, items: { create: { productId: bProduct.id, quantity: 1, unitPrice: 999, total: 999 } } } });
  await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, description: 'Aluguel', type: 'EXPENSE', amount: 100, status: 'PAID', settledAt: new Date() } });
  const range = `from=${encodeURIComponent(new Date(Date.now() - 3600_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 24 * 3600_000).toISOString())}`;

  await t.test('lists kinds and restricts reports to finance roles', async () => {
    const list = await call<{ items: { kind: string }[] }>('GET', '/reports/x', A.admin);
    assert.equal(list.status, 200);
    assert.ok(list.body.items.length >= 18);
    for (const { kind } of list.body.items) {
      const report = await call<Report>('GET', `/reports/x/${kind}?${range}`, A.admin);
      assert.equal(report.status, 200, kind);
      assert.equal(report.body.kind, kind);
      assert.ok(report.body.columns.length > 0);
      assert.equal((await fetch(`${base}/reports/x/${kind}?${range}&format=csv`, { headers: { authorization: `Bearer ${A.admin}` } })).status, 200, kind);
    }
    assert.equal((await call('GET', `/reports/x/dre?${range}`, A.waiter)).status, 403);
    assert.equal((await call('GET', `/reports/x/unknown?${range}`, A.admin)).status, 404);
    assert.equal((await call('GET', '/reports/x/dre?from=nope', A.admin)).status, 400);
  });

  await t.test('ABC classification, DRE and tenant isolation', async () => {
    const abc = await call<Report>('GET', `/reports/x/product-classification?${range}`, A.admin);
    assert.equal(abc.status, 200);
    assert.deepEqual(abc.body.rows.map(row => [row.product, row.abc]), [['Picanha', 'A'], ['Salada', 'B'], ['Suco', 'C']]);
    assert.equal(abc.body.rows[0].revenue, '800.00');
    assert.equal(abc.body.totals?.revenue, '1000.00');
    const dre = await call<Report>('GET', `/reports/x/dre?${range}`, A.admin);
    const amount = (label: string) => dre.body.rows.find(row => row.line.includes(label))?.amount;
    assert.equal(amount('Receita bruta'), '1000.00');
    assert.equal(amount('Custo estimado'), '-390.00');
    assert.equal(amount('Lucro bruto'), '610.00');
    assert.equal(amount('Resultado'), '510.00');
    const otherTenant = await call<Report>('GET', `/reports/x/product-classification?${range}`, B.admin);
    assert.deepEqual(otherTenant.body.rows.map(row => row.product), ['Prato B']);
    const csv = await fetch(`${base}/reports/x/sales?${range}&format=csv`, { headers: { authorization: `Bearer ${A.admin}` } });
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    const bytes = Buffer.from(await csv.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const csvText = bytes.toString('utf8');
    assert.ok(csvText.includes('Nº;Código'));
    assert.ok(!csvText.includes('999'));
  });

  await t.test('cancellation report names the user and the reason', async () => {
    const cancelled = await prisma.order.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, code: `RC-${suffix}`, status: 'CANCELLED', subtotal: 40, total: 40 } });
    const admin = await prisma.user.findFirstOrThrow({ where: { tenantId: A.tenant.id, role: 'ADMIN' } });
    await prisma.auditLog.create({ data: { tenantId: A.tenant.id, actorUserId: admin.id, action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityId: cancelled.id, metadata: { status: 'CANCELLED' } } });
    await prisma.passwordRelease.create({ data: { tenantId: A.tenant.id, action: 'CANCEL_ORDER', orderId: cancelled.id, requestedByUserId: admin.id, reason: 'Cliente desistiu' } });
    const report = await call<Report>('GET', `/reports/x/cancellations?${range}`, A.admin);
    assert.equal(report.status, 200);
    assert.equal(report.body.rows.length, 1);
    assert.equal(report.body.rows[0].user, 'Admin');
    assert.equal(report.body.rows[0].reason, 'Cliente desistiu');
    assert.equal(report.body.totals?.total, '40.00');
  });

  await t.test('public store exposes the menu with promotions and hides unavailable tenants', async () => {
    const promotion = await prisma.promotion.create({ data: { tenantId: A.tenant.id, name: 'Salada em dobro', type: 'PERCENT', value: 10, startsAt: new Date(Date.now() - 60_000), products: { create: { productId: p2.id } } } });
    const store = await call<any>('GET', `/public/store/${A.tenant.slug}`);
    assert.equal(store.status, 200);
    assert.equal(store.body.restaurant.name, 'Loja a');
    assert.equal(store.body.open, true);
    assert.equal(store.body.scheduling.enabled, true);
    const products = store.body.categories.flatMap((category: any) => category.products);
    assert.equal(products.length, 3);
    assert.equal(products.find((item: any) => item.id === p2.id).promoPrice, '27');
    assert.equal(products.some((item: any) => item.id === bProduct.id), false);
    assert.equal((await call('GET', `/public/store/${C.tenant.slug}`)).status, 404);
    assert.equal((await call('GET', '/public/store/nao-existe')).status, 404);
    await prisma.promotion.delete({ where: { id: promotion.id } });
  });

  await t.test('public store creates scheduled orders and rejects orders while closed', async () => {
    const customer = { name: 'Maria', phone: '11988887777' };
    const items = [{ productId: p1.id, quantity: 1 }];
    const when = new Date(Date.now() + 2 * 24 * 3600_000);
    const scheduled = await call<any>('POST', `/public/store/${A.tenant.slug}/orders`, undefined, { fulfillment: 'TAKEAWAY', customer, items, scheduledFor: when.toISOString() });
    assert.equal(scheduled.status, 201);
    assert.equal(scheduled.body.total, '100');
    assert.equal(new Date(scheduled.body.scheduledFor).getTime(), when.getTime());
    const order = await prisma.order.findFirstOrThrow({ where: { tenantId: A.tenant.id, code: scheduled.body.code } });
    assert.equal(order.channel, 'TAKEAWAY');
    assert.equal(order.releasedAt, null);
    assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0);
    const report = await call<Report>('GET', `/reports/x/scheduled-sales?${range}`, A.admin);
    assert.deepEqual(report.body.rows.map(row => row.status), ['Aguardando liberação']);
    const tooSoon = await call('POST', `/public/store/${A.tenant.slug}/orders`, undefined, { fulfillment: 'TAKEAWAY', customer, items, scheduledFor: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(tooSoon.status, 400);
    const closed = await call<any>('POST', `/public/store/${B.tenant.slug}/orders`, undefined, { fulfillment: 'TAKEAWAY', customer, items: [{ productId: bProduct.id, quantity: 1 }] });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.message, 'STORE_CLOSED');
    const foreign = await call('POST', `/public/store/${B.tenant.slug}/orders`, undefined, { fulfillment: 'TAKEAWAY', customer, items, scheduledFor: when.toISOString() });
    assert.notEqual(foreign.status, 201);
  });
});
