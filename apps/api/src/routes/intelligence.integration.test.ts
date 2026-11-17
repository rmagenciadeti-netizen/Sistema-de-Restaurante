import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1).
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

async function createTenant(label: string) {
  const id = suffix();
  const tenant = await prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Dona Maria', email: `admin-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const waiter = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Garçom', email: `waiter-${id}@test.local`, passwordHash: 'x', role: UserRole.WAITER } });
  const token = (user: { id: string }, role: UserRole) => signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
  return { tenant, admin, adminToken: token(admin, UserRole.ADMIN), waiterToken: token(waiter, UserRole.WAITER) };
}

test('RM Inteligência answers from real data, respects permissions, licensing and tenant isolation', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'c'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const A = await createTenant('intel-a');
  const B = await createTenant('intel-b');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  const burger = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Hambúrguer', price: 40, cost: 10 } });
  const soda = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Refrigerante', price: 8, cost: 6 } });
  await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Sobremesa parada', price: 15 } });
  await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Queijo', unitOfMeasure: 'kg', currentStock: 1, minimumStock: 5 } });
  await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, description: 'Aluguel', type: 'EXPENSE', category: 'Aluguel', amount: 500, dueAt: new Date(Date.now() - 86_400_000) } });
  for (let index = 0; index < 3; index += 1) {
    await prisma.order.create({ data: { tenantId: A.tenant.id, code: `T${suffix()}`, channel: 'POS', status: 'COMPLETED', subtotal: 48, total: 48, createdByUserId: A.admin.id, items: { create: [{ productId: burger.id, quantity: 1, unitPrice: 40, total: 40 }, { productId: soda.id, quantity: 1, unitPrice: 8, total: 8 }] } } });
  }
  await prisma.order.create({ data: { tenantId: B.tenant.id, code: `T${suffix()}`, channel: 'POS', status: 'COMPLETED', subtotal: 999, total: 999 } });

  await t.test('summary and assistant use only the tenant\'s real data', async () => {
    const summary = await call('GET', '/intelligence/summary', A.adminToken);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.sales.today, 144);
    assert.equal(summary.body.sales.ordersToday, 3);
    assert.equal(summary.body.forecast, null, 'not enough history: no invented forecast');
    assert.match(summary.body.forecastNote, /insuficiente/);
    assert.equal(summary.body.topProducts[0].name, 'Hambúrguer');
    assert.equal(summary.body.topMargins[0].name, 'Hambúrguer');
    assert.equal(summary.body.month.grossProfit, 3 * (30 + 2));
    assert.ok(summary.body.alerts.some((alert: { key: string }) => alert.key === 'low-stock'));
    assert.ok(summary.body.alerts.some((alert: { key: string }) => alert.key === 'payables'));
    assert.equal(summary.body.topEmployees[0].name, 'Dona Maria');

    const today = await call('POST', '/intelligence/ask', A.adminToken, { question: 'Quanto vendi hoje?' });
    assert.match(today.body.answer, /R\$ 144,00/);
    const goal = await call('POST', '/intelligence/ask', A.adminToken, { question: 'Quanto preciso vender para alcançar minha meta de 1000?' });
    assert.match(goal.body.answer, /faltam R\$ 856,00/);
    const profit = await call('POST', '/intelligence/ask', A.adminToken, { question: 'Quanto lucrei neste mês?' });
    assert.ok(profit.body.limitations.length > 0, 'profit answer states its limits');
    const unknown = await call('POST', '/intelligence/ask', A.adminToken, { question: 'qual a capital da França?' });
    assert.equal(unknown.body.intent, 'UNKNOWN');
    assert.equal((await call('POST', '/intelligence/ask', A.adminToken, { question: 'x' })).status, 400);
  });

  await t.test('tenant isolation and role permissions', async () => {
    const other = await call('GET', '/intelligence/summary', B.adminToken);
    assert.equal(other.body.sales.today, 999);
    assert.equal(other.body.topProducts.length, 0);
    assert.equal((await call('GET', '/intelligence/summary', A.waiterToken)).status, 403);
  });

  await t.test('alert preferences are configurable and the module is licensed', async () => {
    const saved = await call('PUT', '/settings/intelligence', A.adminToken, { monthlyGoal: 2000, alerts: { salesDrop: true, lowStock: false, payables: false, receivables: true, lowMargin: true, delayedOrders: true, cashDivergence: true, waste: true }, salesDropPercent: 30, payableDays: 3, delayedMinutes: 30, marginFloorPercent: 15 });
    assert.equal(saved.status, 200);
    const summary = await call('GET', '/intelligence/summary', A.adminToken);
    assert.ok(!summary.body.alerts.some((alert: { key: string }) => alert.key === 'low-stock' || alert.key === 'payables'));
    assert.equal(summary.body.goal.missing, 1856);

    await prisma.tenantLicense.create({ data: { tenantId: A.tenant.id, status: 'ACTIVE' } });
    await prisma.tenantModule.create({ data: { tenantId: A.tenant.id, moduleKey: 'reports' } });
    assert.equal((await call('GET', '/intelligence/summary', A.adminToken)).status, 403, 'module not contracted');
    await prisma.tenantModule.create({ data: { tenantId: A.tenant.id, moduleKey: 'intelligence' } });
    assert.equal((await call('GET', '/intelligence/summary', A.adminToken)).status, 200);
  });
});
