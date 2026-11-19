import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process: own API rate-limit budget.
const enabled = process.env.RUN_DB_TESTS === '1';

test('pricing: company defaults, per-product costs, simulation, confirmed price changes, bulk simulation/apply, history, cost snapshot on sales, panel and isolation', { skip: !enabled, timeout: 120_000 }, async t => {
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
    const tokens = {} as Record<'ADMIN' | 'WAITER', string>;
    for (const role of [UserRole.ADMIN, UserRole.WAITER] as const) {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      tokens[role] = signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    }
    return { tenant, unit, tokens };
  };
  const A = await makeTenant('price'); const B = await makeTenant('pricex');
  const admin = A.tokens.ADMIN; const other = B.tokens.ADMIN;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const ids = [A.tenant.id, B.tenant.id];
    await prisma.order.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const category = await prisma.productCategory.create({ data: { tenantId: A.tenant.id, name: 'Bebidas' } });
  const mk = (name: string, price: number, cost: number | null, extra: object = {}) => prisma.product.create({ data: { tenantId: A.tenant.id, name, price, cost, categoryId: category.id, ...extra } });
  const cola = await mk('Cola', 10, 4); const juice = await mk('Suco', 5, 4); const noCost = await mk('Sem custo', 9, null); const foreign = await prisma.product.create({ data: { tenantId: B.tenant.id, name: 'Alheio', price: 10, cost: 5 } });

  await t.test('tax review: the fiscal regime is shown for review, never turned into a rate', async () => {
    const review = (await call('GET', '/pricing/settings', admin)).body.taxReview;
    assert.equal(review.rateSuggested, false); assert.match(review.note, /não presume alíquotas/);
    assert.ok(review.fiscalRegime === null || typeof review.fiscalRegime === 'string');
    assert.equal(Number((await call('GET', '/pricing/settings', admin)).body.defaults.taxPercent), 0, 'no tax percentage is invented for a company that has not informed one');
  });

  await t.test('company defaults are saved in the existing settings sections, validated and audited; non-finance roles are refused', async () => {
    const bad = await call('PUT', '/pricing/settings', admin, { marginPercent: 30, taxPercent: 50, cardFeePercent: 30, commissionPercent: 20, operationalCostPercent: 0, otherVariablePercent: 0, rounding: 'NONE' });
    assert.equal(bad.status, 400); assert.match(bad.body.message, /menor que 100/);
    const saved = await call('PUT', '/pricing/settings', admin, { marginPercent: 30, taxPercent: 6, cardFeePercent: 2, commissionPercent: 2, operationalCostPercent: 0, otherVariablePercent: 0, rounding: 'NONE' });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const settings = (await call('GET', '/settings', admin)).body.settings;
    assert.equal(settings.products.defaultMarginPercent, 30); assert.equal(settings.profit.taxPercent, 6); assert.equal(settings.profit.includeCommissions, true, 'other profit options are preserved');
    assert.equal((await call('GET', '/pricing/settings', admin)).body.defaults.commissionPercent, 2);
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId: A.tenant.id, action: 'PRICING_DEFAULTS_UPDATED' } }));
    assert.equal((await call('GET', '/pricing/settings', A.tokens.WAITER)).status, 403);
  });

  await t.test('per-product costs inherit company defaults and compute prices "por dentro"', async () => {
    const initial = await call('GET', `/pricing/products/${cola.id}`, admin);
    assert.equal(initial.body.result.recommendedPrice, '5.78', '(4 × 1.30) ÷ 0.90 rounded up'); assert.equal(initial.body.result.status, 'ON_TARGET');
    const saved = await call('PUT', `/pricing/products/${cola.id}`, admin, { acquisitionCost: 8, freightCost: 1, otherAcquisitionCost: 1, marginPercent: 40, operationalCostPercent: null, operationalCostFixed: 0.5, taxPercent: null, cardFeePercent: null, commissionPercent: null, otherVariablePercent: null });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.result.totalCost, '10.00'); assert.equal(saved.body.result.variablePercent, '10.00');
    assert.equal(saved.body.result.recommendedPrice, '16.12', '(10 + 0.50 fixed + 40% of 10) ÷ 0.90 = 16.11…, rounded up');
  });

  await t.test('simulation never writes; applying a price needs confirmation and records history and audit', async () => {
    const before = (await prisma.product.findUniqueOrThrow({ where: { id: cola.id } })).price.toString();
    const sim = await call('POST', '/pricing/simulate', admin, { productId: cola.id, marginPercent: 100, simulatedPrice: 20 });
    assert.equal(sim.status, 200); assert.equal(sim.body.ok, true); assert.ok(sim.body.simulated);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: cola.id } })).price.toString(), before);
    const high = await call('POST', '/pricing/simulate', admin, { taxPercent: 60, cardFeePercent: 40, acquisitionCost: 5 });
    assert.equal(high.body.ok, false); assert.equal(high.body.code, 'VARIABLE_PERCENT_TOO_HIGH');
    assert.equal((await call('POST', `/pricing/products/${cola.id}/apply-price`, admin, { price: 16.12 })).status, 400);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: cola.id } })).price.toString(), before);
    assert.equal((await call('POST', `/pricing/products/${cola.id}/apply-price`, admin, { price: 16.12, confirm: true })).status, 200);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: cola.id } })).price), 16.12);
    const history = (await call('GET', `/pricing/products/${cola.id}`, admin)).body.history;
    assert.ok(history.some((row: any) => row.reason === 'PRICING_APPLIED' && Number(row.price) === 16.12) && history.some((row: any) => row.reason === 'COST_UPDATE'));
  });

  await t.test('bulk change: preview first, skips products without cost, requires confirm and the same count, keeps individual margins', async () => {
    const body = { categoryId: category.id, marginPercent: 50, keepIndividualMargins: true };
    const preview = await call('POST', '/pricing/bulk/preview', admin, body);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.deepEqual(preview.body.skipped.filter((row: any) => row.reason === 'Sem custo cadastrado').map((row: any) => row.id), [noCost.id]);
    const byId = Object.fromEntries(preview.body.rows.map((row: any) => [row.id, row]));
    assert.equal(byId[cola.id], undefined, 'cola already sits at its recommended price');
    assert.equal(byId[juice.id].newPrice, 6.67, '(4 + 50% of 4) ÷ 0.90 = 6.666…, rounded up');
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: juice.id } })).price), 5, 'preview changes nothing');
    assert.equal((await call('POST', '/pricing/bulk/apply', admin, { ...body, expectedCount: preview.body.count })).status, 400);
    assert.equal((await call('POST', '/pricing/bulk/apply', admin, { ...body, confirm: true, expectedCount: preview.body.count + 1 })).status, 409);
    const applied = await call('POST', '/pricing/bulk/apply', admin, { ...body, confirm: true, expectedCount: preview.body.count });
    assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.updated, preview.body.count);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: juice.id } })).price), byId[juice.id].newPrice);
    assert.equal((await prisma.priceHistory.count({ where: { tenantId: A.tenant.id, productId: juice.id, reason: 'PRICING_BULK' } })), 1);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: noCost.id } })).price), 9, 'a product without cost is never repriced');
  });

  await t.test('sales freeze the cost; later cost changes do not re-cost old sales; the panel reports planned vs realised', async () => {
    const sale = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: cola.id, quantity: 2 }] });
    assert.equal(sale.status, 201, JSON.stringify(sale.body));
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: sale.body.id } });
    assert.equal(Number(item.unitCost), 10, 'product cost 8 + freight 1 + other 1');
    await prisma.order.update({ where: { id: sale.body.id }, data: { status: 'COMPLETED' } });
    await call('PUT', `/pricing/products/${cola.id}`, admin, { acquisitionCost: 20, freightCost: 1, otherAcquisitionCost: 1, marginPercent: 40, operationalCostPercent: null, operationalCostFixed: 0.5, taxPercent: null, cardFeePercent: null, commissionPercent: null, otherVariablePercent: null });
    assert.equal(Number((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).unitCost), 10, 'snapshot is immutable');
    const panel = await call('GET', '/pricing/panel', admin);
    assert.equal(panel.status, 200, JSON.stringify(panel.body));
    assert.deepEqual(panel.body.withoutCost.map((row: any) => row.id), [noCost.id]);
    const cola2 = [...panel.body.negative, ...panel.body.belowTarget].find((row: any) => row.id === cola.id);
    assert.equal(cola2.status, 'NEGATIVE', 'cost 22 against price 16.12');
    assert.equal(panel.body.summary.realizedCost, 20); assert.equal(panel.body.summary.realizedRevenue, 32.24); assert.ok(panel.body.summary.realizedMl > 60);
    const profit = await call('GET', '/profit/summary', admin);
    assert.equal(profit.status, 200);
    assert.equal(profit.body.result.cogs, 20, 'profit uses the frozen cost (2 × 10), not today\'s cost of 21');
  });

  await t.test('another company cannot read or change this pricing', async () => {
    assert.equal((await call('GET', `/pricing/products/${cola.id}`, other)).status, 404);
    assert.equal((await call('POST', `/pricing/products/${cola.id}/apply-price`, other, { price: 1, confirm: true })).status, 404);
    assert.equal((await call('POST', '/pricing/simulate', other, { productId: cola.id })).status, 404);
    const preview = await call('POST', '/pricing/bulk/preview', other, { marginPercent: 10 });
    assert.deepEqual(preview.body.rows.map((row: any) => row.id), [foreign.id]);
    assert.ok(!JSON.stringify(preview.body).includes(cola.id));
    assert.equal((await call('GET', '/pricing/settings', other)).body.defaults.marginPercent, 0, 'defaults are per company');
  });
});
