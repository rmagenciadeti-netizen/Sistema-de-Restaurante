import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

test('product categories and bulk pricing', { skip: process.env.RUN_DB_TESTS !== '1' }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function call<T = unknown>(method: string, path: string, token?: string, body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() as T };
  }
  const suffix = randomBytes(6).toString('hex');
  const tenants: string[] = [];
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.$disconnect();
  });
  async function setup(label: string) {
    const tenant = await prisma.tenant.create({ data: { name: label, slug: `${label}-${suffix}`, status: 'ACTIVE' } });
    tenants.push(tenant.id);
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const admin = await prisma.user.create({ data: { tenantId: tenant.id, unitId: unit.id, name: 'Admin', email: `admin-${label}-${suffix}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
    const waiter = await prisma.user.create({ data: { tenantId: tenant.id, unitId: unit.id, name: 'Garçom', email: `waiter-${label}-${suffix}@test.local`, passwordHash: 'x', role: UserRole.WAITER } });
    const token = (userId: string, role: UserRole) => signAccessToken({ userId, tenantId: tenant.id, unitId: unit.id, role });
    return { tenant, unit, admin: token(admin.id, UserRole.ADMIN), waiter: token(waiter.id, UserRole.WAITER) };
  }
  const A = await setup('products-a');
  const B = await setup('products-b');

  await t.test('categories are tenant-isolated and group products in the QR menu', async () => {
    const soda = await prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, name: 'Refrigerante', price: 6.5 } });
    const created = await call<{ id: string; name: string }>('POST', '/products/categories', A.admin, { name: ' Bebidas ' });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, 'Bebidas');
    assert.equal((await call('POST', '/products/categories', A.admin, { name: 'Bebidas' })).status, 409);
    assert.equal((await call('POST', '/products/categories', A.waiter, { name: 'Proibido' })).status, 403);
    assert.equal((await call('PATCH', `/products/categories/${created.body.id}`, B.admin, { name: 'Outro tenant' })).status, 404);
    assert.equal((await call('PATCH', `/products/${soda.id}`, B.admin, { categoryId: created.body.id })).status, 404);
    const other = await call<{ id: string }>('POST', '/products/categories', B.admin, { name: 'Categoria externa' });
    assert.equal((await call('PATCH', `/products/${soda.id}`, A.admin, { categoryId: other.body.id })).status, 400);
    assert.equal((await call('PATCH', `/products/${soda.id}`, A.admin, { categoryId: created.body.id })).status, 200);
    assert.equal((await call('PATCH', `/products/categories/${created.body.id}`, A.admin, { name: 'Bebidas geladas' })).status, 200);
    const table = await prisma.restaurantTable.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, label: 'Categoria', qrToken: randomBytes(24).toString('hex') } });
    const menu = await call<{ categories: { id: string; name: string; products: { id: string }[] }[] }>('GET', `/public/tables/${table.qrToken}/menu`);
    const group = menu.body.categories.find(item => item.id === created.body.id);
    assert.equal(group?.name, 'Bebidas geladas');
    assert.equal(group?.products[0].id, soda.id);
    const list = await call<{ items: { id: string }[] }>('GET', '/products/categories', B.admin);
    assert.equal(list.body.items.some(item => item.id === created.body.id), false);
  });

  await t.test('bulk price changes are authorized, isolated and atomic', async () => {
    const first = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Preço A', price: '10.00', unitId: A.unit.id } });
    const second = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Preço B', price: '20.00', unitId: A.unit.id } });
    const otherUnit = await prisma.unit.create({ data: { tenantId: A.tenant.id, name: 'Outra unidade' } });
    const restricted = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Preço de outra unidade', price: '30.00', unitId: otherUnit.id } });
    const foreign = await prisma.product.create({ data: { tenantId: B.tenant.id, name: 'Outro tenant', price: '40.00' } });
    const update = (token: string, items: unknown[]) => call('PATCH', '/products/prices/bulk', token, { items });
    const change = { id: first.id, expectedPrice: '10.00', price: '11.25' };
    assert.equal((await update(A.waiter, [change])).status, 403);
    assert.equal((await update(A.admin, [change, change])).status, 400);
    assert.equal((await update(A.admin, [change, { ...change, id: first.id.toUpperCase() }])).status, 400);
    assert.equal((await update(A.admin, [{ ...change, price: '1.234' }])).status, 400);
    assert.equal((await update(A.admin, [change, { id: second.id, expectedPrice: '19.00', price: '22.00' }])).status, 409);
    assert.equal((await update(A.admin, [change, { id: restricted.id, expectedPrice: '30.00', price: '31.00' }])).status, 409);
    assert.equal((await update(A.admin, [change, { id: foreign.id, expectedPrice: '40.00', price: '41.00' }])).status, 409);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: first.id } })).price), 10);
    assert.equal(await prisma.auditLog.count({ where: { tenantId: A.tenant.id, action: 'PRODUCT_PRICE_UPDATED', entityId: first.id } }), 0);
    assert.equal((await update(A.admin, [change, { id: second.id, expectedPrice: '20.00', price: '22.00' }])).status, 200);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: first.id } })).price), 11.25);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: second.id } })).price), 22);
    assert.equal(await prisma.auditLog.count({ where: { tenantId: A.tenant.id, action: 'PRODUCT_PRICE_UPDATED', entityId: { in: [first.id, second.id] } } }), 2);
  });
});
