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

async function tenantWith(label: string) {
  const id = suffix();
  const tenant = await prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Gestor', email: `a-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const waiter = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Garçom', email: `w-${id}@test.local`, passwordHash: 'x', role: UserRole.WAITER } });
  const token = (user: { id: string }, role: UserRole) => signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
  return { tenant, admin, waiter, adminToken: token(admin, UserRole.ADMIN), waiterToken: token(waiter, UserRole.WAITER) };
}

test('profit control, recipe costs, waste, support tickets and leads', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'c'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const A = await tenantWith('pa');
  const B = await tenantWith('pb');
  const master = await prisma.user.create({ data: { name: 'Master', email: `m-${suffix()}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const leadEmail = `lead-${suffix()}@test.local`;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.stockMovement.deleteMany({ where: { tenantId: A.tenant.id } });
    await prisma.recipe.deleteMany({ where: { tenantId: A.tenant.id } });
    await prisma.saaSLead.deleteMany({ where: { email: leadEmail } });
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.$disconnect();
  });

  const cheese = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Queijo', unitOfMeasure: 'kg', currentStock: 10, averageCost: 40 } });
  const bread = await prisma.ingredient.create({ data: { tenantId: A.tenant.id, name: 'Pão', unitOfMeasure: 'un', currentStock: 100, averageCost: 1 } });
  const burger = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'X-Burger', price: 30 } });
  await prisma.recipe.create({ data: { tenantId: A.tenant.id, productId: burger.id, yield: 1, ingredients: { create: [{ ingredientId: cheese.id, quantity: 0.1 }, { ingredientId: bread.id, quantity: 1 }] } } });
  const soda = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Refri', price: 8, cost: 3 } });
  for (let index = 0; index < 2; index += 1) {
    await prisma.order.create({ data: { tenantId: A.tenant.id, code: `P${suffix()}`, channel: 'POS', status: 'COMPLETED', subtotal: 38, total: 38, createdByUserId: A.admin.id, items: { create: [{ productId: burger.id, quantity: 1, unitPrice: 30, total: 30 }, { productId: soda.id, quantity: 1, unitPrice: 8, total: 8 }] } } });
  }
  await prisma.order.create({ data: { tenantId: A.tenant.id, code: `P${suffix()}`, channel: 'POS', status: 'CANCELLED', subtotal: 50, total: 50 } });
  await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, description: 'Aluguel', type: 'EXPENSE', category: 'Aluguel', amount: 10, paidAmount: 10, status: 'PAID', settledAt: new Date() } });

  await t.test('profit uses recipe cost as fallback and keeps revenue, cost and result apart', async () => {
    await call('PUT', '/settings/profit', A.adminToken, { cardFeePercent: 0, taxPercent: 10, fixedCategories: ['Aluguel'], includeCommissions: true });
    const summary = await call('GET', '/profit/summary', A.adminToken);
    assert.equal(summary.status, 200);
    const result = summary.body.result;
    assert.equal(result.netRevenue, 76);
    assert.equal(result.cogs, 2 * (5 + 3), 'recipe cost 0.1*40+1=5 per burger, registered cost 3 per soda');
    assert.equal(result.costCoverage, 100);
    assert.equal(result.grossProfit, 60);
    assert.equal(result.taxes, 7.6);
    assert.equal(result.fixedExpenses, 10);
    assert.equal(result.operatingResult, r2(60 - 7.6 - 10));
    assert.equal(result.cancellations.count, 1);
    assert.equal(result.received, 0, 'revenue is not receipts');
    assert.equal(summary.body.byProduct[0].name, 'X-Burger');
    assert.equal(summary.body.byEmployee[0].name, 'Gestor');
    assert.equal((await call('GET', '/profit/summary', A.waiterToken)).status, 403);
    assert.equal((await call('GET', '/profit/summary', B.adminToken)).body.result.netRevenue, 0, 'tenant isolation');
    assert.equal((await call('GET', '/profit/summary?from=2026-12-01&to=2026-01-01', A.adminToken)).status, 400);
  });

  await t.test('recipe costs, margin, simulation and applying the cost with history', async () => {
    const list = await call('GET', '/profit/recipes', A.adminToken);
    const item = list.body.items.find((entry: { name: string }) => entry.name === 'X-Burger');
    assert.equal(item.recipeCost, 5);
    assert.equal(item.marginPercent, 83.33);
    assert.equal(item.lines.length, 2);
    assert.equal((await call('GET', '/profit/simulate?cost=5&margin=50', A.adminToken)).body.suggestedPrice, 10);
    assert.equal((await call('POST', `/profit/recipes/${burger.id}/apply-cost`, A.waiterToken)).status, 403);
    assert.equal((await call('POST', `/profit/recipes/${burger.id}/apply-cost`, B.adminToken)).status, 404);
    assert.equal((await call('POST', `/profit/recipes/${burger.id}/apply-cost`, A.adminToken)).body.cost, 5);
    assert.equal((await call('GET', '/profit/cost-history', A.adminToken)).body.items.length, 1);
    await prisma.ingredient.update({ where: { id: bread.id }, data: { averageCost: 0 } });
    assert.equal((await call('POST', `/profit/recipes/${burger.id}/apply-cost`, A.adminToken)).status, 409, 'incomplete recipe is not costed');
  });

  await t.test('waste report values losses and names the responsible', async () => {
    assert.equal((await call('POST', `/inventory/ingredients/${cheese.id}/movements`, A.adminToken, { type: 'WASTE', quantity: 2, note: 'Vencido' })).status, 201);
    const waste = await call('GET', '/profit/waste', A.adminToken);
    assert.equal(waste.body.total, 80);
    assert.equal(waste.body.byReason[0].name, 'Vencido');
    assert.equal(waste.body.items[0].ingredient, 'Queijo');
  });

  await t.test('support tickets: tenant isolation, internal notes hidden, admin workflow', async () => {
    const opened = await call('POST', '/support/tickets', A.waiterToken, { subject: 'Impressora não imprime', body: 'A impressora da cozinha parou.', priority: 'HIGH' });
    assert.equal(opened.status, 201);
    assert.equal((await call('POST', '/support/tickets', A.waiterToken, { subject: 'x', body: 'y' })).status, 400);
    assert.equal((await call('GET', `/support/tickets/${opened.body.id}`, B.adminToken)).status, 404, 'other tenant cannot read');
    assert.equal((await call('GET', '/support/tickets', B.adminToken)).body.items.length, 0);
    assert.equal((await call('GET', '/commercial/support/tickets', A.adminToken)).status, 403);

    const queue = await call('GET', '/commercial/support/tickets?status=OPEN', masterToken);
    assert.ok(queue.body.items.some((ticket: { id: string }) => ticket.id === opened.body.id));
    assert.equal((await call('POST', `/commercial/support/tickets/${opened.body.id}/messages`, masterToken, { body: 'Cliente já reiniciou o agente?', internal: true })).status, 201);
    assert.equal((await call('POST', `/commercial/support/tickets/${opened.body.id}/messages`, masterToken, { body: 'Reinicie o agente de impressão.', status: 'WAITING_CUSTOMER' })).status, 201);
    const customerView = await call('GET', `/support/tickets/${opened.body.id}`, A.waiterToken);
    assert.equal(customerView.body.messages.length, 2, 'internal note is hidden');
    assert.equal(customerView.body.ticket.status, 'WAITING_CUSTOMER');
    await call('POST', `/support/tickets/${opened.body.id}/messages`, A.waiterToken, { body: 'Funcionou, obrigado' });
    assert.equal((await call('GET', `/support/tickets/${opened.body.id}`, A.waiterToken)).body.ticket.status, 'OPEN', 'customer reply reopens the conversation');
    const closed = await call('PATCH', `/commercial/support/tickets/${opened.body.id}`, masterToken, { status: 'CLOSED' });
    assert.ok(closed.body.resolvedAt);
    assert.equal((await call('POST', `/support/tickets/${opened.body.id}/messages`, A.waiterToken, { body: 'Mais uma coisa' })).status, 409);

    await prisma.tenantLicense.create({ data: { tenantId: A.tenant.id, status: 'SUSPENDED' } });
    assert.equal((await call('GET', '/support/tickets', A.adminToken)).status, 200, 'a suspended restaurant can still reach support');
    assert.equal((await call('GET', '/profit/summary', A.adminToken)).status, 403);
  });

  await t.test('CRM segments are computed from completed orders and restricted to managers', async () => {
    await prisma.tenantLicense.deleteMany({ where: { tenantId: A.tenant.id } });
    const vip = await prisma.customer.create({ data: { tenantId: B.tenant.id, name: 'Cliente Fiel', phone: `119${suffix()}`.slice(0, 11) } });
    const idle = await prisma.customer.create({ data: { tenantId: B.tenant.id, name: 'Cliente Novo', phone: `118${suffix()}`.slice(0, 11) } });
    for (let index = 0; index < 5; index += 1) await prisma.order.create({ data: { tenantId: B.tenant.id, code: `C${suffix()}`, channel: 'POS', status: 'COMPLETED', subtotal: 200, total: 200, customerId: vip.id, createdAt: new Date(Date.now() - (index + 1) * 86_400_000) } });
    const other = await prisma.customer.create({ data: { tenantId: B.tenant.id, name: 'Outro', phone: `117${suffix()}`.slice(0, 11) } });
    for (const customer of [idle, other]) await prisma.order.create({ data: { tenantId: B.tenant.id, code: `C${suffix()}`, channel: 'POS', status: 'COMPLETED', subtotal: 20, total: 20, customerId: customer.id } });
    const result = await call('GET', '/customers/segments', B.adminToken);
    assert.equal(result.status, 200);
    assert.equal(result.body.items.find((item: { id: string }) => item.id === vip.id).segment, 'VIP');
    assert.equal(result.body.items.find((item: { id: string }) => item.id === idle.id).segment, 'NEW');
    assert.equal((await call('GET', '/customers/segments', B.waiterToken)).status, 403);
    assert.equal((await call('GET', '/customers/segments', A.adminToken)).body.items.length, 0, 'tenant isolation');
  });

  await t.test('public demo requests are validated, deduplicated and managed by admin', async () => {
    const payload = { name: 'Maria', company: 'Bar da Maria', email: leadEmail, phone: '11999990000', interest: 'RM PRO' };
    assert.equal((await call('POST', '/public/leads', null, { ...payload, email: 'invalido' })).status, 400);
    assert.equal((await call('POST', '/public/leads', null, { ...payload, website: 'http://spam' })).status, 400, 'honeypot');
    assert.equal((await call('POST', '/public/leads', null, payload)).status, 201);
    assert.equal((await call('POST', '/public/leads', null, payload)).status, 201);
    assert.equal(await prisma.saaSLead.count({ where: { email: leadEmail } }), 1, 'duplicate pending request is ignored');
    const lead = (await call('GET', '/commercial/leads?status=NEW', masterToken)).body.items.find((item: { email: string }) => item.email === leadEmail);
    assert.ok(lead);
    assert.equal((await call('PATCH', `/commercial/leads/${lead.id}`, masterToken, { status: 'DEMO_SCHEDULED', notes: 'Demo quinta' })).body.status, 'DEMO_SCHEDULED');
    assert.equal((await call('GET', '/commercial/leads', A.adminToken)).status, 403);
  });
});
const r2 = (value: number) => Math.round(value * 100) / 100;
