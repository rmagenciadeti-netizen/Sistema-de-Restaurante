import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('commissions: rules per person/role/product/goal, eligible sales only, isolation and permissions', { skip: !enabled }, async t => {
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
    const user = async (role: UserRole, extra: { commissionPercent?: number } = {}) => prisma.user.create({ data: { tenantId: tenant.id, name: `${role} ${label}`, email: `${role}-${label}-${id}@test.local`, passwordHash: 'x', role, ...extra } });
    return { tenant, user };
  };
  const A = await makeTenant('comm'); const B = await makeTenant('commother');
  const adminUser = await A.user(UserRole.ADMIN); const waiterUser = await A.user(UserRole.WAITER, { commissionPercent: 2 }); const otherAdminUser = await B.user(UserRole.ADMIN);
  const tokenOf = (user: { id: string }, tenantId: string, role: UserRole) => signAccessToken({ userId: user.id, tenantId, unitId: null, role });
  const admin = tokenOf(adminUser, A.tenant.id, UserRole.ADMIN); const waiter = tokenOf(waiterUser, A.tenant.id, UserRole.WAITER); const otherAdmin = tokenOf(otherAdminUser, B.tenant.id, UserRole.ADMIN);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  const burger = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Burger', price: 100 } });
  const drink = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Suco', price: 10 } });
  const sale = async (status: 'COMPLETED' | 'CANCELLED', lines: { productId: string; total: number; itemStatus?: 'CANCELLED' }[], n: number) => {
    const total = lines.reduce((sum, line) => sum + line.total, 0);
    return prisma.order.create({ data: { tenantId: A.tenant.id, code: `C${id}${n}`, status, subtotal: total, total, createdByUserId: waiterUser.id, items: { create: lines.map(line => ({ productId: line.productId, quantity: 1, unitPrice: line.total, total: line.total, status: line.itemStatus ?? 'PENDING' })) } } });
  };
  await sale('COMPLETED', [{ productId: burger.id, total: 100 }, { productId: drink.id, total: 20 }], 1);
  await sale('COMPLETED', [{ productId: burger.id, total: 200 }, { productId: drink.id, total: 30, itemStatus: 'CANCELLED' }], 2);
  await sale('CANCELLED', [{ productId: burger.id, total: 999 }], 3);
  const statement = async (token: string) => call('GET', '/commissions/statement', token);

  await t.test('without rules the flat percentage of the user applies, over completed and non-cancelled items only', async () => {
    const result = await statement(admin);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const line = result.body.items.find((item: any) => item.userId === waiterUser.id);
    assert.equal(line.sales, 320);
    assert.equal(line.total, 6.4);
  });

  await t.test('rules: product beats sale, goal bonus is paid, only managers manage rules', async () => {
    assert.equal((await call('POST', '/commissions/rules', waiter, { name: 'x', kind: 'SALE_PERCENT', percent: 50 })).status, 403);
    assert.equal((await call('POST', '/commissions/rules', admin, { name: 'Sem produto', kind: 'PRODUCT_PERCENT', percent: 5 })).status, 400);
    assert.equal((await call('POST', '/commissions/rules', admin, { name: 'Garçom 5%', kind: 'SALE_PERCENT', role: 'WAITER', percent: 5 })).status, 201);
    assert.equal((await call('POST', '/commissions/rules', admin, { name: 'Suco 10%', kind: 'PRODUCT_PERCENT', productId: drink.id, percent: 10 })).status, 201);
    assert.equal((await call('POST', '/commissions/rules', admin, { name: 'Meta 300', kind: 'GOAL_BONUS', goalAmount: 300, bonusAmount: 25 })).status, 201);
    const line = (await statement(admin)).body.items.find((item: any) => item.userId === waiterUser.id);
    assert.equal(line.saleCommission, 15, '5% of 300 in burgers');
    assert.equal(line.productCommission, 2, '10% of 20 in juice');
    assert.equal(line.goalBonus, 25);
    assert.equal(line.total, 42);
  });

  await t.test('permissions and isolation', async () => {
    assert.equal((await statement(waiter)).status, 403);
    assert.deepEqual((await call('GET', '/commissions/rules', otherAdmin)).body.items, []);
    const foreign = await call('POST', '/commissions/rules', otherAdmin, { name: 'Intruso', kind: 'PRODUCT_PERCENT', productId: burger.id, percent: 1 });
    assert.equal(foreign.status, 400, 'a product of another restaurant cannot be used');
    const rules = (await call('GET', '/commissions/rules', admin)).body.items;
    assert.equal((await call('DELETE', `/commissions/rules/${rules[0].id}`, otherAdmin)).status, 404);
    assert.equal((await call('DELETE', `/commissions/rules/${rules[0].id}`, admin)).status, 204);
  });
});
