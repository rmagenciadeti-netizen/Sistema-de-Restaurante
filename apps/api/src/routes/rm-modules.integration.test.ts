import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { setAiProvider } from '../lib/ai-provider';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('RM modules: stock intelligence, business diagnosis with AI limits, delivery central', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  process.env.AI_DAILY_LIMIT = '1';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  const suffix = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}`.toLowerCase(), status: 'ACTIVE' } });
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const token = async (role: UserRole) => {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    };
    return { tenant, unit, token };
  };
  const A = await makeTenant('rmmod'); const B = await makeTenant('rmmodother');
  const admin = await A.token(UserRole.ADMIN); const otherAdmin = await B.token(UserRole.ADMIN); const waiter = await A.token(UserRole.WAITER);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    setAiProvider(undefined);
    const ids = [A.tenant.id, B.tenant.id];
    await prisma.deliveryJob.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.order.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.stockMovement.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const flour = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Farinha', unitOfMeasure: 'kg', currentStock: 3, minimumStock: 5, averageCost: 4 } });
  await prisma.stockMovement.create({ data: { tenantId: A.tenant.id, ingredientId: flour.id, type: 'ORDER_CONSUMPTION', quantity: -30 } });
  await prisma.stockMovement.create({ data: { tenantId: A.tenant.id, ingredientId: flour.id, type: 'WASTE', quantity: -2, unitCost: 4 } });
  await prisma.ingredient.create({ data: { tenantId: B.tenant.id, name: 'Segredo', unitOfMeasure: 'kg', currentStock: 1, minimumStock: 9 } });
  const burger = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Burger', price: 30 } });

  await t.test('stock intelligence reports coverage, purchase suggestion and waste from real movements', async () => {
    const { status, body } = await call('GET', '/intelligence/stock', admin);
    assert.equal(status, 200);
    const row = body.items.find((item: any) => item.name === 'Farinha');
    assert.equal(row.critical, true);
    assert.equal(row.consumed30, 30);
    assert.equal(row.coverageDays, 3);
    assert.ok(row.suggestedPurchase >= 11);
    assert.equal(body.wasteCost, 8);
    assert.equal(body.products.withoutRecipe, 1);
    assert.ok(!body.items.some((item: any) => item.name === 'Segredo'));
    assert.equal((await call('GET', '/intelligence/stock', waiter)).status, 403);
  });

  await t.test('business diagnosis works without AI and enforces the daily AI limit', async () => {
    const plain = await call('POST', '/intelligence/business', admin, { useAi: false });
    assert.equal(plain.status, 200);
    assert.ok(plain.body.diagnosis.length > 0);
    assert.equal(plain.body.ai, null);
    setAiProvider(null);
    const noProvider = await call('POST', '/intelligence/business', admin, { useAi: true });
    assert.equal(noProvider.body.ai, null);
    assert.match(noProvider.body.aiNote, /não configurada/);
    let received = '';
    setAiProvider({ name: 'fake', answer: async ({ question }) => { received = question; return 'Resumo gerado.'; } });
    // Without the company's consent nothing is sent to the model.
    const unconsented = await call('POST', '/intelligence/business', admin, { useAi: true });
    assert.equal(unconsented.body.ai, null); assert.match(unconsented.body.aiNote, /consentimento/); assert.equal(received, '');
    for (const token of [admin, otherAdmin]) assert.equal((await call('PUT', '/ai/settings', token, { externalConsent: true })).status, 200);
    const first = await call('POST', '/intelligence/business', admin, { useAi: true });
    assert.equal(first.body.ai.text, 'Resumo gerado.');
    assert.ok(!received.includes('Segredo'));
    const second = await call('POST', '/intelligence/business', admin, { useAi: true });
    assert.equal(second.body.ai, null);
    assert.match(second.body.aiNote, /Limite diário/);
    const other = await call('POST', '/intelligence/business', otherAdmin, { useAi: true });
    assert.equal(other.body.ai.text, 'Resumo gerado.');
  });

  await t.test('delivery central summarizes real deliveries per courier with payment due', async () => {
    const courier = await prisma.courier.create({ data: { tenantId: A.tenant.id, name: 'Zé', paymentPerDelivery: 5 } });
    const order = await prisma.order.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, code: `D1-${suffix}`, channel: 'DELIVERY', status: 'COMPLETED', subtotal: 40, deliveryFee: 8, total: 48 } });
    const sent = new Date(Date.now() - 30 * 60_000);
    await prisma.deliveryJob.create({ data: { tenantId: A.tenant.id, orderId: order.id, courierId: courier.id, courierName: 'Zé', status: 'DELIVERED', dispatchedAt: sent, deliveredAt: new Date(sent.getTime() + 20 * 60_000) } });
    const { status, body } = await call('GET', '/delivery/summary', admin);
    assert.equal(status, 200);
    assert.equal(body.delivered, 1);
    assert.equal(body.averageMinutes, 20);
    assert.equal(body.feesCollected, 8);
    assert.deepEqual(body.byCourier.find((row: any) => row.name === 'Zé').amountDue, 5);
    assert.equal((await call('GET', '/delivery/summary', otherAdmin)).body.total, 0);
    const zone = await call('POST', '/delivery/zones', admin, { name: 'Centro', fee: 6, estimatedMinutes: 35 });
    assert.equal(zone.status, 201);
    assert.equal(zone.body.estimatedMinutes, 35);
  });
  void burger;
});
