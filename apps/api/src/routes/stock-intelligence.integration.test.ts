import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('stock intelligence: limits, expiry, inventory sessions, suggestions, receiving conference and price comparison', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'h'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };
  const id = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE' } });
    const token = async (role: UserRole) => {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${id}@test.local`, passwordHash: 'x', role } });
      return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    };
    return { tenant, token };
  };
  const A = await makeTenant('stock'); const B = await makeTenant('stockother');
  const admin = await A.token(UserRole.ADMIN); const kitchen = await A.token(UserRole.KITCHEN); const otherAdmin = await B.token(UserRole.ADMIN);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    // PurchaseItem -> Ingredient is RESTRICT, so purchases go first (same order the other suites use).
    await prisma.purchaseOrder.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.inventoryCount.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });
  const create = async (body: Record<string, unknown>) => { const result = await call('POST', '/inventory/ingredients', admin, body); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body as { id: string }; };

  const flour = await create({ name: 'Farinha de trigo', unitOfMeasure: 'kg', currentStock: 10, minimumStock: 5, maximumStock: 30, category: 'Secos', averageCost: 4 });
  const cheese = await create({ name: 'Queijo mussarela', unitOfMeasure: 'kg', currentStock: 2, minimumStock: 4, category: 'Frios', averageCost: 30 });
  const oil = await create({ name: 'Óleo de soja', unitOfMeasure: 'l', currentStock: 8, category: 'Secos', averageCost: 7 });

  await t.test('limits, category and expiry are validated and edited with an audit trail', async () => {
    assert.equal((await call('POST', '/inventory/ingredients', admin, { name: 'Sal', unitOfMeasure: 'kg', minimumStock: 5, maximumStock: 2 })).status, 400, 'maximum below minimum');
    assert.equal((await call('PATCH', `/inventory/ingredients/${flour.id}`, kitchen, { minimumStock: 6 })).status, 403, 'only management edits');
    assert.equal((await call('PATCH', `/inventory/ingredients/${flour.id}`, otherAdmin, { minimumStock: 6 })).status, 404, 'tenant isolation');
    assert.equal((await call('PATCH', `/inventory/ingredients/${flour.id}`, admin, { maximumStock: 1 })).status, 400);
    const edited = await call('PATCH', `/inventory/ingredients/${flour.id}`, admin, { minimumStock: 6, expiresAt: '2030-01-15' });
    assert.equal(edited.status, 200);
    assert.equal(Number(edited.body.minimumStock), 6);
    const log = await prisma.auditLog.findFirst({ where: { tenantId: A.tenant.id, action: 'INGREDIENT_UPDATED', entityId: flour.id } });
    assert.equal((log!.metadata as any).before.minimumStock, '5', 'previous value is kept');
  });

  await t.test('losses and adjustments need a justification; the reason is stored and reported', async () => {
    assert.equal((await call('POST', `/inventory/ingredients/${oil.id}/movements`, admin, { type: 'WASTE', quantity: 1 })).status, 400);
    assert.equal((await call('POST', `/inventory/ingredients/${oil.id}/movements`, admin, { type: 'ADJUSTMENT', quantity: 1, note: 'x' })).status, 400);
    const waste = await call('POST', `/inventory/ingredients/${oil.id}/movements`, admin, { type: 'WASTE', quantity: 1, reason: 'EXPIRED', note: 'Lote vencido' });
    assert.equal(waste.status, 201, JSON.stringify(waste.body));
    assert.equal(waste.body.movement.reason, 'EXPIRED');
    const report = await call('GET', '/profit/waste', admin);
    assert.equal(report.body.byCategory.some((row: any) => row.name === 'Vencido'), true);
  });

  await t.test('expiry follows the stock on the shelf', async () => {
    const later = await call('POST', `/inventory/ingredients/${flour.id}/movements`, admin, { type: 'PURCHASE', quantity: 5, expiresAt: '2031-06-01' });
    assert.equal(later.body.ingredient.expiresAt.slice(0, 10), '2030-01-15', 'a later batch does not postpone the earlier expiry');
    const earlier = await call('POST', `/inventory/ingredients/${flour.id}/movements`, admin, { type: 'PURCHASE', quantity: 1, expiresAt: '2029-12-01' });
    assert.equal(earlier.body.ingredient.expiresAt.slice(0, 10), '2029-12-01');
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await call('PATCH', `/inventory/ingredients/${cheese.id}`, admin, { expiresAt: soon });
    const expiring = await call('GET', '/inventory/expiring?days=7', kitchen);
    assert.deepEqual(expiring.body.items.map((item: any) => [item.name, item.state]), [['Queijo mussarela', 'EXPIRING']]);
    const drained = await call('POST', `/inventory/ingredients/${cheese.id}/movements`, admin, { type: 'WASTE', quantity: 2, reason: 'EXPIRED', note: 'Descartado' });
    assert.equal(drained.body.ingredient.expiresAt, null, 'an empty shelf has no expiry');
    await prisma.ingredient.update({ where: { id: cheese.id }, data: { currentStock: 2 } });
  });

  let sessionId = '';
  await t.test('inventory sessions: scope, history, permissions, closing adjusts only counted lines', async () => {
    assert.equal((await call('POST', '/inventory/count-sessions', admin, { title: 'Categoria', scope: 'CATEGORY' })).status, 400, 'category scope needs a category');
    assert.equal((await call('POST', '/inventory/count-sessions', admin, { title: 'Parcial', scope: 'PARTIAL', ingredientIds: [] })).status, 400);
    const opened = await call('POST', '/inventory/count-sessions', admin, { title: 'Contagem de secos', scope: 'CATEGORY', category: 'Secos' });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    sessionId = opened.body.id;
    assert.deepEqual(opened.body.lines.map((line: any) => line.name).sort(), ['Farinha de trigo', 'Óleo de soja']);
    assert.equal((await call('POST', '/inventory/count-sessions', admin, { title: 'Outra', scope: 'FULL' })).status, 409, 'one open inventory per unit');
    assert.equal((await call('GET', `/inventory/count-sessions/${sessionId}`, otherAdmin)).status, 404, 'tenant isolation');
    const flourStock = Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: flour.id } })).currentStock);
    assert.equal((await call('PUT', `/inventory/count-sessions/${sessionId}/lines`, admin, { lines: [{ ingredientId: flour.id, counted: flourStock - 2.5 }] })).body.saved, 1);
    // a sale during the count: the adjustment is relative to the stock at closing time
    await prisma.ingredient.update({ where: { id: flour.id }, data: { currentStock: { decrement: 1 } } });
    assert.equal((await call('POST', `/inventory/count-sessions/${sessionId}/close`, kitchen)).status, 403);
    const closed = await call('POST', `/inventory/count-sessions/${sessionId}/close`, admin);
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual([closed.body.counted, closed.body.uncounted, closed.body.adjusted], [1, 1, 1]);
    assert.equal(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: flour.id } })).currentStock), flourStock - 2.5, 'stock equals the physical count');
    assert.equal(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: oil.id } })).currentStock), 7, 'uncounted items are untouched');
    const movement = await prisma.stockMovement.findFirstOrThrow({ where: { reference: sessionId } });
    assert.equal(movement.type, 'ADJUSTMENT');
    assert.equal(Number(movement.quantity), -1.5, 'counted - stock at closing');
    assert.equal((await call('POST', `/inventory/count-sessions/${sessionId}/close`, admin)).status, 409);
    assert.equal((await call('PUT', `/inventory/count-sessions/${sessionId}/lines`, admin, { lines: [{ ingredientId: flour.id, counted: 1 }] })).status, 409, 'closed sessions are locked');
    const history = await call('GET', '/inventory/count-sessions', admin);
    const row = history.body.items.find((item: any) => item.id === sessionId);
    assert.deepEqual([row.status, row.lineCount, row.countedCount, row.adjustedCount, Number(row.adjustmentValue)], ['CLOSED', 2, 1, 1, -6]);
    const partial = await call('POST', '/inventory/count-sessions', admin, { title: 'Só queijo', scope: 'PARTIAL', ingredientIds: [cheese.id] });
    assert.equal(partial.status, 201);
    assert.equal((await call('POST', `/inventory/count-sessions/${partial.body.id}/close`, admin)).status, 400, 'nothing counted yet');
    assert.equal((await call('POST', `/inventory/count-sessions/${partial.body.id}/cancel`, admin)).status, 204);
  });

  const supplierA = await prisma.supplier.create({ data: { tenantId: A.tenant.id, name: 'Atacado A' } });
  const supplierB = await prisma.supplier.create({ data: { tenantId: A.tenant.id, name: 'Distribuidor B' } });
  const order = async (supplierId: string, items: { ingredientId: string; quantity: number; unitCost: number }[]) => {
    const created = await call('POST', '/purchasing/orders', admin, { supplierId, items });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body as { id: string; items: { id: string; ingredientId: string }[] };
  };

  await t.test('receiving conference: real quantities and prices, divergences, payable by the received value', async () => {
    const purchase = await order(supplierA.id, [{ ingredientId: flour.id, quantity: 10, unitCost: 4 }, { ingredientId: cheese.id, quantity: 4, unitCost: 30 }]);
    const flourItem = purchase.items.find(item => item.ingredientId === flour.id)!; const cheeseItem = purchase.items.find(item => item.ingredientId === cheese.id)!;
    assert.equal((await call('POST', `/purchasing/orders/${purchase.id}/receive`, kitchen, {})).status, 403);
    assert.equal((await call('POST', `/purchasing/orders/${purchase.id}/receive`, admin, { lines: [{ itemId: '00000000-0000-4000-8000-000000000000', receivedQuantity: 1 }] })).status, 400, 'foreign line');
    const before = Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: flour.id } })).currentStock);
    const received = await call('POST', `/purchasing/orders/${purchase.id}/receive`, admin, { note: 'NF 123', lines: [{ itemId: flourItem.id, receivedQuantity: 8, receivedUnitCost: 4, expiresAt: '2028-05-01' }, { itemId: cheeseItem.id, receivedQuantity: 4, receivedUnitCost: 32.5 }] });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.deepEqual(received.body.conference.divergences.map((item: any) => item.kind), ['SHORT', 'PRICE_UP']);
    assert.equal(received.body.conference.orderedTotal, 160);
    assert.equal(received.body.conference.receivedTotal, 162, '8 x 4 + 4 x 32.5');
    assert.equal(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: flour.id } })).currentStock), before + 8, 'stock follows what arrived');
    const entry = await prisma.financialEntry.findFirstOrThrow({ where: { tenantId: A.tenant.id, reference: purchase.id } });
    assert.equal(Number(entry.amount), 162, 'the payable is the received value');
    assert.equal((await call('POST', `/purchasing/orders/${purchase.id}/receive`, admin, {})).status, 409, 'cannot receive twice');
    const conference = await call('GET', `/purchasing/orders/${purchase.id}/conference`, admin);
    assert.equal(conference.body.result.divergences.length, 2);
    assert.equal(conference.body.purchase.receivedTotal, '162');
  });

  await t.test('legacy receiving without a body still receives everything as ordered', async () => {
    const purchase = await order(supplierB.id, [{ ingredientId: flour.id, quantity: 5, unitCost: 3.5 }]);
    const received = await call('POST', `/purchasing/orders/${purchase.id}/receive`, admin);
    assert.equal(received.status, 200);
    assert.equal(received.body.conference.divergences.length, 0);
    assert.equal(Number((await prisma.financialEntry.findFirstOrThrow({ where: { tenantId: A.tenant.id, reference: purchase.id } })).amount), 17.5);
  });

  await t.test('supplier price comparison ranks real received prices', async () => {
    const comparison = await call('GET', `/purchasing/price-comparison?ingredientId=${flour.id}`, admin);
    assert.equal(comparison.status, 200);
    assert.deepEqual(comparison.body.suppliers.map((row: any) => [row.supplierName, row.lastCost, row.vsBest]), [['Distribuidor B', 3.5, 0], ['Atacado A', 4, 14.29]]);
    assert.equal((await call('GET', `/purchasing/price-comparison?ingredientId=${flour.id}`, otherAdmin)).status, 404);
    assert.equal((await call('GET', `/purchasing/price-comparison?ingredientId=${flour.id}`, kitchen)).status, 403);
  });

  await t.test('conference pairs ordered lines with the imported supplier XML by name', async () => {
    const invoice = await prisma.receivedInvoice.create({ data: { tenantId: A.tenant.id, accessKey: `${Date.now()}`.padEnd(44, '0'), number: '99', supplierName: 'Atacado A', issuedAt: new Date(), totalAmount: 50, items: [{ description: 'FARINHA DE TRIGO TIPO 1', quantity: 12, unitValue: 4.1 }, { description: 'Detergente', quantity: 1, unitValue: 2 }] } });
    const purchase = await order(supplierA.id, [{ ingredientId: flour.id, quantity: 12, unitCost: 4 }]);
    const preview = await call('GET', `/purchasing/orders/${purchase.id}/conference?invoiceId=${invoice.id}`, admin);
    assert.equal(preview.body.lines[0].invoiceMatch.quantity, 12);
    assert.equal(preview.body.lines[0].invoiceMatch.unitValue, 4.1);
    assert.equal((await call('GET', `/purchasing/orders/${purchase.id}/conference?invoiceId=${invoice.id}`, otherAdmin)).status, 404);
    assert.equal((await call('POST', `/purchasing/orders/${purchase.id}/receive`, admin, { invoiceId: '00000000-0000-4000-8000-000000000000' })).status, 400, 'unknown invoice');
    assert.equal((await call('POST', `/purchasing/orders/${purchase.id}/receive`, admin, { invoiceId: invoice.id })).status, 200);
    assert.equal((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: purchase.id } })).receivedInvoiceId, invoice.id);
  });

  await t.test('purchase suggestions use limits, real consumption and the last supplier', async () => {
    await prisma.ingredient.update({ where: { id: cheese.id }, data: { currentStock: 1, maximumStock: 10 } });
    await prisma.stockMovement.create({ data: { tenantId: A.tenant.id, ingredientId: cheese.id, type: 'ORDER_CONSUMPTION', quantity: -9 } });
    const suggestions = await call('GET', '/inventory/suggestions', kitchen);
    assert.equal(suggestions.status, 200);
    const row = suggestions.body.items.find((item: any) => item.name === 'Queijo mussarela');
    assert.deepEqual([row.reason, row.target, row.quantity, row.supplier.name], ['BELOW_MINIMUM', 10, 9, 'Atacado A']);
    assert.equal(row.estimatedCost, Math.round(9 * Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: cheese.id } })).averageCost) * 100) / 100);
    assert.equal(suggestions.body.items.some((item: any) => item.name === 'Farinha de trigo'), false, 'well stocked items are not suggested');
    assert.equal((await call('GET', '/inventory/suggestions', otherAdmin)).body.items.length, 0, 'tenant isolation');
    const history = await call('GET', `/inventory/ingredients/${flour.id}/cost-history`, admin);
    assert.ok(history.body.history.length >= 3);
    assert.equal((await call('GET', `/inventory/ingredients/${flour.id}/cost-history`, otherAdmin)).status, 404);
  });
});
