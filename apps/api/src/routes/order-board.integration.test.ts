import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { fiscalProviders } from '../lib/providers';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('order board: courier dispatch, full order editing and NFC-e numbering/taxation', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
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

  const suffix = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}`.toLowerCase(), status: 'ACTIVE' } });
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const tokens = {} as Record<'ADMIN' | 'CASHIER' | 'WAITER' | 'FINANCE', string>;
    for (const role of [UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER, UserRole.FINANCE] as const) {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      tokens[role] = signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    }
    return { tenant, unit, tokens };
  };
  const A = await makeTenant('board'); const B = await makeTenant('other');
  const admin = A.tokens.ADMIN; const other = B.tokens.ADMIN;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fiscalProviders.clear();
    const tenantIds = [A.tenant.id, B.tenant.id];
    await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.recipeIngredient.deleteMany({ where: { recipe: { tenantId: { in: tenantIds } } } });
    await prisma.stockMovement.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
  });

  const sector = await prisma.productionSector.create({ data: { tenantId: A.tenant.id, name: 'Cozinha', autoPrint: true } });
  const soda = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Refrigerante', price: 6.5, sectorId: sector.id } });
  const freePriceProduct = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Produto preço livre', price: 10, allowFreePrice: true } });
  const fractionalProduct = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Produto fracionado', price: 8, allowFractionalQuantity: true } });
  const packagedProduct = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Produto com embalagem', price: 10, packagingEnabled: true, packagingPrice: 1.25 } });
  const ingredient = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Xarope', unitOfMeasure: 'l', currentStock: 10 } });
  await prisma.recipe.create({ data: { tenantId: A.tenant.id, productId: soda.id, yield: 1, ingredients: { create: [{ ingredientId: ingredient.id, quantity: 1 }] } } });
  const stock = async () => Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).currentStock);

  await t.test('free unit price is limited to enabled products sold through the POS', async () => {
    const regular = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: soda.id, quantity: 1, unitPrice: 3 }] });
    assert.equal(regular.status, 400);
    assert.equal(regular.body.message, 'Este produto não permite preço livre neste canal.');
    const table = await call('POST', '/orders', admin, { channel: 'TABLE', unitId: A.unit.id, items: [{ productId: freePriceProduct.id, quantity: 1, unitPrice: 3 }] });
    assert.equal(table.status, 400);
    assert.equal(table.body.message, 'Este produto não permite preço livre neste canal.');

    const created = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: freePriceProduct.id, quantity: 1, unitPrice: 7.25 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.subtotal), 7.25);
    assert.equal(Number(created.body.items[0].unitPrice), 7.25);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: created.body.id, action: 'ORDER_CREATED' } });
    assert.deepEqual(audit.metadata, { channel: 'POS', scheduledFor: null, freePriceItems: [{ productId: freePriceProduct.id, unitPrice: 7.25 }] });

    const edited = await call('PATCH', `/orders/${created.body.id}`, admin, { items: [{ productId: freePriceProduct.id, quantity: 2, unitPrice: 8.5 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(Number(edited.body.subtotal), 17);
    assert.equal(Number(edited.body.items[0].unitPrice), 8.5);
  });

  await t.test('fractional quantities require product permission and persist through order edits', async () => {
    const excessPrecision = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: fractionalProduct.id, quantity: 0.1234 }] });
    assert.equal(excessPrecision.status, 400, 'quantities support at most three decimal places');
    const rejected = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: soda.id, quantity: 0.375 }] });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.message, 'Este produto não permite quantidade fracionada.');

    const created = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: fractionalProduct.id, quantity: 1.25 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.items[0].quantity), 1.25);
    assert.equal(Number(created.body.subtotal), 10);
    const stored = await prisma.orderItem.findFirstOrThrow({ where: { orderId: created.body.id, productId: fractionalProduct.id } });
    assert.equal(stored.quantity.toString(), '1.25');

    const edited = await call('PATCH', `/orders/${created.body.id}`, admin, { items: [{ productId: fractionalProduct.id, quantity: 0.375 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(Number(edited.body.items[0].quantity), 0.375);
    assert.equal(Number(edited.body.subtotal), 3);

    const rounding = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: fractionalProduct.id, quantity: 0.001 }, { productId: fractionalProduct.id, quantity: 0.001 }] });
    assert.equal(rounding.status, 201, JSON.stringify(rounding.body));
    assert.equal(Number(rounding.body.subtotal), 0.02);
    assert.equal(rounding.body.items.reduce((sum: number, item: { total: string }) => sum + Number(item.total), 0), 0.02);

    const qrToken = randomBytes(24).toString('hex');
    await prisma.restaurantTable.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, label: 'F1', qrToken } });
    const qrOrder = await call('POST', `/public/tables/${qrToken}/orders`, admin, { items: [{ productId: fractionalProduct.id, quantity: 0.625 }] });
    assert.equal(qrOrder.status, 201, JSON.stringify(qrOrder.body));
    const rejectedQrOrder = await call('POST', `/public/tables/${qrToken}/orders`, admin, { items: [{ productId: soda.id, quantity: 0.5 }] });
    assert.equal(rejectedQrOrder.status, 400);
    assert.equal(rejectedQrOrder.body.message, 'Este produto não permite quantidade fracionada.');
  });

  await t.test('packaging is optional, price is snapshotted, and disabled products reject it', async () => {
    const created = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: packagedProduct.id, quantity: 2, withPackaging: true }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.subtotal), 22.5);
    assert.equal(created.body.items[0].withPackaging, true);
    assert.equal(Number(created.body.items[0].packagingPrice), 1.25);
    const edited = await call('PATCH', `/orders/${created.body.id}`, admin, { items: [{ productId: packagedProduct.id, quantity: 3, withPackaging: true }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(Number(edited.body.subtotal), 33.75);

    const rejected = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: soda.id, quantity: 1, withPackaging: true }] });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.message, 'Este produto não permite embalagem.');
    const withoutPackaging = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: packagedProduct.id, quantity: 1 }] });
    assert.equal(withoutPackaging.status, 201, JSON.stringify(withoutPackaging.body));
    assert.equal(Number(withoutPackaging.body.subtotal), 10);
    assert.equal(withoutPackaging.body.items[0].withPackaging, false);

    const store = await fetch(base.replace('/api/v1', `/api/v1/public/store/${A.tenant.slug}`));
    assert.equal(store.status, 200);
    const storeBody = await store.json() as { categories: { products: { id: string; packagingEnabled: boolean; packagingPrice: string }[] }[] };
    const listed = storeBody.categories.flatMap(category => category.products).find(product => product.id === packagedProduct.id);
    assert.equal(listed?.packagingEnabled, true);
    assert.equal(Number(listed?.packagingPrice), 1.25);

    const qrToken = randomBytes(24).toString('hex');
    await prisma.restaurantTable.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, label: 'E1', qrToken } });
    const menu = await call('GET', `/public/tables/${qrToken}/menu`, admin);
    const qrProduct = menu.body.categories.flatMap((category: { products: { id: string; packagingEnabled: boolean; packagingPrice: string }[] }) => category.products).find((product: { id: string }) => product.id === packagedProduct.id);
    assert.equal(qrProduct.packagingEnabled, true);
    assert.equal(Number(qrProduct.packagingPrice), 1.25);
    const qrOrder = await call('POST', `/public/tables/${qrToken}/orders`, admin, { items: [{ productId: packagedProduct.id, quantity: 1, withPackaging: true }] });
    assert.equal(qrOrder.status, 201, JSON.stringify(qrOrder.body));
    assert.equal(Number(qrOrder.body.total), 11.25);
  });

  await t.test('promissory sales create a linked receivable and reconcile it with order payments', async () => {
    const created = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, customerName: 'Cliente a prazo', items: [{ productId: soda.id, quantity: 2 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const dueAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const promissory = await call('POST', `/orders/${created.body.id}/promissory`, admin, { dueAt });
    assert.equal(promissory.status, 201, JSON.stringify(promissory.body));
    assert.equal(Number(promissory.body.amount), 13);
    assert.equal(Number(promissory.body.paidAmount), 0);
    assert.equal(promissory.body.order.id, created.body.id);
    assert.equal(promissory.body.autoPrintPromissory, false);
    assert.equal((await call('POST', `/orders/${created.body.id}/promissory`, admin, { dueAt })).status, 409);
    assert.equal((await call('POST', `/financial/entries/${promissory.body.id}/settle`, admin)).status, 409, 'an order promissory can only be settled through a recorded payment');
    const edited = await call('PATCH', `/orders/${created.body.id}`, admin, { items: [{ productId: soda.id, quantity: 3 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const adjusted = await prisma.financialEntry.findUniqueOrThrow({ where: { id: promissory.body.id } });
    assert.equal(Number(adjusted.amount), 19.5, 'editing an order keeps the open promissory aligned with the amount due');

    const partial = await call('POST', '/cash/payments', admin, { orderId: created.body.id, method: 'CASH', amount: 5 });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    const partiallyPaid = await prisma.financialEntry.findUniqueOrThrow({ where: { id: promissory.body.id } });
    assert.equal(Number(partiallyPaid.paidAmount), 5);
    assert.equal(partiallyPaid.status, 'OPEN');
    const summary = await call('GET', '/financial/summary', admin);
    assert.ok(Number(summary.body.openReceivables) >= 14.5);

    const remaining = await call('POST', '/cash/payments', admin, { orderId: created.body.id, method: 'PIX', amount: 14.5 });
    assert.equal(remaining.status, 201, JSON.stringify(remaining.body));
    const paid = await prisma.financialEntry.findUniqueOrThrow({ where: { id: promissory.body.id } });
    assert.equal(Number(paid.paidAmount), 19.5);
    assert.equal(paid.status, 'PAID');
    assert.ok(paid.settledAt);

    assert.equal((await call('POST', `/cash/payments/${remaining.body.payment.id}/refund`, admin)).status, 204);
    const reopened = await prisma.financialEntry.findUniqueOrThrow({ where: { id: promissory.body.id } });
    assert.equal(Number(reopened.paidAmount), 5);
    assert.equal(reopened.status, 'OPEN');

    const cancelledOrder = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, customerName: 'Outro cliente', items: [{ productId: soda.id, quantity: 1 }] });
    const cancelledPromissory = await call('POST', `/orders/${cancelledOrder.body.id}/promissory`, admin, { dueAt, debtorName: 'Responsável' });
    assert.equal(cancelledPromissory.status, 201);
    await call('PATCH', `/orders/${cancelledOrder.body.id}/status`, admin, { status: 'CANCELLED' });
    const cancelledEntry = await prisma.financialEntry.findUniqueOrThrow({ where: { id: cancelledPromissory.body.id } });
    assert.equal(cancelledEntry.status, 'CANCELLED');
  });

  await t.test('product balances are reserved by order, restored on cancellation and preserved on failed edits', async () => {
    const tracked = await prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, name: 'Estoque controlado', price: 4, stockControlled: true, stockQuantity: 3 } });
    const balance = async () => (await prisma.product.findUniqueOrThrow({ where: { id: tracked.id } })).stockQuantity.toString();
    const place = (quantity: number) => call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: tracked.id, quantity }] });

    const reserved = await place(2);
    assert.equal(reserved.status, 201, JSON.stringify(reserved.body));
    assert.equal(await balance(), '1', 'order creation reserves sellable product stock');
    const insufficient = await place(2);
    assert.equal(insufficient.status, 409);
    assert.match(insufficient.body.message, /Insufficient stock/);
    await call('PATCH', `/orders/${reserved.body.id}/status`, admin, { status: 'CANCELLED' });
    assert.equal(await balance(), '3', 'cancelling restores the stock reservation');

    const editable = await place(2);
    assert.equal(editable.status, 201);
    assert.equal((await call('PATCH', `/orders/${editable.body.id}`, admin, { items: [{ productId: tracked.id, quantity: 4 }] })).status, 409);
    assert.equal(await balance(), '1', 'failed edit rolls back both reversal and new reservation');
    const unchanged = await prisma.orderItem.findFirstOrThrow({ where: { orderId: editable.body.id, productId: tracked.id } });
    assert.equal(unchanged.quantity.toString(), '2');
    const reduced = await call('PATCH', `/orders/${editable.body.id}`, admin, { items: [{ productId: tracked.id, quantity: 1 }] });
    assert.equal(reduced.status, 200);
    assert.equal(await balance(), '2');
    await call('PATCH', `/orders/${editable.body.id}/status`, admin, { status: 'CANCELLED' });
    assert.equal(await balance(), '3');
  });

  await t.test('dispatch needs a ready order and a courier; edits recompute totals, stock and payments', async () => {
    const courier = (await call('POST', '/couriers', admin, { name: 'Zé Moto', phone: '11977770000' })).body;
    const zone = (await call('POST', '/delivery/zones', admin, { name: 'Centro', fee: 5 })).body;
    const far = (await call('POST', '/delivery/zones', admin, { name: 'Distante', fee: 12 })).body;
    const created = await call('POST', '/orders', admin, { channel: 'DELIVERY', unitId: A.unit.id, deliveryZoneId: zone.id, customerName: 'João', items: [{ productId: soda.id, quantity: 2 }] });
    assert.equal(created.status, 201);
    const id = created.body.id as string;
    const dispatch = (token = admin, body: unknown = { courierId: courier.id }) => call('POST', `/delivery/orders/${id}/dispatch`, token, body);
    assert.equal((await dispatch()).status, 409, 'only ready orders leave for delivery');

    const edited = await call('PATCH', `/orders/${id}`, admin, { customerName: 'João Silva', address: 'Rua A, 10', deliveryZoneId: far.id, items: [{ productId: soda.id, quantity: 3 }] });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(Number(edited.body.subtotal), 19.5); assert.equal(Number(edited.body.deliveryFee), 12); assert.equal(Number(edited.body.total), 31.5);
    assert.equal(edited.body.deliveryJob.address, 'Rua A, 10'); assert.equal(edited.body.items.length, 1); assert.equal(edited.body.customerName, 'João Silva');
    assert.equal(Number((await call('PATCH', `/orders/${id}`, admin, { discount: 1.5, deliveryFee: 8 })).body.total), 26);
    assert.equal((await call('PATCH', `/orders/${id}`, A.tokens.CASHIER, { discount: 3 })).body.message, 'DISCOUNT_RELEASE_REQUIRED');
    assert.equal((await call('PATCH', `/orders/${id}`, A.tokens.WAITER, { customerName: 'x' })).status, 403);
    assert.equal((await call('PATCH', `/orders/${id}`, other, { customerName: 'x' })).status, 404);
    assert.equal((await call('PATCH', `/orders/${id}`, admin, { discount: 999 })).body.message, 'DISCOUNT_EXCEEDS_TOTAL');
    assert.equal((await call('PATCH', `/orders/${id}`, admin, {})).status, 400);

    await call('POST', '/cash/payments', admin, { orderId: id, method: 'CASH', amount: 10 });
    assert.equal((await call('PATCH', `/orders/${id}`, admin, { items: [{ productId: soda.id, quantity: 1 }], deliveryFee: 0 })).body.message, 'PAYMENTS_EXCEED_TOTAL');
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: id } });
    assert.equal((await call('PATCH', `/orders/${id}`, admin, { payments: [{ id: payment.id, method: 'PIX' }] })).body.payments[0].method, 'PIX');

    await call('PATCH', `/orders/${id}/status`, admin, { status: 'PREPARING' });
    assert.equal(await stock(), 7, 'three sodas consumed');
    const resized = await call('PATCH', `/orders/${id}`, admin, { items: [{ productId: soda.id, quantity: 5 }] });
    assert.equal(resized.status, 200, JSON.stringify(resized.body));
    assert.equal(await stock(), 5, 'stock follows the edited quantity');
    assert.equal(Number(resized.body.serviceFee), 0);
    await call('PATCH', `/orders/${id}/status`, admin, { status: 'READY' });

    assert.equal((await dispatch(admin, {})).status, 400, 'a courier is required');
    assert.equal((await dispatch(other)).status, 404);
    const sent = await dispatch();
    assert.equal(sent.status, 200); assert.equal(sent.body.status, 'PICKED_UP'); assert.equal(sent.body.courierName, 'Zé Moto'); assert.equal(sent.body.address, 'Rua A, 10');
    const listed = (await call('GET', '/orders?scope=active', admin)).body.items.find((item: any) => item.id === id);
    assert.equal(listed.deliveryJob.status, 'PICKED_UP'); assert.equal(listed.deliveryJob.courierId, courier.id);
    await call('PATCH', `/orders/${id}/status`, admin, { status: 'COMPLETED' });
    assert.equal((await call('PATCH', `/orders/${id}`, admin, { customerName: 'tarde' })).body.message, 'ORDER_CLOSED');

    const noJob = await call('POST', '/orders', admin, { channel: 'DELIVERY', unitId: A.unit.id, items: [{ productId: soda.id, quantity: 1 }] });
    for (const status of ['PREPARING', 'READY']) await call('PATCH', `/orders/${noJob.body.id}/status`, admin, { status });
    const direct = await call('POST', `/delivery/orders/${noJob.body.id}/dispatch`, A.tokens.CASHIER, { courierName: 'Avulso', address: 'Rua B' });
    assert.equal(direct.status, 201, 'the delivery is created on dispatch'); assert.equal(direct.body.courierName, 'Avulso');
  });

  await t.test('NFC-e follows the tenant numbering and the product tax rules', async () => {
    const rule = await prisma.taxRule.create({ data: { tenantId: A.tenant.id, name: 'Bebidas', ncm: '22021000', cfop: '5102', icmsCst: '00', icmsRate: 18, pisCst: '01', pisRate: 1.65, cofinsCst: '01', cofinsRate: 7.6 } });
    const taxed = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Suco tributado', price: 8, taxRuleId: rule.id } });
    const place = (productId: string) => call('POST', '/orders', admin, { unitId: A.unit.id, items: [{ productId, quantity: 1 }] });
    const order = await place(taxed.id);
    const emit = (orderId: string, token = admin) => call('POST', `/fiscal/orders/${orderId}/emit`, token, { provider: 'fakefisc' });
    assert.equal((await emit(order.body.id)).status, 501, 'no provider registered');
    let outcome: 'AUTHORIZED' | 'REJECTED' = 'REJECTED';
    const received: any[] = [];
    fiscalProviders.register({ name: 'fakefisc', emit: async fiscalOrder => { received.push(fiscalOrder); return { status: outcome, accessKey: 'K'.repeat(44), error: outcome === 'REJECTED' ? 'CNPJ inválido' : undefined }; }, cancel: async () => ({ cancelled: true }) });
    assert.equal((await emit(order.body.id, A.tokens.WAITER)).status, 403);
    const unpaid = await emit(order.body.id); assert.equal(unpaid.status, 422); assert.equal(unpaid.body.code, 'FISCAL_PAYMENT_MISMATCH', 'unpaid: refused before a number is used');
    await prisma.payment.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, orderId: order.body.id, method: 'CASH', amount: order.body.total } });

    const untaxed = await place(soda.id);
    const blocked = await emit(untaxed.body.id);
    assert.equal(blocked.status, 422); assert.match(blocked.body.message, /Refrigerante/);
    assert.equal((await call('PUT', '/fiscal/numbering', admin, { series: '2', nextNumber: 100 })).status, 200);
    assert.equal((await call('PUT', '/fiscal/numbering', A.tokens.FINANCE, { series: '2', nextNumber: 200 })).status, 403, 'only management changes the numbering');
    assert.equal((await call('PUT', '/fiscal/numbering', admin, { series: 'AB', nextNumber: 1 })).status, 400);

    // The order is still OPEN: an NFC-e can be issued while it is in progress.
    const rejected = await emit(order.body.id); assert.equal(rejected.status, 422); assert.equal(rejected.body.status, 'REJECTED');
    assert.equal(rejected.body.number, '100'); assert.equal(rejected.body.series, '2');
    assert.deepEqual({ series: received[0].series, number: received[0].number }, { series: '2', number: '100' });
    assert.deepEqual(received[0].items[0].tax, { ncm: '22021000', cest: null, origin: 0, cfop: '5102', icmsCst: '00', icmsRate: '18', icmsReduction: null, pisCst: '01', pisRate: '1.65', cofinsCst: '01', cofinsRate: '7.6' });
    outcome = 'AUTHORIZED';
    const ok = await emit(order.body.id, A.tokens.CASHIER);
    assert.equal(ok.status, 201); assert.equal(ok.body.number, '100', 'a retry keeps the reserved number');
    assert.equal((await emit(order.body.id)).status, 409, 'already authorized');
    const second = await place(taxed.id);
    await prisma.payment.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, orderId: second.body.id, method: 'CASH', amount: second.body.total } });
    assert.equal((await emit(second.body.id)).body.number, '101', 'the next order takes the next number');
    const numbering = await call('GET', '/fiscal/numbering', admin);
    assert.deepEqual(numbering.body.items.find((item: any) => item.kind === 'NFCE'), { kind: 'NFCE', series: '2', nextNumber: 102 });
    assert.equal((await call('PUT', '/fiscal/numbering', admin, { series: '2', nextNumber: 101 })).status, 409, 'issued numbers cannot be reused');
    const listed = (await call('GET', '/orders?scope=active', admin)).body.items.find((item: any) => item.id === order.body.id);
    assert.equal(listed.fiscalDocuments[0].number, '100');

    const cancelled = await place(taxed.id);
    await call('PATCH', `/orders/${cancelled.body.id}/status`, admin, { status: 'CANCELLED' });
    const refused = await emit(cancelled.body.id);
    assert.equal(refused.status, 409); assert.match(refused.body.message, /Cancelled/);
  });
});
