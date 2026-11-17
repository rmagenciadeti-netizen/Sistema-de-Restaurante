import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { fiscalProviders, paymentProviders } from '../lib/providers';

// These tests need a migrated PostgreSQL database; CI sets RUN_DB_TESTS=1 after `prisma migrate deploy`.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

type Actor = { token: string; tenantId: string; unitId: string };

async function createTenant(role: UserRole = UserRole.ADMIN) {
  const id = suffix();
  const tenant = await prisma.tenant.create({ data: { name: `Test ${id}`, slug: `test-${id}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz', serviceFeePercent: 10 } });
  const actors: Partial<Record<UserRole, Actor>> = {};
  for (const r of new Set<UserRole>([role, UserRole.WAITER, UserRole.KITCHEN, UserRole.FINANCE, UserRole.MANAGER, UserRole.CASHIER])) {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: r, email: `${r}-${id}@test.local`, passwordHash: 'x', role: r } });
    actors[r] = { token: signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role: r }), tenantId: tenant.id, unitId: unit.id };
  }
  return { tenant, unit, admin: actors[role]!, actors };
}

test('database-backed API behaviour', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };
  const A = await createTenant();
  const B = await createTenant();
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const tenantIds = [A.tenant.id, B.tenant.id];
    // Restrictive foreign keys (items->products, movements/purchases->ingredients) require deleting history first.
    await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.recipeIngredient.deleteMany({ where: { recipe: { tenantId: { in: tenantIds } } } });
    await prisma.comboComponent.deleteMany({ where: { combo: { tenantId: { in: tenantIds } } } });
    await prisma.purchaseOrder.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.stockMovement.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
  });
  const a = A.admin.token; const b = B.admin.token;

  // ---------- Production setup ----------
  const sector = (await call('POST', '/production/sectors', a, { name: 'Cozinha', autoPrint: true, unitId: A.unit.id })).body;
  assert.ok(sector.id);
  const printer = await call('POST', '/printing/printers', a, { name: 'Cozinha 1', connectionType: 'NETWORK', address: '192.168.0.50', port: 9100, sectorId: sector.id, isPrimary: true, unitId: A.unit.id });
  assert.equal(printer.status, 201);
  const category = await prisma.productCategory.create({ data: { tenantId: A.tenant.id, name: 'Lanches' } });
  const burger = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'X-Burger', price: 30, sectorId: sector.id, categoryId: category.id } });
  const soda = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Refrigerante', price: 6.5 } });

  await t.test('tenant B cannot see or touch tenant A resources', async () => {
    for (const path of ['/production/sectors', '/printing/printers', '/products', '/tables', '/customers', '/coupons', '/purchasing/suppliers']) {
      const res = await call('GET', path, b); assert.equal(res.status, 200, path);
      assert.equal(res.body.items.length, 0, `${path} leaked data`);
    }
    assert.equal((await call('PATCH', `/printing/printers/${printer.body.id}`, b, { name: 'hack' })).status, 404);
    assert.equal((await call('PATCH', `/production/sectors/${sector.id}`, b, { name: 'hack' })).status, 404);
    assert.equal((await call('POST', '/printing/printers', b, { name: 'p', connectionType: 'USB', sectorId: sector.id })).status, 400);
    const order = await call('POST', '/orders', b, { items: [{ productId: burger.id, quantity: 1 }] });
    assert.equal(order.status, 400);
  });

  await t.test('order engine applies coupon, service fee, and queues a production print', async () => {
    const table = (await call('POST', '/tables', a, { label: '7', seats: 4, unitId: A.unit.id })).body;
    assert.ok(table.qrToken.length >= 20);
    assert.equal((await call('POST', '/coupons', a, { code: 'ola10', type: 'PERCENT', value: 10 })).status, 201);
    const created = await call('POST', '/orders', a, { channel: 'TABLE', tableId: table.id, unitId: A.unit.id, couponCode: 'OLA10', customerName: 'Maria', customerPhone: '(11) 99999-0001', marketingConsent: true, items: [{ productId: burger.id, quantity: 2, notes: 'sem cebola' }, { productId: soda.id, quantity: 1 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // subtotal 66.50, discount 6.65, service 10% of 59.85 = 5.99 (rounded half up)
    assert.equal(Number(created.body.subtotal), 66.5);
    assert.equal(Number(created.body.discount), 6.65);
    assert.equal(Number(created.body.serviceFee), 5.99);
    assert.equal(Number(created.body.total), 65.84);
    assert.equal((await prisma.coupon.findFirstOrThrow({ where: { tenantId: A.tenant.id, code: 'OLA10' } })).usedCount, 1);

    const jobs = (await call('GET', '/printing/jobs', a)).body.items;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'PENDING');
    assert.match(jobs[0].content, /2x X-Burger/);
    assert.match(jobs[0].content, /sem cebola/);
    assert.doesNotMatch(jobs[0].content, /Refrigerante/, 'items of other sectors must not be printed here');

    // ----- print agent -----
    const agent = (await call('POST', '/printing/agents', a, { name: 'Balcão' })).body;
    assert.match(agent.token, /^rmagt_/);
    assert.equal((await call('GET', '/print-agent/jobs/next')).status, 401);
    assert.equal((await call('GET', '/print-agent/jobs/next', 'rmagt_invalidinvalidinvalid')).status, 401);
    assert.equal((await call('GET', '/print-agent/jobs/next', a)).status, 401, 'user JWT is not an agent token');
    const other = (await call('POST', '/printing/agents', b, { name: 'Agente B' })).body;
    assert.equal((await call('GET', '/print-agent/jobs/next', other.token)).body.items.length, 0, 'other tenant agent sees nothing');

    const claimed = (await call('GET', '/print-agent/jobs/next', agent.token)).body.items;
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].printer.address, '192.168.0.50');
    assert.equal((await call('GET', '/print-agent/jobs/next', agent.token)).body.items.length, 0, 'claimed job is not handed out twice');
    assert.equal((await call('POST', `/print-agent/jobs/${claimed[0].id}/result`, other.token, { ok: true })).status, 404);
    assert.equal((await call('POST', `/print-agent/jobs/${claimed[0].id}/result`, agent.token, { ok: true })).body.status, 'PRINTED');

    // ----- failure/retry policy -----
    const test1 = (await call('POST', `/printing/printers/${printer.body.id}/test`, a)).body;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const next = (await call('GET', '/print-agent/jobs/next', agent.token)).body.items;
      assert.equal(next[0].id, test1.id);
      const result = await call('POST', `/print-agent/jobs/${test1.id}/result`, agent.token, { ok: false, error: 'offline' });
      assert.equal(result.body.status, attempt < 3 ? 'PENDING' : 'FAILED');
    }
    assert.equal((await call('POST', `/printing/jobs/${test1.id}/retry`, a)).body.status, 'PENDING');

    // ----- status flow, WhatsApp outbox and loyalty -----
    const id = created.body.id;
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) assert.equal((await call('PATCH', `/orders/${id}/status`, a, { status })).status, 200, status);
    const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId: A.tenant.id } });
    assert.equal(customer.loyaltyPoints, 65);
    assert.equal(customer.phone, '11999990001');
    assert.equal(await prisma.whatsappMessage.count({ where: { tenantId: A.tenant.id, template: 'order_ready', status: 'QUEUED' } }), 1);

    // ----- LGPD -----
    assert.equal((await call('POST', `/customers/${customer.id}/anonymize`, A.actors.WAITER!.token)).status, 403);
    assert.equal((await call('POST', `/customers/${customer.id}/anonymize`, a)).status, 204);
    const anon = await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(anon.name, 'Cliente anonimizado'); assert.equal(anon.marketingConsent, false);
    assert.equal((await prisma.whatsappMessage.findFirstOrThrow({ where: { tenantId: A.tenant.id } })).toPhone, 'redacted');
  });

  await t.test('coupon rules are enforced', async () => {
    assert.equal((await call('POST', '/coupons', a, { code: 'ONCE', type: 'FIXED', value: 5, maxUses: 1 })).status, 201);
    const make = () => call('POST', '/orders', a, { unitId: A.unit.id, couponCode: 'once', items: [{ productId: soda.id, quantity: 1 }] });
    assert.equal((await make()).status, 201);
    assert.equal((await make()).status, 400, 'exhausted coupon must be rejected');
    assert.equal((await call('POST', '/coupons', a, { code: 'BAD', type: 'PERCENT', value: 150 })).status, 400);
    assert.equal((await call('POST', '/orders', a, { couponCode: 'NOPE', items: [{ productId: soda.id, quantity: 1 }] })).status, 400);
  });

  await t.test('role permissions', async () => {
    assert.equal((await call('POST', '/coupons', A.actors.WAITER!.token, { code: 'W', type: 'FIXED', value: 1 })).status, 403);
    assert.equal((await call('GET', '/financial/summary', A.actors.KITCHEN!.token)).status, 403);
    assert.equal((await call('GET', '/financial/summary', A.actors.FINANCE!.token)).status, 200);
    assert.equal((await call('POST', '/orders', A.actors.KITCHEN!.token, { items: [{ productId: soda.id, quantity: 1 }] })).status, 403);
    assert.equal((await call('GET', '/production/kds', A.actors.KITCHEN!.token)).status, 200);
  });

  await t.test('public QR-code menu and ordering', async () => {
    const table = (await call('POST', '/tables', a, { label: 'QR1', seats: 2, unitId: A.unit.id })).body;
    assert.equal((await call('GET', '/public/tables/short/menu')).status, 404);
    const menu = await call('GET', `/public/tables/${table.qrToken}/menu`);
    assert.equal(menu.status, 200);
    assert.equal(menu.body.table, 'QR1');
    assert.ok(!JSON.stringify(menu.body).includes('cost'), 'cost must not be exposed');
    assert.equal(menu.body.categories.flatMap((c: any) => c.products).length, 2);
    const order = await call('POST', `/public/tables/${table.qrToken}/orders`, undefined, { customerName: 'Joana', customerPhone: '11988887777', items: [{ productId: soda.id, quantity: 2 }] });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(Number(order.body.total), 14.3);
    // An anonymous order must not modify the existing customer record.
    const existing = await prisma.customer.create({ data: { tenantId: A.tenant.id, name: 'Real Name', phone: '11977776666' } });
    const second = await call('POST', `/public/tables/${table.qrToken}/orders`, undefined, { customerName: 'Hacker', customerPhone: '11977776666', marketingConsent: true, items: [{ productId: soda.id, quantity: 1 }] });
    assert.equal(second.status, 201);
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: existing.id } });
    assert.equal(after.name, 'Real Name'); assert.equal(after.marketingConsent, false);
    // Products of another tenant cannot be ordered through this table.
    const foreign = await prisma.product.create({ data: { tenantId: B.tenant.id, name: 'Foreign', price: 1 } });
    assert.equal((await call('POST', `/public/tables/${table.qrToken}/orders`, undefined, { items: [{ productId: foreign.id, quantity: 1 }] })).status, 400);
    // Rotating the QR code invalidates the old link.
    const rotated = (await call('POST', `/tables/${table.id}/rotate-qr`, a)).body;
    assert.notEqual(rotated.qrToken, table.qrToken);
    assert.equal((await call('GET', `/public/tables/${table.qrToken}/menu`)).status, 404);
  });

  await t.test('purchasing receives stock, updates average cost and creates a payable once', async () => {
    const flour = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Farinha', unitOfMeasure: 'kg', currentStock: 10, averageCost: 2 } });
    const supplier = (await call('POST', '/purchasing/suppliers', a, { name: 'Atacado Bom' })).body;
    const purchase = await call('POST', '/purchasing/orders', a, { supplierId: supplier.id, unitId: A.unit.id, items: [{ ingredientId: flour.id, quantity: 10, unitCost: 4 }] });
    assert.equal(purchase.status, 201, JSON.stringify(purchase.body));
    assert.equal(Number(purchase.body.total), 40);
    assert.equal((await call('POST', '/purchasing/orders', b, { supplierId: supplier.id, items: [{ ingredientId: flour.id, quantity: 1, unitCost: 1 }] })).status, 400);
    assert.equal((await call('POST', `/purchasing/orders/${purchase.body.id}/receive`, b)).status, 404);
    const [first, second] = await Promise.all([call('POST', `/purchasing/orders/${purchase.body.id}/receive`, a), call('POST', `/purchasing/orders/${purchase.body.id}/receive`, a)]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const updated = await prisma.ingredient.findUniqueOrThrow({ where: { id: flour.id } });
    assert.equal(updated.currentStock.toString(), '20'); assert.equal(updated.averageCost.toString(), '3');
    assert.equal(await prisma.financialEntry.count({ where: { tenantId: A.tenant.id, reference: purchase.body.id } }), 1);

    const count = await call('POST', '/inventory/counts', a, { lines: [{ ingredientId: flour.id, countedQuantity: 18.5 }] });
    assert.equal(count.status, 201); assert.equal(count.body.adjusted, 1);
    assert.equal((await prisma.ingredient.findUniqueOrThrow({ where: { id: flour.id } })).currentStock.toString(), '18.5');
    assert.equal((await call('POST', '/inventory/counts', b, { lines: [{ ingredientId: flour.id, countedQuantity: 1 }] })).status, 400);
  });

  await t.test('reservations prevent double booking a table', async () => {
    const table = (await call('POST', '/tables', a, { label: 'R1', seats: 4, unitId: A.unit.id })).body;
    const when = new Date(Date.now() + 24 * 3600 * 1000);
    const book = (offsetMin: number, partySize = 2) => call('POST', '/reservations', a, { unitId: A.unit.id, tableId: table.id, customerName: 'Carlos', partySize, reservedAt: new Date(when.getTime() + offsetMin * 60000).toISOString() });
    const first = await book(0); assert.equal(first.status, 201);
    assert.equal((await book(30)).status, 409);
    assert.equal((await book(120)).status, 201);
    assert.equal((await book(300, 9)).status, 400, 'party larger than the table');
    assert.equal((await call('PATCH', `/reservations/${first.body.id}`, b, { status: 'CANCELLED' })).status, 404);
    assert.equal((await call('PATCH', `/reservations/${first.body.id}`, a, { status: 'CANCELLED' })).status, 200);
    assert.equal((await book(30)).status, 201, 'cancelled reservation frees the table');
  });

  await t.test('delivery zones add the delivery fee and enforce minimums', async () => {
    const zone = (await call('POST', '/delivery/zones', a, { name: 'Centro', fee: 7.5, minOrder: 20, unitId: A.unit.id })).body;
    const make = (qty: number, zoneId = zone.id) => call('POST', '/orders', a, { channel: 'DELIVERY', unitId: A.unit.id, deliveryZoneId: zoneId, items: [{ productId: burger.id, quantity: qty }] });
    const ok = await make(1); assert.equal(ok.status, 201); assert.equal(Number(ok.body.total), 37.5);
    assert.equal((await call('POST', '/orders', a, { channel: 'POS', deliveryZoneId: zone.id, items: [{ productId: soda.id, quantity: 9 }] })).status, 400);
    assert.equal((await call('POST', '/orders', b, { channel: 'DELIVERY', deliveryZoneId: zone.id, items: [{ productId: soda.id, quantity: 1 }] })).status, 400);
  });

  await t.test('modifiers enforce selection rules, add to price and print on their own sector', async () => {
    const bar = (await call('POST', '/production/sectors', a, { name: 'Bar', autoPrint: true, unitId: A.unit.id })).body;
    assert.equal((await call('POST', '/printing/printers', a, { name: 'Bar 1', connectionType: 'NETWORK', address: '192.168.0.60', sectorId: bar.id, isPrimary: true, unitId: A.unit.id })).status, 201);
    const group = await call('POST', '/catalog/modifier-groups', a, { name: 'Extras', minSelect: 0, maxSelect: 2, options: [{ name: 'Bacon', price: 4 }, { name: 'Dose de whisky', price: 12, sectorId: bar.id }] });
    assert.equal(group.status, 201, JSON.stringify(group.body));
    const [bacon, whisky] = group.body.options.sort((x: any, y: any) => x.name.localeCompare(y.name));
    assert.equal((await call('POST', '/catalog/modifier-groups', b, { name: 'X', options: [{ name: 'Y', sectorId: bar.id }] })).status, 400, 'foreign sector');
    assert.equal((await call('PUT', `/catalog/products/${burger.id}/modifier-groups`, b, { groupIds: [group.body.id] })).status, 404);
    assert.equal((await call('PUT', `/catalog/products/${burger.id}/modifier-groups`, a, { groupIds: [group.body.id] })).status, 200);

    const make = (modifiers: unknown) => call('POST', '/orders', a, { unitId: A.unit.id, items: [{ productId: burger.id, quantity: 2, modifiers }] });
    assert.equal((await make([{ optionId: bacon.id, quantity: 3 }])).status, 400, 'more than maxSelect');
    const foreignGroup = await call('POST', '/catalog/modifier-groups', b, { name: 'Outros', options: [{ name: 'Foreign opt' }] });
    assert.equal((await make([{ optionId: foreignGroup.body.options[0].id }])).status, 400, 'option from another tenant');
    const ok = await make([{ optionId: bacon.id }, { optionId: whisky.id }]);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(Number(ok.body.total), (30 + 4 + 12) * 2);
    const jobs = (await call('GET', '/printing/jobs', a)).body.items.filter((job: any) => job.orderId === ok.body.id);
    assert.equal(jobs.length, 2);
    const kitchen = jobs.find((job: any) => job.sectorId === sector.id).content; const barTicket = jobs.find((job: any) => job.sectorId === bar.id).content;
    assert.match(kitchen, /2x X-Burger/); assert.match(kitchen, /\+ 1x Bacon/); assert.doesNotMatch(kitchen, /whisky/);
    assert.match(barTicket, /2x Dose de whisky/); assert.match(barTicket, /para X-Burger/);

    // required group
    assert.equal((await call('PATCH', `/catalog/modifier-groups/${group.body.id}`, a, { minSelect: 1 })).status, 200);
    assert.equal((await make([])).status, 400, 'required group left empty');
  });

  await t.test('combos bill once and send components to their own sectors', async () => {
    const drinkSector = (await call('POST', '/production/sectors', a, { name: 'Bebidas', autoPrint: true, unitId: A.unit.id })).body;
    assert.equal((await call('POST', '/printing/printers', a, { name: 'Bebidas 1', connectionType: 'NETWORK', address: '192.168.0.61', sectorId: drinkSector.id, isPrimary: true, unitId: A.unit.id })).status, 201);
    const cola = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Cola 350', price: 5, sectorId: drinkSector.id } });
    const plain = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Burger simples', price: 20, sectorId: sector.id } });
    const combo = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Combo 1', price: 22 } });
    assert.equal((await call('PUT', `/catalog/products/${combo.id}/combo`, b, { components: [{ productId: plain.id }] })).status, 404);
    assert.equal((await call('PUT', `/catalog/products/${combo.id}/combo`, a, { components: [{ productId: plain.id, quantity: 1 }, { productId: cola.id, quantity: 1 }] })).status, 200);
    assert.equal((await call('PUT', `/catalog/products/${plain.id}/combo`, a, { components: [{ productId: cola.id }] })).status, 409, 'component cannot become a combo');
    const order = await call('POST', '/orders', a, { unitId: A.unit.id, items: [{ productId: combo.id, quantity: 2 }] });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal(Number(order.body.total), 44);
    assert.equal(order.body.items.length, 3);
    const jobs = (await call('GET', '/printing/jobs', a)).body.items.filter((job: any) => job.orderId === order.body.id);
    assert.deepEqual(jobs.map((job: any) => job.sectorId).sort(), [sector.id, drinkSector.id].sort());
    assert.match(jobs.find((job: any) => job.sectorId === drinkSector.id).content, /2x Cola 350/);
    const kds = (await call('GET', '/production/kds', a)).body.items.filter((item: any) => item.orderId === order.body.id);
    assert.equal(kds.length, 2, 'the billing wrapper line is not shown on the KDS');
  });

  await t.test('waiter report attributes completed sales and service fee to the creator', async () => {
    const table = (await call('POST', '/tables', a, { label: 'W1', seats: 2, unitId: A.unit.id })).body;
    const waiter = A.actors.WAITER!;
    const order = await call('POST', '/orders', waiter.token, { channel: 'TABLE', tableId: table.id, unitId: A.unit.id, items: [{ productId: soda.id, quantity: 4 }] });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, a, { status })).status, 200);
    const report = await call('GET', '/reports/waiters', a);
    assert.equal(report.status, 200);
    const mine = report.body.items.find((row: any) => row.name === 'WAITER');
    assert.equal(mine.orders, 1); assert.equal(Number(mine.serviceFee), 2.6);
    assert.equal((await call('GET', '/reports/waiters', waiter.token)).status, 403);
    assert.equal((await call('GET', '/reports/waiters', b)).body.items.some((row: any) => row.name === 'WAITER' && row.orders > 1), false);
  });

  await t.test('cancelling an order restores stock and coupon use, and requires refunding payments first', async () => {
    const cheese = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Queijo', unitOfMeasure: 'kg', currentStock: 10, averageCost: 30 } });
    const patty = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Blend', unitOfMeasure: 'kg', currentStock: 10, averageCost: 40 } });
    const dish = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Prato Estoque', price: 50, sectorId: sector.id } });
    assert.equal((await call('PUT', `/inventory/recipes/${dish.id}`, a, { yield: 1, ingredients: [{ ingredientId: patty.id, quantity: 0.2 }] })).status, 200);
    // modifier option that consumes its own ingredient
    const group = await call('POST', '/catalog/modifier-groups', a, { name: 'Queijo extra', maxSelect: 2, options: [{ name: 'Extra cheddar', price: 3, ingredientId: cheese.id, ingredientQuantity: 0.05 }] });
    assert.equal(group.status, 201, JSON.stringify(group.body));
    assert.equal((await call('POST', '/catalog/modifier-groups', a, { name: 'Ruim', options: [{ name: 'x', ingredientId: cheese.id }] })).status, 400, 'ingredient without quantity');
    assert.equal((await call('POST', '/catalog/modifier-groups', b, { name: 'Estrangeiro', options: [{ name: 'y', ingredientId: cheese.id, ingredientQuantity: 1 }] })).status, 400, 'foreign ingredient');
    assert.equal((await call('PUT', `/catalog/products/${dish.id}/modifier-groups`, a, { groupIds: [group.body.id] })).status, 200);
    assert.equal((await call('POST', '/coupons', a, { code: 'BACK5', type: 'FIXED', value: 5 })).status, 201);

    const order = await call('POST', '/orders', a, { unitId: A.unit.id, couponCode: 'BACK5', items: [{ productId: dish.id, quantity: 2, modifiers: [{ optionId: group.body.options[0].id, quantity: 2 }] }] });
    assert.equal(order.status, 201, JSON.stringify(order.body));
    assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, a, { status: 'PREPARING' })).status, 200);
    const stock = async (id: string) => (await prisma.ingredient.findUniqueOrThrow({ where: { id } })).currentStock.toString();
    assert.equal(await stock(patty.id), '9.6'); assert.equal(await stock(cheese.id), '9.8');
    assert.equal((await prisma.coupon.findFirstOrThrow({ where: { tenantId: A.tenant.id, code: 'BACK5' } })).usedCount, 1);

    const payment = await call('POST', '/cash/payments', a, { orderId: order.body.id, method: 'PIX', amount: 10 });
    assert.equal(payment.status, 201);
    assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, a, { status: 'CANCELLED' })).status, 409, 'confirmed payment blocks cancellation');
    assert.equal((await call('POST', `/cash/payments/${payment.body.payment.id}/refund`, A.actors.WAITER!.token)).status, 403);
    assert.equal((await call('POST', `/cash/payments/${payment.body.payment.id}/refund`, a)).status, 204);
    assert.equal((await call('POST', `/cash/payments/${payment.body.payment.id}/refund`, a)).status, 409, 'cannot refund twice');
    assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, a, { status: 'CANCELLED' })).status, 200);
    assert.equal(await stock(patty.id), '10'); assert.equal(await stock(cheese.id), '10');
    assert.equal((await prisma.coupon.findFirstOrThrow({ where: { tenantId: A.tenant.id, code: 'BACK5' } })).usedCount, 0);
    assert.equal(await prisma.stockMovement.count({ where: { tenantId: A.tenant.id, reference: order.body.id, type: 'ORDER_REVERSAL' } }), 2);
  });

  await t.test('stock transfers move quantity and cost atomically', async () => {
    const unit2 = await prisma.unit.create({ data: { tenantId: A.tenant.id, name: 'Filial' } });
    const src = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, name: 'Arroz', unitOfMeasure: 'kg', currentStock: 20, averageCost: 6 } });
    const dst = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, unitId: unit2.id, name: 'Arroz', unitOfMeasure: 'kg', currentStock: 10, averageCost: 3 } });
    const other = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, unitId: unit2.id, name: 'Óleo', unitOfMeasure: 'l', currentStock: 1 } });
    const transfer = (body: unknown, token = a) => call('POST', '/inventory/transfers', token, body);
    assert.equal((await transfer({ fromIngredientId: src.id, toIngredientId: dst.id, quantity: 25 })).status, 409);
    assert.equal((await transfer({ fromIngredientId: src.id, toIngredientId: other.id, quantity: 1 })).status, 400, 'different units of measure');
    assert.equal((await transfer({ fromIngredientId: src.id, toIngredientId: dst.id, quantity: 10 }, b)).status, 404, 'other tenant');
    assert.equal((await transfer({ fromIngredientId: src.id, toIngredientId: dst.id, quantity: 10 })).status, 201);
    const [s1, d1] = await Promise.all([prisma.ingredient.findUniqueOrThrow({ where: { id: src.id } }), prisma.ingredient.findUniqueOrThrow({ where: { id: dst.id } })]);
    assert.equal(s1.currentStock.toString(), '10'); assert.equal(d1.currentStock.toString(), '20'); assert.equal(d1.averageCost.toString(), '4.5');
    assert.equal(await prisma.stockMovement.count({ where: { tenantId: A.tenant.id, type: { in: ['TRANSFER_IN', 'TRANSFER_OUT'] } } }), 2);
  });

  await t.test('shifts reject overlaps and are tenant scoped', async () => {
    const employee = await prisma.employee.create({ data: { tenantId: A.tenant.id, fullName: 'Ana', unitId: A.unit.id } });
    const start = new Date(Date.now() + 48 * 3600 * 1000);
    const at = (h: number) => new Date(start.getTime() + h * 3600 * 1000).toISOString();
    const make = (from: number, to: number, token = a) => call('POST', '/shifts', token, { employeeId: employee.id, unitId: A.unit.id, startsAt: at(from), endsAt: at(to) });
    const first = await make(0, 8); assert.equal(first.status, 201);
    assert.equal((await make(6, 10)).status, 409);
    assert.equal((await make(8, 12)).status, 201, 'back-to-back shifts are fine');
    assert.equal((await make(20, 50)).status, 400, 'longer than 16h');
    assert.equal((await make(30, 32, b)).status, 400, 'employee of another tenant');
    assert.equal((await make(30, 32, A.actors.WAITER!.token)).status, 403);
    assert.equal((await call('PATCH', `/shifts/${first.body.id}`, a, { endsAt: at(9) })).status, 409, 'extending into the next shift');
    assert.equal((await call('GET', '/shifts', A.actors.WAITER!.token)).status, 200);
    assert.equal((await call('DELETE', `/shifts/${first.body.id}`, b)).status, 404);
    assert.equal((await call('DELETE', `/shifts/${first.body.id}`, a)).status, 204);
  });

  await t.test('user management respects privilege levels', async () => {
    const manager = A.actors.MANAGER!.token; const base = { password: 'long-enough-pass', unitId: A.unit.id };
    const email = (n: string) => `${n}-${suffix()}@test.local`;
    assert.equal((await call('POST', '/users', manager, { ...base, name: 'Novo Admin', email: email('adm'), role: 'ADMIN' })).status, 403);
    assert.equal((await call('POST', '/users', manager, { ...base, password: 'short', name: 'Fraco', email: email('weak'), role: 'WAITER' })).status, 400);
    const waiter = await call('POST', '/users', manager, { ...base, name: 'Gar Com', email: email('w'), role: 'WAITER', commissionPercent: 2 });
    assert.equal(waiter.status, 201); assert.equal(waiter.body.passwordHash, undefined);
    assert.equal((await call('POST', '/users', manager, { ...base, name: 'Dup', email: waiter.body.email, role: 'WAITER' })).status, 409);
    assert.equal((await call('POST', '/users', manager, { ...base, name: 'Cross', email: email('c'), role: 'WAITER', unitId: (await prisma.unit.create({ data: { tenantId: B.tenant.id, name: 'X' } })).id })).status, 400);
    assert.equal((await call('PATCH', `/users/${waiter.body.id}`, manager, { role: 'MANAGER' })).status, 403);
    assert.equal((await call('PATCH', `/users/${waiter.body.id}`, a, { status: 'INACTIVE' })).status, 200);
    assert.equal((await call('PATCH', `/users/${waiter.body.id}`, b, { status: 'ACTIVE' })).status, 404);
    const self = await prisma.user.findFirstOrThrow({ where: { tenantId: A.tenant.id, role: 'ADMIN' } });
    assert.equal((await call('PATCH', `/users/${self.id}`, a, { role: 'WAITER' })).status, 409, 'no self-demotion');
    assert.equal((await call('GET', '/users', A.actors.WAITER!.token)).status, 403);
    assert.equal((await call('GET', '/users', b)).body.items.some((u: any) => u.id === waiter.body.id), false);
  });

  await t.test('service fee distribution uses the waiter share and commission rates', async () => {
    await prisma.unit.update({ where: { id: A.unit.id }, data: { waiterSharePercent: 70 } });
    const waiter = A.actors.WAITER!;
    const waiterUser = await prisma.user.findFirstOrThrow({ where: { tenantId: A.tenant.id, role: 'WAITER', email: { startsWith: 'WAITER-' } } });
    await prisma.user.update({ where: { id: waiterUser.id }, data: { commissionPercent: 5 } });
    const table = (await call('POST', '/tables', a, { label: 'D1', seats: 2, unitId: A.unit.id })).body;
    const order = await call('POST', '/orders', waiter.token, { channel: 'TABLE', tableId: table.id, unitId: A.unit.id, items: [{ productId: soda.id, quantity: 10 }] });
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, a, { status })).status, 200);
    const report = (await call('GET', '/reports/service-fee-distribution', a)).body;
    const mine = report.items.find((row: any) => row.userId === waiterUser.id);
    // 10 x 6.50 = 65.00; fee 10% = 6.50; waiter 70% = 4.55; pool 1.95; commission 5% of 65 = 3.25
    assert.equal(Number(mine.serviceFeeCollected) >= 6.5, true);
    assert.equal(Number(mine.waiterAmount) >= 4.55, true);
    assert.equal(Number(mine.commission) >= 3.25, true);
    assert.equal(Number((Number(mine.waiterAmount) + Number(mine.poolAmount)).toFixed(2)), Number(Number(mine.serviceFeeCollected).toFixed(2)));
    assert.equal((await call('GET', '/reports/service-fee-distribution', waiter.token)).status, 403);
    assert.equal((await call('PATCH', `/units/${A.unit.id}`, a, { serviceFeePercent: 12.5, waiterSharePercent: 80 })).status, 200);
    assert.equal((await call('PATCH', `/units/${A.unit.id}`, a, { waiterSharePercent: 120 })).status, 400);
  });

  await t.test('payment charges require a configured provider and settle through signed webhooks', async () => {
    const order = await call('POST', '/orders', a, { unitId: A.unit.id, items: [{ productId: soda.id, quantity: 2 }] });
    const charge = (token = a) => call('POST', '/payments/charges', token, { orderId: order.body.id, provider: 'fakepix', method: 'PIX' });
    assert.equal((await charge()).status, 501, 'no provider registered yet');
    let seq = 0;
    paymentProviders.register({
      name: 'fakepix',
      createCharge: async ({ amount }) => ({ externalRef: `ext-${++seq}-${amount}`, qrPayload: '000201...' }),
      parseWebhook: (headers, raw) => (headers['x-signature'] === 'valid' ? JSON.parse(raw.toString()) : null),
    });
    t.after(() => paymentProviders.clear());
    assert.equal((await charge(A.actors.KITCHEN!.token)).status, 403);
    assert.equal((await charge(b)).status, 404);
    const created = await charge(); assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(Number(created.body.amount), 13); assert.equal(created.body.status, 'PENDING');
    assert.equal((await charge()).status, 409, 'balance already reserved by the pending charge');
    const hook = (signature: string, body: unknown, provider = 'fakepix') => fetch(`${base}/payments/webhook/${provider}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() as any }));
    assert.equal((await hook('forged', { externalRef: created.body.externalRef, status: 'PAID' })).status, 400);
    assert.equal((await hook('valid', { externalRef: created.body.externalRef, status: 'PAID' }, 'nope')).status, 404);
    assert.equal((await hook('valid', { externalRef: created.body.externalRef, status: 'PAID' })).body.result, 'paid');
    assert.equal((await hook('valid', { externalRef: created.body.externalRef, status: 'PAID' })).body.result, 'duplicate');
    assert.equal(await prisma.payment.count({ where: { tenantId: A.tenant.id, orderId: order.body.id, status: 'CONFIRMED' } }), 1);
    assert.equal((await charge()).status, 409, 'order is fully paid');
    assert.equal((await hook('valid', { externalRef: 'never-created', status: 'PAID' })).body.result, 'unknown');
  });

  await t.test('fiscal emission needs a provider and a completed order', async () => {
    const order = await call('POST', '/orders', a, { unitId: A.unit.id, items: [{ productId: soda.id, quantity: 1 }] });
    const emit = (token = a) => call('POST', `/fiscal/orders/${order.body.id}/emit`, token, { provider: 'fakefisc' });
    assert.equal((await emit()).status, 501);
    let outcome: 'AUTHORIZED' | 'REJECTED' = 'REJECTED';
    fiscalProviders.register({ name: 'fakefisc', emit: async () => ({ status: outcome, number: '123', accessKey: 'K'.repeat(44), error: outcome === 'REJECTED' ? 'CNPJ inválido' : undefined }), cancel: async () => ({ cancelled: true }) });
    t.after(() => fiscalProviders.clear());
    assert.equal((await emit()).status, 409, 'order is not completed');
    for (const status of ['PREPARING', 'READY', 'COMPLETED']) await call('PATCH', `/orders/${order.body.id}/status`, a, { status });
    assert.equal((await emit(A.actors.WAITER!.token)).status, 403);
    assert.equal((await emit(b)).status, 404);
    const rejected = await emit(); assert.equal(rejected.status, 422); assert.equal(rejected.body.status, 'REJECTED');
    outcome = 'AUTHORIZED';
    const ok = await emit(); assert.equal(ok.status, 201); assert.equal(ok.body.number, '123');
    assert.equal((await emit()).status, 409, 'already authorized');
    assert.equal((await call('POST', `/fiscal/documents/${ok.body.id}/cancel`, a, { reason: 'curto' })).status, 400);
    assert.equal((await call('POST', `/fiscal/documents/${ok.body.id}/cancel`, b, { reason: 'Erro de digitação no pedido' })).status, 404);
    assert.equal((await call('POST', `/fiscal/documents/${ok.body.id}/cancel`, a, { reason: 'Erro de digitação no pedido' })).body.status, 'CANCELLED');
  });

  await t.test('marketplace orders enter through scoped integration keys, idempotently', async () => {
    await prisma.product.update({ where: { id: soda.id }, data: { code: 'SD-01' } });
    const integration = await call('POST', '/integrations', a, { provider: 'ifood', name: 'iFood Matriz', unitId: A.unit.id });
    assert.equal(integration.status, 201); assert.match(integration.body.key, /^rmint_/);
    assert.equal((await call('POST', '/integrations', A.actors.WAITER!.token, { provider: 'ifood', name: 'x', unitId: A.unit.id })).status, 403);
    assert.equal((await call('POST', '/integrations', b, { provider: 'ifood', name: 'x', unitId: A.unit.id })).status, 400);
    const send = (key: string | undefined, body: unknown, source = 'ifood') => call('POST', `/inbound/${source}/orders`, key, body);
    const payload = { externalId: 'IF-1', customer: { name: 'Pedro', phone: '11955554444' }, address: 'Rua A, 10', deliveryFee: 6, items: [{ code: 'SD-01', quantity: 2 }] };
    assert.equal((await send(undefined, payload)).status, 401);
    assert.equal((await send(a, payload)).status, 401, 'user JWT is not an integration key');
    assert.equal((await send(integration.body.key, payload, 'rappi')).status, 401, 'key bound to its provider');
    assert.equal((await send(integration.body.key, { ...payload, items: [{ code: 'NOPE', quantity: 1 }] })).status, 422);
    const first = await send(integration.body.key, payload);
    assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(Number(first.body.total), 19);
    const again = await send(integration.body.key, payload);
    assert.equal(again.status, 200); assert.equal(again.body.duplicate, true); assert.equal(again.body.orderId, first.body.orderId);
    const job = await prisma.deliveryJob.findUniqueOrThrow({ where: { orderId: first.body.orderId } });
    assert.equal(job.provider, 'ifood'); assert.equal(job.address, 'Rua A, 10');
    assert.equal((await call('PATCH', `/integrations/${integration.body.id}`, a, { active: false })).status, 200);
    assert.equal((await send(integration.body.key, { ...payload, externalId: 'IF-2' })).status, 401, 'revoked key');
  });
});

