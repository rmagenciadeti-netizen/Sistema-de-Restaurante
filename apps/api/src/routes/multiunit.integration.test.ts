import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('multi-unit: prices per unit, consolidated comparison and unit isolation', { skip: !enabled }, async t => {
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
  const tenant = await prisma.tenant.create({ data: { name: `net ${id}`, slug: `net-${id}`, status: 'ACTIVE' } });
  const other = await prisma.tenant.create({ data: { name: `netother ${id}`, slug: `netother-${id}`, status: 'ACTIVE' } });
  const north = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Norte' } });
  const south = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Sul' } });
  const otherUnit = await prisma.unit.create({ data: { tenantId: other.id, name: 'Outra' } });
  const person = async (tenantId: string, role: UserRole, unitId: string | null, tag: string) => {
    const user = await prisma.user.create({ data: { tenantId, unitId, name: `${role}${tag}`, email: `${role}-${tag}-${id}@test.local`, passwordHash: 'x', role } });
    return signAccessToken({ userId: user.id, tenantId, unitId, role });
  };
  const owner = await person(tenant.id, UserRole.ADMIN, null, 'owner'); const northManager = await person(tenant.id, UserRole.MANAGER, north.id, 'north'); const southCashier = await person(tenant.id, UserRole.CASHIER, south.id, 'south');
  const northCashier = await person(tenant.id, UserRole.CASHIER, north.id, 'northcash'); const otherOwner = await person(other.id, UserRole.ADMIN, null, 'other');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenant.id, other.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
    await prisma.$disconnect();
  });
  const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Prato', price: 30 } });
  const sell = (token: string, unitId: string) => call('POST', '/orders', token, { unitId, items: [{ productId: product.id, quantity: 1 }] });

  await t.test('a unit sells at its own price; the others keep the base price', async () => {
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${north.id}`, owner, { price: 35 })).status, 204);
    const northOrder = await sell(northCashier, north.id); const southOrder = await sell(southCashier, south.id);
    assert.equal(northOrder.status, 201, JSON.stringify(northOrder.body)); assert.equal(Number(northOrder.body.total), 35);
    assert.equal(Number(southOrder.body.total), 30);
    const northList = await call('GET', '/products', northCashier);
    assert.equal(Number(northList.body.items.find((item: any) => item.id === product.id).price), 35);
    assert.equal(Number((await call('GET', '/products', southCashier)).body.items.find((item: any) => item.id === product.id).price), 30);
    const prices = await call('GET', `/products/${product.id}/unit-prices`, owner);
    assert.deepEqual(prices.body.items.map((item: any) => [item.unit, item.price === null ? null : Number(item.price)]), [['Norte', 35], ['Sul', null]]);
  });

  await t.test('price management is limited to managers, their own unit and their own restaurant', async () => {
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${north.id}`, northCashier, { price: 1 })).status, 403);
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${south.id}`, northManager, { price: 1 })).status, 403);
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${north.id}`, otherOwner, { price: 1 })).status, 404);
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${otherUnit.id}`, owner, { price: 1 })).status, 404);
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${north.id}`, northManager, { price: 40 })).status, 204);
    assert.equal((await call('PUT', `/products/${product.id}/unit-prices/${north.id}`, northManager, { price: null })).status, 204);
    assert.equal(Number((await sell(northCashier, north.id)).body.total), 30, 'removing the override restores the base price');
  });

  await t.test('network comparison: consolidated by the owner, closed to unit-bound users and other restaurants', async () => {
    const orders = await prisma.order.findMany({ where: { tenantId: tenant.id } });
    await prisma.order.updateMany({ where: { id: { in: orders.map(order => order.id) } }, data: { status: 'COMPLETED' } });
    const result = await call('GET', '/network/comparison', owner);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const byName = Object.fromEntries(result.body.units.map((unit: any) => [unit.name, unit]));
    assert.equal(byName.Norte.revenue, 65); assert.equal(byName.Norte.orders, 2);
    assert.equal(byName.Sul.revenue, 30);
    assert.equal(result.body.totals.revenue, 95);
    assert.equal((await call('GET', '/network/comparison', northManager)).status, 403);
    assert.equal((await call('GET', '/network/comparison', otherOwner)).body.totals.revenue, 0);
  });
});
