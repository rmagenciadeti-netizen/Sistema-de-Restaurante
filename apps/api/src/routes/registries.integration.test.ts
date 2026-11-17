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

async function createTenant() {
  const id = suffix();
  const tenant = await prisma.tenant.create({ data: { name: `Reg ${id}`, slug: `reg-${id}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
  const token = async (role: UserRole) => {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${id}@test.local`, passwordHash: 'x', role } });
    return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
  };
  return { tenant, unit, admin: await token(UserRole.ADMIN), waiter: await token(UserRole.WAITER), cashier: await token(UserRole.CASHIER) };
}

test('auxiliary registries', { skip: !enabled }, async t => {
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
  const A = await createTenant();
  const B = await createTenant();
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  await t.test('couriers are tenant-scoped, searchable and write-protected', async () => {
    const created = await call('POST', '/couriers', A.admin, { name: 'Carlos Moto', phone: '11999990000' });
    assert.equal(created.status, 201);
    assert.equal((await call('POST', '/couriers', A.waiter, { name: 'Sem permissão' })).status, 403);
    assert.equal((await call('GET', '/couriers?q=carlos', A.waiter)).body.total, 1);
    assert.equal((await call('GET', '/couriers', B.admin)).body.total, 0);
    assert.equal((await call('PATCH', `/couriers/${created.body.id}`, B.admin, { active: false })).status, 404);
    assert.equal((await call('PATCH', `/couriers/${created.body.id}`, A.admin, { active: false })).body.active, false);
    assert.equal((await call('GET', '/couriers?active=true', A.admin)).body.total, 0);
  });

  await t.test('carriers validate the document digits', async () => {
    assert.equal((await call('POST', '/carriers', A.admin, { name: 'Rápido Log', document: '123' })).status, 400);
    const created = await call('POST', '/carriers', A.admin, { name: 'Rápido Log', document: '12.345.678/0001-95', email: 'a@b.com' });
    assert.equal(created.status, 201);
    assert.equal(created.body.document, '12345678000195');
    assert.equal((await call('GET', '/carriers', B.admin)).body.total, 0);
  });

  await t.test('payment methods: unique names per tenant and default options', async () => {
    const defaults = await call('GET', '/payment-methods/options', A.cashier);
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.body.items.map((item: { name: string }) => item.name), ['Dinheiro', 'PIX', 'Cartão de crédito', 'Cartão de débito', 'Vale', 'Outro']);
    assert.equal(await prisma.paymentMethodConfig.count({ where: { tenantId: A.tenant.id } }), 0, 'defaults are not persisted');
    const first = await call('POST', '/payment-methods', A.admin, { name: 'Ticket', equivalent: 'VOUCHER', allowChange: false, showApp: false });
    assert.equal(first.status, 201);
    assert.equal((await call('POST', '/payment-methods', A.admin, { name: 'ticket' })).status, 409);
    assert.equal((await call('POST', '/payment-methods', B.admin, { name: 'Ticket' })).status, 201);
    await call('POST', '/payment-methods', A.admin, { name: 'Antigo', active: false });
    const options = await call('GET', '/payment-methods/options', A.cashier);
    assert.deepEqual(options.body.items.map((item: { name: string }) => item.name), ['Ticket']);
    assert.equal(options.body.items[0].equivalent, 'VOUCHER');
    assert.equal(options.body.items[0].showApp, false);
  });

  await t.test('financial categories are unique per type and feed entries', async () => {
    assert.equal((await call('POST', '/financial-categories', A.admin, { type: 'EXPENSE', name: 'Aluguel' })).status, 201);
    assert.equal((await call('POST', '/financial-categories', A.admin, { type: 'EXPENSE', name: 'aluguel' })).status, 409);
    const income = await call('POST', '/financial-categories', A.admin, { type: 'INCOME', name: 'Aluguel' });
    assert.equal(income.status, 201);
    assert.equal((await call('GET', '/financial-categories?type=EXPENSE', A.admin)).body.total, 1);
    assert.equal((await call('GET', '/financial-categories', B.admin)).body.total, 0);
    assert.equal((await call('GET', '/financial-categories', A.waiter)).status, 403);
    const entry = await call('POST', '/financial/entries', A.admin, { description: 'Aluguel de março', type: 'EXPENSE', category: 'ALUGUEL', amount: 100 });
    assert.equal(entry.status, 201);
    assert.equal(entry.body.category, 'Aluguel');
    assert.equal((await call('POST', '/financial/entries', A.admin, { description: 'Livre', type: 'EXPENSE', category: 'Outra coisa', amount: 10 })).body.category, 'Outra coisa');
    const expense = (await call('GET', '/financial-categories?type=EXPENSE', A.admin)).body.items[0];
    const removed = await call('DELETE', `/financial-categories/${expense.id}`, A.admin);
    assert.equal(removed.body.deactivated, true, 'used categories are deactivated, not deleted');
    assert.equal((await call('DELETE', `/financial-categories/${income.body.id}`, A.admin)).body.deleted, true);
  });

  await t.test('cover events validate the period and expose the current one', async () => {
    const hour = 60 * 60 * 1000; const now = Date.now();
    const iso = (offset: number) => new Date(now + offset * hour).toISOString();
    assert.equal((await call('POST', '/cover-events', A.admin, { description: 'Inválido', amount: 20, startsAt: iso(2), endsAt: iso(1) })).status, 400);
    assert.equal((await call('GET', '/cover-events/current', A.waiter)).body, null);
    await call('POST', '/cover-events', A.admin, { description: 'Amanhã', amount: 15, startsAt: iso(24), endsAt: iso(28) });
    await call('POST', '/cover-events', A.admin, { description: 'Desativado', amount: 15, startsAt: iso(-1), endsAt: iso(1), active: false });
    assert.equal((await call('GET', '/cover-events/current', A.waiter)).body, null);
    const live = await call('POST', '/cover-events', A.admin, { description: 'Samba ao vivo', amount: 25.5, startsAt: iso(-1), endsAt: iso(3) });
    assert.equal(live.status, 201);
    assert.equal((await call('GET', '/cover-events/current', A.waiter)).body.description, 'Samba ao vivo');
    assert.equal((await call('GET', '/cover-events/current', B.waiter)).body, null);
    assert.equal((await call('PATCH', `/cover-events/${live.body.id}`, A.admin, { endsAt: iso(-2) })).status, 400);
    assert.equal((await call('GET', '/cover-events', B.admin)).body.total, 0);
  });

  await t.test('tax rules bulk-assign only tenant products', async () => {
    assert.equal((await call('POST', '/tax-rules', A.admin, { name: 'Bebidas', ncm: '2202' })).status, 400);
    const rule = await call('POST', '/tax-rules', A.admin, { name: 'Bebidas', ncm: '2202.10.00', cest: '0300100', origin: 0, cfop: '5102', icmsCst: '00', icmsRate: 18, pisRate: 1.65, cofinsRate: 7.6 });
    assert.equal(rule.status, 201);
    assert.equal(rule.body.ncm, '22021000');
    assert.equal((await call('POST', '/tax-rules', A.admin, { name: 'bebidas' })).status, 409);
    const mine = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Suco', price: 8 } });
    const other = await prisma.product.create({ data: { tenantId: B.tenant.id, name: 'Alheio', price: 8 } });
    assert.equal((await call('POST', `/tax-rules/${rule.body.id}/assign`, A.admin, { productIds: [mine.id, other.id] })).status, 400);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: other.id } })).taxRuleId, null);
    assert.equal((await call('POST', `/tax-rules/${rule.body.id}/assign`, B.admin, { productIds: [other.id] })).status, 404);
    assert.equal((await call('POST', `/tax-rules/${rule.body.id}/assign`, A.admin, { productIds: [mine.id] })).body.updated, 1);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: mine.id } })).taxRuleId, rule.body.id);
    assert.deepEqual((await call('GET', `/tax-rules/${rule.body.id}/products`, A.admin)).body.items.map((item: { id: string }) => item.id), [mine.id]);
    assert.equal((await call('DELETE', `/tax-rules/${rule.body.id}`, A.admin)).body.deactivated, true);
  });

  await t.test('delivery accepts a registered courier and keeps free-text couriers', async () => {
    const order = (code: string) => prisma.order.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, code, channel: 'DELIVERY', subtotal: 10, total: 10 } });
    const courier = (await call('POST', '/couriers', A.admin, { name: 'Maria Bike', phone: '11888880000' })).body;
    const first = await order(`R-${suffix()}`); const second = await order(`R-${suffix()}`); const third = await order(`R-${suffix()}`);
    const linked = await call('POST', '/delivery', A.admin, { orderId: first.id, courierId: courier.id, courierName: 'ignorado' });
    assert.equal(linked.status, 201);
    assert.equal(linked.body.courierId, courier.id);
    assert.equal(linked.body.courierName, 'Maria Bike');
    assert.equal(linked.body.courierPhone, '11888880000');
    const free = await call('POST', '/delivery', A.admin, { orderId: second.id, courierName: 'Zé', courierPhone: '1' });
    assert.equal(free.status, 201);
    assert.equal(free.body.courierId, null);
    assert.equal(free.body.courierName, 'Zé');
    const foreign = (await call('POST', '/couriers', B.admin, { name: 'De outro' })).body;
    assert.equal((await call('POST', '/delivery', A.admin, { orderId: third.id, courierId: foreign.id })).status, 400);
    const assigned = await call('PATCH', `/delivery/${free.body.id}/courier`, A.admin, { courierId: courier.id });
    assert.equal(assigned.body.courierName, 'Maria Bike');
    await call('PATCH', `/couriers/${courier.id}`, A.admin, { active: false });
    assert.equal((await call('PATCH', `/delivery/${free.body.id}/courier`, A.admin, { courierId: courier.id })).status, 400);
    const removed = await call('DELETE', `/couriers/${courier.id}`, A.admin);
    assert.equal(removed.body.deactivated, true, 'couriers with deliveries are kept');
    assert.equal((await call('POST', '/delivery', A.admin, { orderId: third.id, courierId: courier.id })).status, 400);
  });
  await t.test('fiscal registries: natures, CST map, received invoices, contingency and reconciliation', async () => {
    const withDigit = (base: string) => { let sum = 0; let weight = 2; for (let i = 42; i >= 0; i--) { sum += Number(base[i]) * weight; weight = weight === 9 ? 2 : weight + 1; } const r = sum % 11; return base + String(r < 2 ? 0 : 11 - r); };
    const key = withDigit('3526111234567800019055001000000123100000123');
    const xml = `<NFe><infNFe Id="NFe${key}"><ide><serie>1</serie><nNF>123</nNF><dhEmi>2026-11-10T10:00:00-03:00</dhEmi></ide><emit><CNPJ>12345678000190</CNPJ><xNome>Frios</xNome></emit><det nItem="1"><prod><xProd>Queijo</xProd><qCom>2</qCom><vUnCom>10</vUnCom><vProd>20</vProd></prod></det><total><ICMSTot><vNF>20.00</vNF></ICMSTot></total></infNFe></NFe>`;

    const nature = await call('POST', '/fiscal-registry/natures', A.admin, { name: 'Compra para revenda', cfop: '1102', direction: 'IN' });
    assert.equal(nature.status, 201);
    assert.equal((await call('POST', '/fiscal-registry/natures', A.admin, { name: 'compra para revenda', cfop: '1102' })).status, 409);
    assert.equal((await call('POST', '/fiscal-registry/natures', A.admin, { name: 'CFOP ruim', cfop: '12' })).status, 400);
    assert.equal((await call('POST', '/fiscal-registry/natures', A.cashier, { name: 'Sem permissão', cfop: '5102' })).status, 403);
    assert.equal((await call('GET', '/fiscal-registry/natures', B.admin)).body.total, 0, 'natures are tenant scoped');

    const map = await call('POST', '/fiscal-registry/cst-map', A.admin, { outCst: '00', inCst: '90' });
    assert.equal(map.status, 201);
    assert.equal((await call('POST', '/fiscal-registry/cst-map', A.admin, { outCst: '00', inCst: '10' })).status, 409);

    assert.equal((await call('POST', '/fiscal-registry/invoices/parse-xml', A.admin, { xml })).body.totalAmount, 20);
    assert.equal((await call('POST', '/fiscal-registry/invoices/parse-xml', A.admin, { xml: '<foo>'.padEnd(60, 'x') })).status, 422);
    const body = { accessKey: key, number: '123', supplierName: 'Frios', supplierDocument: '12.345.678/0001-90', issuedAt: '2026-11-10T13:00:00Z', totalAmount: 20, natureId: nature.body.id, items: [{ description: 'Queijo', quantity: 2, unitValue: 10, totalValue: 20 }], xml };
    assert.equal((await call('POST', '/fiscal-registry/invoices', A.admin, { ...body, accessKey: key.slice(0, 43) + '0'.replace(key[43], '1') })).status, 400, 'bad check digit');
    assert.equal((await call('POST', '/fiscal-registry/invoices', A.admin, { ...body, natureId: (await call('POST', '/fiscal-registry/natures', B.admin, { name: 'Alheia', cfop: '1102' })).body.id })).status, 400, 'foreign nature');
    const invoice = await call('POST', '/fiscal-registry/invoices', A.admin, body);
    assert.equal(invoice.status, 201);
    assert.equal(invoice.body.status, 'RECEIVED');
    assert.equal((await call('POST', '/fiscal-registry/invoices', A.admin, body)).status, 409, 'same access key twice');
    assert.equal((await call('GET', `/fiscal-registry/invoices?q=${key.slice(0, 10)}`, A.admin)).body.total, 1);
    assert.equal((await call('GET', '/fiscal-registry/invoices', B.admin)).body.total, 0);
    assert.equal((await call('GET', `/fiscal-registry/invoices/${invoice.body.id}/xml`, B.admin)).status, 404);
    assert.equal((await call('GET', '/fiscal-registry/xmls', A.admin)).body.received.length, 1);
    assert.equal((await call('POST', `/fiscal-registry/invoices/${invoice.body.id}/enter`, A.admin)).body.status, 'ENTERED');
    assert.equal((await call('POST', `/fiscal-registry/invoices/${invoice.body.id}/enter`, A.admin)).status, 409);
    assert.equal((await call('POST', `/fiscal-registry/invoices/${invoice.body.id}/cancel`, A.admin)).status, 409);
    assert.equal((await call('DELETE', `/fiscal-registry/natures/${nature.body.id}`, A.admin)).body.deactivated, true, 'used natures are kept');

    assert.equal((await call('POST', '/fiscal-registry/contingency/start', A.admin, { reason: 'curto' })).status, 400);
    assert.equal((await call('POST', '/fiscal-registry/contingency/start', A.admin, { reason: 'Provedor fiscal fora do ar desde as 10h' })).status, 201);
    assert.equal((await call('POST', '/fiscal-registry/contingency/start', A.admin, { reason: 'Provedor fiscal fora do ar desde as 10h' })).status, 409);
    assert.ok((await call('GET', '/fiscal-registry/contingency', A.admin)).body.active);
    assert.equal((await call('GET', '/fiscal-registry/contingency', B.admin)).body.active, null);
    assert.ok((await call('POST', '/fiscal-registry/contingency/end', A.admin)).body.endedAt);
    assert.equal((await call('POST', '/fiscal-registry/contingency/end', A.admin)).status, 409);

    await prisma.order.create({ data: { tenantId: A.tenant.id, code: `REC-${suffix()}`, status: 'COMPLETED', subtotal: 40, total: 40 } });
    const report = await call('GET', '/fiscal-registry/reconciliation', A.admin);
    assert.equal(report.status, 200);
    assert.equal(report.body.orders.count, 1);
    assert.equal(report.body.withoutDocument.count, 1);
    assert.equal(report.body.withoutDocument.total, 40);
    assert.equal((await call('GET', '/fiscal-registry/reconciliation', B.admin)).body.orders.count, 0);
  });
});
