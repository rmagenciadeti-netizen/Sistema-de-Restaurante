import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { reverseForOrder } from '../lib/loyalty';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('RM Cliente VIP: points ledger, redemption as coupon, expiry, adjustments and campaigns', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'f'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 6).toString('base64');
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
    const token = async (role: UserRole) => {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    };
    return { tenant, unit, token };
  };
  const A = await makeTenant('loyal'); const B = await makeTenant('loyalother');
  const admin = await A.token(UserRole.ADMIN); const waiter = await A.token(UserRole.WAITER); const otherAdmin = await B.token(UserRole.ADMIN);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const ids = [A.tenant.id, B.tenant.id];
    await prisma.order.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  const product = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Prato', price: 100 } });
  const sell = async (phone: string, name: string) => {
    const created = await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, customerName: name, customerPhone: phone, marketingConsent: true, items: [{ productId: product.id, quantity: 1 }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body.id as string;
  };
  const complete = async (orderId: string) => { for (const status of ['PREPARING', 'READY', 'COMPLETED']) assert.equal((await call('PATCH', `/orders/${orderId}/status`, admin, { status })).status, 200, status); };

  const orderId = await sell('11999990001', 'Maria Cliente');
  const customer = await prisma.customer.findFirstOrThrow({ where: { tenantId: A.tenant.id, name: 'Maria Cliente' } });

  await t.test('a completed order credits points once and records the ledger', async () => {
    await complete(orderId);
    assert.equal((await call('PATCH', `/orders/${orderId}/status`, admin, { status: 'COMPLETED' })).status, 200, 'repeating the status is accepted');
    const view = await call('GET', `/customers/${customer.id}/loyalty`, admin);
    assert.equal(view.status, 200);
    assert.equal(view.body.balance, 100);
    assert.deepEqual(view.body.entries.map((entry: any) => [entry.type, entry.points, entry.balanceAfter]), [['EARN', 100, 100]]);
  });

  await t.test('a cancelled sale gives its points back exactly once', async () => {
    const second = await sell('11999990001', 'Maria Cliente');
    await complete(second);
    assert.equal((await call('GET', `/customers/${customer.id}/loyalty`, admin)).body.balance, 200);
    const first = await prisma.$transaction(tx => reverseForOrder(tx, { id: second, tenantId: A.tenant.id, customerId: customer.id }));
    assert.equal(first?.points, -100);
    assert.equal(await prisma.$transaction(tx => reverseForOrder(tx, { id: second, tenantId: A.tenant.id, customerId: customer.id })), null);
    assert.equal((await call('GET', `/customers/${customer.id}/loyalty`, admin)).body.balance, 100);
  });

  await t.test('redeeming creates a single-use coupon and debits the balance; invalid redemptions change nothing', async () => {
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/redeem`, waiter, { points: 50 })).status, 400, 'below the minimum');
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/redeem`, waiter, { points: 500 })).status, 409, 'insufficient balance');
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/redeem`, otherAdmin, { points: 100 })).status, 409, 'another tenant cannot spend this customer\'s points');
    const redeemed = await call('POST', `/customers/${customer.id}/loyalty/redeem`, waiter, { points: 100 });
    assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
    assert.equal(redeemed.body.value, 5);
    assert.equal(redeemed.body.balance, 0);
    const coupon = await prisma.coupon.findFirstOrThrow({ where: { tenantId: A.tenant.id, code: redeemed.body.code } });
    assert.equal(coupon.maxUses, 1);
    assert.equal(Number(coupon.value), 5);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints, 0);
  });

  await t.test('manual adjustments are manager-only, justified and cannot make the balance negative', async () => {
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/adjust`, waiter, { points: 10, note: 'cortesia' })).status, 403);
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/adjust`, admin, { points: 10 })).status, 400);
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/adjust`, admin, { points: -10, note: 'erro de lançamento' })).status, 409);
    assert.equal((await call('POST', `/customers/${customer.id}/loyalty/adjust`, admin, { points: 40, note: 'bônus de boas-vindas' })).status, 201);
    assert.equal((await call('GET', `/customers/${customer.id}/loyalty`, admin)).body.balance, 40);
  });

  await t.test('idle points expire only when a validity is configured, and the expiry is recorded', async () => {
    assert.equal((await call('PUT', '/settings/loyalty', admin, { enabled: true, pointsPerReal: 1, redeemValuePerPoint: 0.05, minRedeemPoints: 10, validityDays: 30, couponValidDays: 30 })).status, 200);
    await prisma.loyaltyEntry.updateMany({ where: { customerId: customer.id, type: 'EARN' }, data: { createdAt: new Date(Date.now() - 60 * 86_400_000) } });
    const view = await call('GET', `/customers/${customer.id}/loyalty`, admin);
    assert.equal(view.body.balance, 0);
    assert.equal(view.body.entries[0].type, 'EXPIRE');
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).loyaltyPoints, 0);
  });

  await t.test('birthday campaign lists only consenting customers born this month, for managers only', async () => {
    const today = new Date();
    const birthDate = `1990-${String(today.getUTCMonth() + 1).padStart(2, '0')}-15`;
    assert.equal((await call('PATCH', `/customers/${customer.id}`, admin, { birthDate })).status, 200);
    assert.equal((await call('PATCH', `/customers/${customer.id}`, admin, { birthDate: '2999-01-01' })).status, 400, 'future dates are rejected');
    const list = await call('GET', '/customers/campaigns?type=birthday', admin);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.items.map((item: any) => item.name), ['Maria Cliente']);
    await prisma.customer.update({ where: { id: customer.id }, data: { marketingConsent: false } });
    assert.equal((await call('GET', '/customers/campaigns?type=birthday', admin)).body.total, 0, 'no consent, no campaign');
    assert.equal((await call('GET', '/customers/campaigns?type=birthday', waiter)).status, 403);
    assert.equal((await call('GET', '/customers/campaigns?type=birthday', otherAdmin)).body.total, 0, 'tenant isolation');
    assert.equal((await call('GET', '/customers/campaigns?type=inactive&days=10', admin)).status, 400);
    assert.equal((await call('GET', '/customers/campaigns?type=inactive&days=90', admin)).status, 200);
  });
});
