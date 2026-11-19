import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('service flow: QR table menu, KDS, delivery and offline idempotency', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'i'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString('base64');
  const { app } = await import('../index');
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
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const token = async (role: UserRole) => {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: `${role} ${label}`, email: `${role}-${label}-${id}@test.local`, passwordHash: 'x', role } });
      return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    };
    return { tenant, unit, token };
  };
  const A = await makeTenant('flow'); const B = await makeTenant('flowother');
  const admin = await A.token(UserRole.ADMIN); const waiter = await A.token(UserRole.WAITER); const kitchen = await A.token(UserRole.KITCHEN); const courierRole = await A.token(UserRole.DELIVERY); const otherAdmin = await B.token(UserRole.ADMIN);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  const sector = await prisma.productionSector.create({ data: { tenantId: A.tenant.id, name: 'Cozinha', avgPrepMinutes: 10 } });
  const burger = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Hambúrguer', price: 30, sectorId: sector.id } });
  const table = await prisma.restaurantTable.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, label: 'Mesa 7', qrToken: randomBytes(24).toString('base64url') } });
  const qr = table.qrToken;
  const qrOrder = (quantity = 1) => call('POST', `/public/tables/${qr}/orders`, undefined, { customerName: 'Cliente QR', items: [{ productId: burger.id, quantity, notes: 'sem cebola' }] });
  const kds = async () => (await call('GET', '/production/kds', kitchen)).body.items as any[];

  let acceptedOrderId = '';
  await t.test('QR order goes straight to the kitchen by default and the customer can follow it', async () => {
    const created = await qrOrder();
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.awaitingConfirmation, false);
    acceptedOrderId = created.body.id;
    assert.equal((await kds()).some(item => item.order.id === acceptedOrderId), true);
    const tracking = await call('GET', `/public/tables/${qr}/orders`);
    assert.equal(tracking.status, 200);
    assert.deepEqual(tracking.body.orders.map((order: any) => [order.id, order.awaitingConfirmation, order.items[0].name, order.items[0].status]), [[acceptedOrderId, false, 'Hambúrguer', 'PENDING']]);
    assert.equal(tracking.body.accountTotal, Number(created.body.total).toFixed(2), 'the account is the sum of the open orders');
    assert.equal((await call('GET', `/public/tables/${'x'.repeat(30)}/orders`)).status, 404);
  });

  await t.test('with confirmation enabled the QR order waits for the staff, who accept or refuse it', async () => {
    const current = (await call('GET', '/settings', admin)).body.settings.fulfillment;
    assert.equal((await call('PUT', '/settings/fulfillment', waiter, { ...current, qrConfirmation: true })).status, 403, 'only management changes the rule');
    assert.equal((await call('PUT', '/settings/fulfillment', admin, { ...current, qrConfirmation: true })).status, 200);
    const held = await qrOrder(); const refused = await qrOrder(2);
    assert.equal(held.body.awaitingConfirmation, true);
    assert.equal((await kds()).some(item => item.order.id === held.body.id), false, 'held orders never reach the kitchen');
    const pending = await call('GET', '/table-requests/pending-orders', waiter);
    assert.deepEqual(pending.body.items.map((order: any) => order.id).sort(), [held.body.id, refused.body.id].sort());
    assert.equal(pending.body.items[0].items[0].name, 'Hambúrguer');
    assert.equal((await call('GET', '/table-requests/pending-orders', otherAdmin)).body.items.length, 0, 'tenant isolation');
    assert.equal((await call('POST', `/table-requests/pending-orders/${refused.body.id}/refuse`, otherAdmin, { reason: 'x' })).status, 409);
    assert.equal((await call('POST', `/orders/${held.body.id}/release`, waiter)).status, 200 as number, 'accepting releases it to production');
    assert.equal((await kds()).some(item => item.order.id === held.body.id), true);
    assert.equal((await call('POST', `/table-requests/pending-orders/${refused.body.id}/refuse`, waiter, { reason: 'Item em falta' })).status, 204);
    assert.equal((await call('POST', `/table-requests/pending-orders/${refused.body.id}/refuse`, waiter)).status, 409, 'already handled');
    const tracking = await call('GET', `/public/tables/${qr}/orders`);
    assert.equal(tracking.body.orders.find((order: any) => order.id === refused.body.id).refused, true);
    assert.equal(tracking.body.orders.find((order: any) => order.id === held.body.id).awaitingConfirmation, false);
    await call('PUT', '/settings/fulfillment', admin, { ...current, qrConfirmation: false });
  });

  await t.test('call the waiter and ask for the bill: deduplicated, answered by the staff, isolated by restaurant', async () => {
    const first = await call('POST', `/public/tables/${qr}/requests`, undefined, { type: 'WAITER' });
    assert.deepEqual([first.status, first.body.duplicate], [201, false]);
    const again = await call('POST', `/public/tables/${qr}/requests`, undefined, { type: 'WAITER' });
    assert.deepEqual([again.status, again.body.duplicate, again.body.id], [200, true, first.body.id]);
    assert.equal((await call('POST', `/public/tables/${qr}/requests`, undefined, { type: 'BILL', note: 'Dividir em 2' })).status, 201);
    assert.equal((await call('POST', `/public/tables/${qr}/requests`, undefined, { type: 'DRINKS' })).status, 400);
    assert.equal((await call('POST', `/public/tables/${'y'.repeat(30)}/requests`, undefined, { type: 'WAITER' })).status, 404);
    assert.deepEqual((await call('GET', `/public/tables/${qr}/orders`)).body.requests.sort(), ['BILL', 'WAITER']);
    const list = await call('GET', '/table-requests', waiter);
    assert.deepEqual(list.body.items.map((item: any) => [item.type, item.table]), [['WAITER', 'Mesa 7'], ['BILL', 'Mesa 7']]);
    assert.equal((await call('GET', '/table-requests', otherAdmin)).body.items.length, 0);
    assert.equal((await call('GET', '/table-requests', courierRole)).status, 403, 'delivery staff do not handle tables');
    assert.equal((await call('POST', `/table-requests/${first.body.id}/done`, otherAdmin)).status, 409);
    assert.equal((await call('POST', `/table-requests/${first.body.id}/done`, waiter)).status, 204);
    assert.equal((await call('POST', `/table-requests/${first.body.id}/done`, waiter)).status, 409);
    assert.deepEqual((await call('GET', `/public/tables/${qr}/orders`)).body.requests, ['BILL']);
    assert.equal((await call('POST', `/public/tables/${qr}/requests`, undefined, { type: 'WAITER' })).body.duplicate, false, 'a new call is possible after the previous one was answered');
  });

  await t.test('KDS: timeline, order-ready notification, priority, delivered items leave the board, history by sector', async () => {
    const second = await qrOrder(); const secondId = second.body.id as string;
    const items = (await kds()).filter(item => item.order.id === secondId);
    assert.equal(items.length, 1);
    assert.equal(items[0].order.createdBy, null, 'self-service orders have no waiter');
    assert.equal((await call('POST', `/production/orders/${secondId}/priority`, courierRole, { priority: true })).status, 403);
    assert.equal((await call('POST', `/production/orders/${secondId}/priority`, kitchen, { priority: true })).status, 204);
    assert.equal((await kds())[0].order.id, secondId, 'priority orders come first');
    const itemId = items[0].id;
    const started = await call('PATCH', `/production/items/${itemId}/status`, kitchen, { status: 'PREPARING' });
    assert.ok(started.body.startedAt && !started.body.readyAt);
    const ready = await call('PATCH', `/production/items/${itemId}/status`, kitchen, { status: 'READY' });
    assert.ok(ready.body.readyAt);
    assert.equal(ready.body.orderReady, true, 'every item of the order is ready');
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId: A.tenant.id, action: 'KDS_ORDER_READY', entityId: secondId } }));
    const history = await call('GET', '/production/history', kitchen);
    const row = history.body.sectors.find((entry: any) => entry.sector === 'Cozinha');
    assert.ok(row.items >= 1 && row.expectedMinutes === 10);
    assert.equal(history.body.items.some((entry: any) => entry.id === itemId), true);
    assert.equal((await call('GET', '/production/history', otherAdmin)).body.sectors.length, 0, 'tenant isolation');
    const delivered = await call('PATCH', `/production/items/${itemId}/status`, kitchen, { status: 'DELIVERED' });
    assert.ok(delivered.body.deliveredAt);
    assert.equal((await kds()).some(item => item.id === itemId), false, 'delivered items leave the board');
    const reopened = await call('PATCH', `/production/items/${itemId}/status`, kitchen, { status: 'PENDING' });
    assert.deepEqual([reopened.body.startedAt, reopened.body.readyAt, reopened.body.deliveredAt], [null, null, null], 'going back clears the timeline');
  });

  await t.test('delivery: neighborhoods per zone, courier payout (fixed + commission) frozen on delivery and individual report', async () => {
    const zone = await call('POST', '/delivery/zones', admin, { name: 'Centro', fee: 10, estimatedMinutes: 40, minOrder: 20, neighborhoods: ['Centro', 'Vila Nova'] });
    assert.equal(zone.status, 201, JSON.stringify(zone.body));
    assert.deepEqual(zone.body.neighborhoods, ['Centro', 'Vila Nova']);
    assert.equal((await call('PATCH', `/delivery/zones/${zone.body.id}`, admin, { neighborhoods: ['Centro', 'Vila Nova', 'Jardim'] })).body.neighborhoods.length, 3);
    const storeConfig = await call('GET', `/public/store/flow-${id}`);
    assert.deepEqual(storeConfig.body.deliveryZones.find((item: any) => item.name === 'Centro').neighborhoods, ['Centro', 'Vila Nova', 'Jardim']);
    const courier = await call('POST', '/couriers', admin, { name: 'Moto Rápido', paymentPerDelivery: 5, commissionPercent: 20 });
    assert.equal(courier.status, 201, JSON.stringify(courier.body));
    const order = await call('POST', '/orders', waiter, { channel: 'DELIVERY', unitId: A.unit.id, deliveryZoneId: zone.body.id, customerName: 'Entrega', customerPhone: '11988887777', items: [{ productId: burger.id, quantity: 1 }] });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    for (const status of ['PREPARING', 'READY']) assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, admin, { status })).status, 200);
    const dispatched = await call('POST', `/delivery/orders/${order.body.id}/dispatch`, admin, { courierId: courier.body.id });
    assert.equal(dispatched.status, 201, JSON.stringify(dispatched.body));
    await prisma.deliveryJob.update({ where: { id: dispatched.body.id }, data: { dispatchedAt: new Date(Date.now() - 25 * 60_000) } });
    const done = await call('PATCH', `/delivery/${dispatched.body.id}/status`, admin, { status: 'DELIVERED' });
    assert.equal(done.status, 200);
    assert.equal(Number(done.body.payout), 7, 'R$ 5 fixed + 20% of the R$ 10 delivery fee');
    const report = await call('GET', `/couriers/${courier.body.id}/report`, admin);
    assert.equal(report.status, 200);
    assert.deepEqual([report.body.deliveries, report.body.totalOwed, report.body.deliveryFees], [1, 7, 10]);
    assert.ok(report.body.averageMinutes >= 24.9 && report.body.averageMinutes <= 26);
    assert.equal((await call('GET', `/couriers/${courier.body.id}/report`, otherAdmin)).status, 404, 'tenant isolation');
    assert.equal((await call('GET', `/couriers/${courier.body.id}/report?from=2026-12-31T00:00:00Z&to=2026-01-01T00:00:00Z`, admin)).status, 400);
  });

  await t.test('offline PDV: the same client request key never sells twice, even in parallel', async () => {
    const key = `offline-${randomBytes(6).toString('hex')}`;
    const body = { channel: 'POS', unitId: A.unit.id, clientRequestId: key, items: [{ productId: burger.id, quantity: 1 }] };
    const [one, two] = await Promise.all([call('POST', '/orders', waiter, body), call('POST', '/orders', waiter, body)]);
    assert.deepEqual([one.status, two.status].sort(), [200, 201]);
    assert.equal(one.body.id, two.body.id);
    const retry = await call('POST', '/orders', waiter, body);
    assert.deepEqual([retry.status, retry.body.duplicate, retry.body.id], [200, true, one.body.id]);
    assert.equal(await prisma.order.count({ where: { tenantId: A.tenant.id, clientRequestId: key } }), 1);
    assert.equal((await call('POST', '/orders', otherAdmin, { ...body, unitId: B.unit.id, items: [{ productId: burger.id, quantity: 1 }] })).status, 400, 'a foreign product is rejected, the key is per restaurant');
    assert.equal((await call('POST', '/orders', waiter, { ...body, clientRequestId: 'x' })).status, 400, 'malformed keys are rejected');
  });
});
