import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { DiscountType, UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { releaseDueOrders } from '../lib/scheduling';
import { saveSettingsSection } from '../lib/settings';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('counter operations: weighed products, promotions, scheduling, cover charge and order numbers', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'c'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };

  const id = randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Ops ${id}`, slug: `ops-${id}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
  const tokens = {} as Record<'ADMIN' | 'CASHIER', { token: string; userId: string }>;
  for (const role of [UserRole.ADMIN, UserRole.CASHIER] as const) {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${id}@test.local`, passwordHash: 'x', role } });
    tokens[role] = { token: signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role }), userId: user.id };
  }
  const admin = tokens.ADMIN.token;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.recipeIngredient.deleteMany({ where: { recipe: { tenantId: tenant.id } } });
    await prisma.stockMovement.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
    await prisma.$disconnect();
  });

  const sector = await prisma.productionSector.create({ data: { tenantId: tenant.id, name: 'Cozinha', autoPrint: true } });
  const plain = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Suco', price: 10, sectorId: sector.id } });
  const promo = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Torta', price: 20, sectorId: sector.id } });
  const weighed = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Self-service', price: 40, soldByWeight: true, scaleCode: 123, sectorId: sector.id } });
  const ingredient = await prisma.ingredient.create({ data: { tenantId: tenant.id, name: 'Comida', unitOfMeasure: 'kg', currentStock: 10 } });
  await prisma.recipe.create({ data: { tenantId: tenant.id, productId: weighed.id, yield: 1, ingredients: { create: [{ ingredientId: ingredient.id, quantity: 1 }] } } });
  const promotion = await prisma.promotion.create({ data: { tenantId: tenant.id, name: 'Torta -25%', type: DiscountType.PERCENT, value: 25, startsAt: new Date(Date.now() - 3600_000), products: { create: [{ productId: promo.id }] } } });
  assert.ok(promotion.id);
  const order = (body: Record<string, unknown>, token = admin) => call('POST', '/orders', token, { unitId: unit.id, ...body });

  await t.test('weighed products require the weight, price is per kg and stock is consumed per kg', async () => {
    assert.equal((await order({ items: [{ productId: weighed.id, quantity: 1 }] })).status, 400);
    const sold = await order({ items: [{ productId: weighed.id, quantity: 2, weightKg: 0.5 }] });
    assert.equal(sold.status, 201);
    assert.equal(Number(sold.body.items[0].weightKg), 0.5);
    assert.equal(Number(sold.body.items[0].total), 40);
    assert.equal(Number(sold.body.total), 40);
    assert.equal((await call('PATCH', `/orders/${sold.body.id}/status`, admin, { status: 'PREPARING' })).status, 200);
    assert.equal(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).currentStock), 9);
  });

  await t.test('regular products reject weight', async () => {
    const rejected = await order({ items: [{ productId: plain.id, quantity: 1, weightKg: 1 }] });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.message, 'WEIGHT_NOT_ALLOWED');
  });

  await t.test('live promotions lower the unit price and order numbers are sequential', async () => {
    const first = await order({ items: [{ productId: promo.id, quantity: 2 }] });
    const second = await order({ items: [{ productId: plain.id, quantity: 1 }] });
    assert.equal(first.status, 201);
    assert.equal(Number(first.body.items[0].unitPrice), 15);
    assert.equal(Number(first.body.total), 30);
    assert.equal(second.body.number, first.body.number + 1);
  });

  await t.test('manual discount needs a password release unless the user manages the restaurant', async () => {
    const adjustment = { mode: 'DISCOUNT', type: 'PERCENT', value: 10 };
    const items = [{ productId: plain.id, quantity: 2 }];
    const denied = await order({ items, adjustment }, tokens.CASHIER.token);
    assert.equal(denied.status, 403);
    const release = await prisma.passwordRelease.create({ data: { tenantId: tenant.id, action: 'DISCOUNT', requestedByUserId: tokens.CASHIER.userId } });
    const allowed = await order({ items, adjustment, adjustmentReleaseId: release.id }, tokens.CASHIER.token);
    assert.equal(allowed.status, 201);
    assert.equal(Number(allowed.body.discount), 2);
    assert.equal(Number(allowed.body.total), 18);
    const surcharge = await order({ items, adjustment: { mode: 'SURCHARGE', type: 'FIXED', value: 5 } }, tokens.CASHIER.token);
    assert.equal(Number(surcharge.body.total), 25);
  });

  await t.test('cover charge uses the live event and only applies to tables', async () => {
    assert.equal((await order({ channel: 'TABLE', tableLabel: '7', couvertPeople: 2, items: [{ productId: plain.id, quantity: 1 }] })).status, 400);
    await prisma.coverEvent.create({ data: { tenantId: tenant.id, description: 'Música ao vivo', amount: 12, startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) } });
    const table = await order({ channel: 'TABLE', tableLabel: '7', couvertPeople: 3, applyServiceFee: false, items: [{ productId: plain.id, quantity: 1 }] });
    assert.equal(table.status, 201);
    assert.equal(Number(table.body.couvertFee), 36);
    assert.equal(Number(table.body.total), 46);
    const counter = await order({ couvertPeople: 1, items: [{ productId: plain.id, quantity: 1 }] });
    assert.equal(counter.body.message, 'COUVERT_ONLY_FOR_TABLE');
  });

  await t.test('scheduled orders are held away from production until released', async () => {
    const scheduledFor = new Date(Date.now() + 3 * 3600_000).toISOString();
    const items = [{ productId: plain.id, quantity: 1 }];
    const disabled = await order({ scheduledFor, items });
    assert.equal(disabled.status, 400);
    assert.equal(disabled.body.message, 'SCHEDULING_DISABLED');

    await saveSettingsSection(prisma, tenant.id, 'scheduling', { enabled: true, maxDaysAhead: 7, leadTime: '00:30', blockedFrom: null, blockedTo: null, slots: [] });
    assert.equal((await order({ scheduledFor: new Date(Date.now() + 60_000).toISOString(), items })).body.message, 'SCHEDULE_TOO_SOON');
    const held = await order({ scheduledFor, items });
    assert.equal(held.status, 201);
    assert.equal(held.body.releasedAt, null);
    assert.equal(await prisma.printJob.count({ where: { orderId: held.body.id } }), 0);

    const kds = await call('GET', '/production/kds', admin);
    assert.equal(kds.body.items.some((item: any) => item.order.id === held.body.id), false);
    assert.equal((await call('PATCH', `/orders/${held.body.id}/status`, admin, { status: 'PREPARING' })).status, 409);
    const active = await call('GET', '/orders?scope=active&pageSize=100', admin);
    assert.equal(active.body.items.some((item: any) => item.id === held.body.id), false);
    const heldList = await call('GET', '/orders?scope=held', admin);
    assert.deepEqual(heldList.body.items.map((item: any) => item.id), [held.body.id]);

    assert.equal((await call('POST', `/orders/${held.body.id}/release`, admin)).status, 200);
    assert.ok(await prisma.printJob.count({ where: { orderId: held.body.id } }) > 0);
    assert.equal((await call('GET', '/production/kds', admin)).body.items.some((item: any) => item.order.id === held.body.id), true);

    const due = await order({ scheduledFor, items });
    assert.equal(await releaseDueOrders(prisma, { tenantId: tenant.id }), 0);
    await prisma.order.update({ where: { id: due.body.id }, data: { releaseAt: new Date(Date.now() - 1000) } });
    assert.equal(await releaseDueOrders(prisma, { tenantId: tenant.id }), 1);
    assert.ok((await prisma.order.findUniqueOrThrow({ where: { id: due.body.id } })).releasedAt);
  });

  await t.test('order list filters by delivery type and embeds payments and customer', async () => {
    const delivery = await order({ channel: 'DELIVERY', customerName: 'Ana', customerPhone: '11988887777', items: [{ productId: plain.id, quantity: 1 }] });
    assert.equal(delivery.status, 201);
    await prisma.payment.create({ data: { tenantId: tenant.id, unitId: unit.id, orderId: delivery.body.id, method: 'PIX', amount: 5 } });
    const onlyDelivery = await call('GET', '/orders?type=delivery', admin);
    assert.deepEqual(onlyDelivery.body.items.map((item: any) => item.id), [delivery.body.id]);
    assert.equal(onlyDelivery.body.items[0].customer.name, 'Ana');
    assert.equal(onlyDelivery.body.items[0].payments[0].method, 'PIX');
    const pickup = await call('GET', '/orders?type=pickup&pageSize=100', admin);
    assert.equal(pickup.body.items.some((item: any) => item.channel === 'DELIVERY'), false);
  });

  await t.test('custom KDS stages map to real item phases without touching the order status', async () => {
    const stages = [
      { key: 'RECEIVED', label: 'Recebido', phase: 'PENDING', color: '#b45309' }, { key: 'ASSEMBLY', label: 'Montagem', phase: 'PREPARING', color: '#0369a1' },
      { key: 'OVEN', label: 'No forno', phase: 'PREPARING', color: '#dc2626' }, { key: 'READY', label: 'Pronto', phase: 'READY', color: '#047857' }, { key: 'DELIVERED', label: 'Entregue', phase: 'DELIVERED', color: '#475569' },
    ];
    // Invalid flows are refused: out of order phases, repeated keys, a missing phase.
    assert.equal((await call('PUT', '/production/stages', admin, { stages: [stages[1], stages[0], stages[3], stages[4]] })).status, 400);
    assert.equal((await call('PUT', '/production/stages', admin, { stages: [stages[0], stages[0], stages[3], stages[4]] })).status, 400);
    assert.equal((await call('PUT', '/production/stages', admin, { stages: [stages[0], stages[1], stages[2], stages[4]] })).status, 400);
    assert.equal((await call('PUT', '/production/stages', tokens.CASHIER.token, { stages })).status, 403, 'only managers define the flow');
    assert.equal((await call('PUT', '/production/stages', admin, { stages })).status, 200);

    const created = await order({ items: [{ productId: plain.id, quantity: 1 }] });
    const listed = async () => (await call('GET', '/production/kds', admin)).body.items.find((item: any) => item.order.id === created.body.id);
    assert.equal((await listed()).stage.key, 'RECEIVED');
    const itemId = (await listed()).id;
    assert.equal((await call('PATCH', `/production/items/${itemId}/status`, admin, { stage: 'OVEN' })).status, 200);
    const inOven = await listed();
    assert.deepEqual([inOven.status, inOven.stage.key, inOven.kdsStage], ['PREPARING', 'OVEN', 'OVEN']);
    assert.ok(inOven.startedAt, 'the phase timeline still runs');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: created.body.id } })).status, 'OPEN', 'the general order status is not a KDS stage');
    assert.equal((await call('PATCH', `/production/items/${itemId}/status`, admin, { stage: 'NOPE' })).status, 400);
    assert.equal((await call('PATCH', `/production/items/${itemId}/status`, admin, { stage: 'OVEN', status: 'READY' })).status, 400, 'stage and status are exclusive');
    // The plain status API keeps working and lands on the first stage of that phase.
    assert.equal((await call('PATCH', `/production/items/${itemId}/status`, admin, { status: 'PREPARING' })).status, 200);
    assert.equal((await listed()).stage.key, 'ASSEMBLY');
    assert.equal((await call('PATCH', `/production/items/${itemId}/status`, admin, { stage: 'READY' })).body.orderReady, true);
    assert.equal((await call('PATCH', `/production/items/${itemId}/status`, admin, { stage: 'DELIVERED' })).status, 200);
    assert.equal(await listed(), undefined, 'a delivered stage leaves the panel');
    assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, action: 'KDS_STAGES_UPDATED' } }), 1);
  });

  await t.test('scope=unpaid lists only orders with an outstanding balance', async () => {
    const items = [{ productId: plain.id, quantity: 1 }];
    const open = await order({ items });
    const paid = await order({ items });
    const partial = await order({ items });
    await prisma.payment.create({ data: { tenantId: tenant.id, unitId: unit.id, orderId: paid.body.id, method: 'PIX', amount: Number(paid.body.total) } });
    await prisma.payment.create({ data: { tenantId: tenant.id, unitId: unit.id, orderId: partial.body.id, method: 'PIX', amount: 1 } });
    const ids = (await call('GET', '/orders?scope=unpaid&pageSize=100', admin)).body.items.map((item: any) => item.id);
    assert.ok(ids.includes(open.body.id) && ids.includes(partial.body.id));
    assert.equal(ids.includes(paid.body.id), false);
  });
});
