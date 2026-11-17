import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

const enabled = process.env.RUN_DB_TESTS === '1';

test('settings, admin password and password releases', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const id = randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Settings ${id}`, slug: `settings-${id}`, status: 'ACTIVE' } });
  const other = await prisma.tenant.create({ data: { name: `Other ${id}`, slug: `other-${id}`, status: 'ACTIVE' } });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenant.id, other.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
    await prisma.$disconnect();
  });
  const tokens: Partial<Record<UserRole, string>> = {};
  const userIds: Partial<Record<UserRole, string>> = {};
  for (const role of [UserRole.ADMIN, UserRole.MANAGER, UserRole.CASHIER, UserRole.WAITER]) {
    const user = await prisma.user.create({ data: { tenantId: tenant.id, name: `User ${role}`, email: `${role}-${id}@test.local`, passwordHash: 'x', role } });
    userIds[role] = user.id;
    tokens[role] = signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
  }
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const admin = tokens.ADMIN!; const manager = tokens.MANAGER!; const cashier = tokens.CASHIER!; const waiter = tokens.WAITER!;

  await t.test('GET returns defaults for every role and never exposes the hash', async () => {
    const response = await call('GET', '/settings', waiter);
    assert.equal(response.status, 200);
    assert.equal(response.body.hasAdminPassword, false);
    assert.equal(response.body.settings.hours.mode, 'OPEN');
    assert.equal(response.body.settings.orderStatuses.items.length > 0, true);
    assert.equal(JSON.stringify(response.body).includes('adminPasswordHash'), false);
  });

  await t.test('PUT validates, saves and audits a section', async () => {
    assert.equal((await call('PUT', '/settings/unknown', admin, {})).status, 404);
    assert.equal((await call('PUT', '/settings/scheduling', admin, { enabled: true, blockedFrom: '2026-12-25', blockedTo: '2026-12-24' })).status, 400);
    assert.equal((await call('PUT', '/settings/scheduling', admin, { enabled: true, slots: [{ day: 1, start: '12:00', end: '10:00' }] })).status, 400);
    assert.equal((await call('PUT', '/settings/hours', admin, { mode: 'SCHEDULE', weekly: [{ day: 1, start: '18:00', end: '09:00' }] })).status, 400);
    assert.equal((await call('PUT', '/settings/store', admin, { brandColor: 'red' })).status, 400);
    assert.equal((await call('PUT', '/settings/store', admin, { metaPixelId: '123<script>' })).status, 400, 'pixel id is digits only');
    assert.equal((await call('PUT', '/settings/pdv', admin, { usdRate: -1 })).status, 400, 'rates cannot be negative');
    assert.equal((await call('PUT', '/settings/pdv', admin, { defaultOrderStatus: 'COMPLETED' })).status, 400);
    assert.equal((await call('PUT', '/settings/company', admin, { sidebarLayout: 'WIDE' })).status, 400);
    assert.equal((await call('PUT', '/settings/company', admin, { dpoEmail: 'not-an-email' })).status, 400);
    const company = await call('PUT', '/settings/company', admin, { dpoName: 'Responsável', dpoEmail: 'dpo@example.com' });
    assert.equal(company.status, 200);
    assert.equal(company.body.value.dpoEmail, 'dpo@example.com');
    const saved = await call('PUT', '/settings/hours', manager, { mode: 'CLOSED' });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.section, 'hours');
    assert.equal(saved.body.value.mode, 'CLOSED');
    assert.equal((await call('GET', '/settings', admin)).body.settings.hours.mode, 'CLOSED');
    assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, action: 'SETTINGS_UPDATED' } }), 2);
  });

  await t.test('roles without permission get 403', async () => {
    assert.equal((await call('PUT', '/settings/hours', cashier, { mode: 'OPEN' })).status, 403);
    assert.equal((await call('POST', '/settings/admin-password', manager, { password: '1234' })).status, 403);
    assert.equal((await call('GET', '/releases', cashier)).status, 403);
  });

  await t.test('release needs a configured password', async () => {
    assert.equal((await call('POST', '/releases', cashier, { action: 'OTHER', password: '1234' })).status, 409);
  });

  await t.test('admin password can be set, checked, rate limited and removed', async () => {
    assert.equal((await call('POST', '/settings/admin-password', admin, { password: '12' })).status, 400);
    const set = await call('POST', '/settings/admin-password', admin, { password: 'senha-caixa' });
    assert.equal(set.status, 200);
    assert.equal((await call('GET', '/settings', admin)).body.hasAdminPassword, true);
    const audit = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: 'ADMIN_PASSWORD_SET' } });
    assert.equal(JSON.stringify(audit).includes('senha-caixa'), false);

    const foreignOrder = await prisma.order.create({ data: { tenantId: other.id, code: `X-${id}`, subtotal: 1, total: 1 } });
    assert.equal((await call('POST', '/releases', cashier, { action: 'CANCEL_ORDER', password: 'senha-caixa', orderId: foreignOrder.id })).status, 404);

    const ok = await call('POST', '/releases', cashier, { action: 'CASH_WITHDRAWAL', password: 'senha-caixa', reason: 'Sangria' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.id && ok.body.authorizedAt);

    for (let attempt = 0; attempt < 5; attempt += 1) assert.equal((await call('POST', '/releases', waiter, { action: 'DISCOUNT', password: 'errada' })).status, 403);
    assert.equal((await call('POST', '/releases', waiter, { action: 'DISCOUNT', password: 'senha-caixa' })).status, 429);
    assert.equal((await call('POST', '/releases', cashier, { action: 'OTHER', password: 'senha-caixa' })).status, 200, 'limit is per user');

    const history = await call('GET', '/releases?pageSize=10', manager);
    assert.equal(history.status, 200);
    assert.equal(history.body.total, 2);
    assert.equal(history.body.items[0].requestedByName, `User ${UserRole.CASHIER}`);
    assert.equal((await call('GET', '/releases?from=2999-01-01', manager)).body.total, 0);

    assert.equal((await call('POST', '/settings/admin-password', admin, { password: null })).status, 200);
    assert.equal((await call('GET', '/settings', admin)).body.hasAdminPassword, false);
  });
  await t.test('online table and tab orders require a single-use administrator release when configured', async () => {
    assert.equal((await call('POST', '/settings/admin-password', admin, { password: 'senha-caixa' })).status, 200);
    assert.equal((await call('PUT', '/settings/pdv', admin, { requireAdminPasswordOnline: true })).status, 200);
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Mesas autorizadas' } });
    const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Pedido autorizado', price: 10 } });
    const body = { unitId: unit.id, channel: 'TABLE', tableLabel: 'A1', items: [{ productId: product.id, quantity: 1 }] };
    assert.equal((await call('POST', '/orders', cashier, body)).body.message, 'ORDER_RELEASE_REQUIRED');

    const release = await call('POST', '/releases', cashier, { action: 'OTHER', password: 'senha-caixa', reason: 'PDV_TABLE_ORDER' });
    assert.equal(release.status, 200);
    const order = await call('POST', '/orders', cashier, { ...body, orderReleaseId: release.body.id });
    assert.equal(order.status, 201);
    assert.equal((await prisma.passwordRelease.findUniqueOrThrow({ where: { id: release.body.id } })).orderId, order.body.id);
    assert.equal((await call('POST', '/orders', cashier, { ...body, tableLabel: 'A2', orderReleaseId: release.body.id })).body.message, 'ORDER_RELEASE_REQUIRED');

    await call('PUT', '/settings/pdv', admin, { requireAdminPasswordOnline: false });
    await call('POST', '/settings/admin-password', admin, { password: null });
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });
  await t.test('order counter can be set by managers and drives the next number', async () => {
    assert.equal((await call('PUT', '/settings/order-counter', admin, { current: -1 })).status, 400);
    assert.equal((await call('PUT', '/settings/order-counter', admin, { current: 1.5 })).status, 400);
    assert.equal((await call('PUT', '/settings/order-counter', manager, { current: 99 })).body.orderCounter, 99);
    assert.equal((await call('GET', '/settings', admin)).body.orderCounter, 99);
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Contador', price: 10 } });
    const order = await call('POST', '/orders', admin, { unitId: unit.id, channel: 'POS', items: [{ productId: product.id, quantity: 1 }] });
    assert.equal(order.status, 201);
    assert.equal(order.body.number, 100);
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } }); await prisma.product.delete({ where: { id: product.id } });
  });
  await t.test('PDV default status starts orders in preparation and consumes stock atomically', async () => {
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Status PDV' } });
    const ingredient = await prisma.ingredient.create({ data: { tenantId: tenant.id, name: 'Farinha', unitOfMeasure: 'kg', currentStock: 5 } });
    const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Pão', price: 10 } });
    await prisma.recipe.create({ data: { tenantId: tenant.id, productId: product.id, yield: 1, ingredients: { create: { ingredientId: ingredient.id, quantity: 1 } } } });
    assert.equal((await call('PUT', '/settings/pdv', admin, { defaultOrderStatus: 'PREPARING' })).status, 200);
    const order = await call('POST', '/orders', admin, { unitId: unit.id, channel: 'POS', items: [{ productId: product.id, quantity: 2 }] });
    assert.equal(order.status, 201);
    assert.equal(order.body.status, 'PREPARING');
    assert.equal(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).currentStock), 3);
    await prisma.ingredient.update({ where: { id: ingredient.id }, data: { currentStock: 1 } });
    const insufficient = await call('POST', '/orders', admin, { unitId: unit.id, channel: 'POS', items: [{ productId: product.id, quantity: 2 }] });
    assert.equal(insufficient.status, 409);
    assert.equal(insufficient.body.message, 'Insufficient stock for this order');
    await call('PUT', '/settings/pdv', admin, { defaultOrderStatus: 'OPEN' });
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.stockMovement.deleteMany({ where: { ingredientId: ingredient.id } });
    await prisma.product.delete({ where: { id: product.id } });
    await prisma.ingredient.delete({ where: { id: ingredient.id } });
  });
  await t.test('seller selection: only active sales staff of the tenant can receive the sale', async () => {
    const sellers = await call('GET', '/orders/sellers', cashier);
    assert.equal(sellers.status, 200);
    assert.ok(sellers.body.items.some((item: any) => item.id === userIds.WAITER));
    assert.equal(sellers.body.items.some((item: any) => 'email' in item || 'passwordHash' in item), false, 'only id, name and role are exposed');
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Vendedores' } });
    const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Vendido', price: 10 } });
    const foreignUser = await prisma.user.create({ data: { tenantId: other.id, name: 'Alheio', email: `alheio-${id}@test.local`, passwordHash: 'x', role: UserRole.WAITER } });
    const base = { unitId: unit.id, channel: 'POS', items: [{ productId: product.id, quantity: 1 }] };
    assert.equal((await call('POST', '/orders', cashier, { ...base, sellerId: foreignUser.id })).body.message, 'SELLER_INVALID');
    const sold = await call('POST', '/orders', cashier, { ...base, sellerId: userIds.WAITER });
    assert.equal(sold.status, 201);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: sold.body.id } })).createdByUserId, userIds.WAITER);
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } }); await prisma.product.delete({ where: { id: product.id } });
  });
});
