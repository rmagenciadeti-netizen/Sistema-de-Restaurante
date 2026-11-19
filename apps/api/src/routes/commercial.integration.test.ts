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

test('commercial management: plans, modules, coupons, invoices and entitlements', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'c'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.DEV_DISABLE_MFA = 'true';
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

  const id = suffix();
  const master = await prisma.user.create({ data: { name: 'Master', email: `master-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  const tenant = await prisma.tenant.create({ data: { name: `Com ${id}`, slug: `com-${id}`, status: 'ACTIVE' } });
  const other = await prisma.tenant.create({ data: { name: `Outro ${id}`, slug: `outro-${id}`, status: 'ACTIVE' } });
  const admin = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Admin', email: `admin-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const adminToken = signAccessToken({ userId: admin.id, tenantId: tenant.id, unitId: null, role: UserRole.ADMIN });
  const planKeys: string[] = [];
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.saaSCoupon.deleteMany({ where: { code: { startsWith: `T${id.toUpperCase()}` } } });
    await prisma.saaSModule.deleteMany({ where: { key: `crm-${id}` } });
    await prisma.saaSPlan.deleteMany({ where: { key: { in: planKeys } } });
    await prisma.auditLog.deleteMany({ where: { actorUserId: master.id } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
    await prisma.user.deleteMany({ where: { id: master.id } });
    await prisma.saaSModule.updateMany({ where: { key: 'delivery' }, data: { blocked: false } });
    await prisma.$disconnect();
  });

  let planId = '';
  await t.test('module catalog: new modules without a real feature cannot be sold in plans', async () => {
    assert.equal((await call('GET', '/commercial/modules', adminToken)).status, 403, 'tenants cannot reach the commercial admin');
    const created = await call('POST', '/commercial/modules', masterToken, { key: `crm-${id}`, name: 'CRM Teste', category: 'Relacionamento', monthlyPrice: 49.9, dependsOn: [] });
    assert.equal(created.status, 201);
    assert.equal(created.body.featureLinked, false);
    const rejected = await call('POST', '/plans', masterToken, { key: `bad-${id}`, name: 'Plano Inválido', modules: [`crm-${id}`], prices: [{ period: 'MONTHLY', amount: 10 }] });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /não implementado/);
    assert.equal((await call('POST', '/commercial/modules', masterToken, { key: `crm-${id}`, name: 'Duplicado' })).status, 409);
  });

  await t.test('plans: create, edit prices, optional modules, archive and audit', async () => {
    planKeys.push(`plan-${id}`);
    const created = await call('POST', '/plans', masterToken, {
      key: `plan-${id}`, name: 'RM TESTE', status: 'ACTIVE', modules: ['pos', 'financial'], optionalModules: [{ key: 'delivery', priceOverride: 20 }],
      prices: [{ period: 'MONTHLY', amount: 200 }, { period: 'ANNUAL', amount: 2000 }], activationFee: 100, headline: 'Plano de teste', benefits: ['A', 'B'],
    });
    assert.equal(created.status, 201);
    planId = created.body.id;
    assert.deepEqual(created.body.optionalModules.map((item: { key: string }) => item.key), ['delivery']);
    assert.equal((await call('POST', '/plans', masterToken, { key: `dup-${id}`, name: 'Conflito', modules: ['pos'], optionalModules: [{ key: 'pos' }], prices: [] })).status, 400);
    const edited = await call('PUT', `/plans/${planId}`, masterToken, { key: `plan-${id}`, name: 'RM TESTE', status: 'ACTIVE', modules: ['pos', 'financial'], optionalModules: [{ key: 'delivery', priceOverride: 20 }], prices: [{ period: 'MONTHLY', amount: 250 }], activationFee: 100, reason: 'Reajuste' });
    assert.equal(edited.status, 200);
    assert.equal(Number(edited.body.prices[0].amount), 250);
    const log = await prisma.auditLog.findFirst({ where: { action: 'SAAS_PLAN_UPDATED', entityId: planId } });
    assert.ok(log, 'price change is audited');
    assert.equal((log!.metadata as any).reason, 'Reajuste');
    const history = await call('GET', `/plans/${planId}/history`, masterToken);
    assert.equal(history.status, 200);
    assert.ok(history.body.items.some((item: any) => item.action === 'SAAS_PLAN_UPDATED' && item.metadata.reason === 'Reajuste'), 'history lists the price change');
  });

  await t.test('contract, entitlements and add-on modules are enforced by the backend', async () => {
    const license = await call('PUT', `/tenants/${tenant.id}/license`, masterToken, { status: 'ACTIVE', planId, billingPeriod: 'MONTHLY', modules: ['pos', 'financial'], reason: 'Contratação' });
    assert.equal(license.status, 200);
    assert.equal(Number(license.body.license.contractedPrice), 250);
    assert.equal((await call('GET', '/couriers', adminToken)).status, 403, 'delivery not contracted');
    assert.equal((await call('GET', '/cash/sessions', adminToken)).status === 403, false, 'financial contracted');

    const added = await call('PUT', `/commercial/tenants/${tenant.id}/addons`, masterToken, { moduleKey: 'delivery', action: 'ADD', discountPercent: 10, reason: 'Contratação avulsa' });
    assert.equal(added.status, 200);
    assert.equal((await call('GET', '/couriers', adminToken)).status, 200, 'add-on grants access');
    assert.equal((await call('PUT', `/commercial/tenants/${tenant.id}/addons`, masterToken, { moduleKey: 'delivery', action: 'ADD', reason: 'dup' })).status, 409);
    assert.equal((await call('PUT', `/commercial/tenants/${tenant.id}/addons`, masterToken, { moduleKey: `crm-${id}`, action: 'ADD', reason: 'x' })).status, 400, 'unlinked module');

    await call('PUT', `/commercial/tenants/${tenant.id}/addons`, masterToken, { moduleKey: 'delivery', action: 'BLOCK', reason: 'Inadimplência' });
    assert.equal((await call('GET', '/couriers', adminToken)).status, 403, 'tenant-level block');
    await call('PUT', `/commercial/tenants/${tenant.id}/addons`, masterToken, { moduleKey: 'delivery', action: 'UNBLOCK', reason: 'Regularizado' });
    assert.equal((await call('GET', '/couriers', adminToken)).status, 200);

    const global = await prisma.saaSModule.findUniqueOrThrow({ where: { key: 'delivery' } });
    await call('PATCH', `/commercial/modules/${global.id}/state`, masterToken, { action: 'BLOCK', reason: 'Manutenção' });
    assert.equal((await call('GET', '/couriers', adminToken)).status, 403, 'global block');
    await call('PATCH', `/commercial/modules/${global.id}/state`, masterToken, { action: 'UNBLOCK', reason: 'Fim da manutenção' });
    assert.equal((await call('GET', '/couriers', adminToken)).status, 200);

    const history = await call('GET', `/commercial/tenants/${tenant.id}`, masterToken);
    assert.ok(history.body.history.some((entry: { action: string }) => entry.action === 'ADDON_BLOCK'));
    assert.equal((await call('GET', `/commercial/tenants/${other.id}`, adminToken)).status, 403);
  });

  await t.test('coupons and invoices: pricing, limits, duplicates, payment and cancellation', async () => {
    const code = `T${id.toUpperCase()}`;
    const coupon = await call('POST', '/commercial/coupons', masterToken, { code, name: 'Teste', discountType: 'PERCENT', discountValue: 10, planIds: [planId], maxUses: 5, perTenantLimit: 1, cycles: 1, audience: 'BOTH' });
    assert.equal(coupon.status, 201);
    assert.equal((await call('POST', '/commercial/coupons', masterToken, { code, name: 'Dup', discountType: 'FIXED', discountValue: 5 })).status, 409);
    assert.equal((await call('POST', '/commercial/coupons/validate', masterToken, { tenantId: other.id, couponCode: code })).status, 400, 'tenant without subscription');

    // plan 250 + add-on delivery (20 override, 10% off = 18) = 268; coupon 10% = 26.80; activation fee 100 not discounted.
    const quote = await call('POST', '/commercial/invoices/quote', masterToken, { tenantId: tenant.id, couponCode: code });
    assert.equal(quote.status, 200);
    assert.equal(quote.body.quote.discount, 26.8);
    assert.equal(quote.body.quote.total, 341.2);

    const due = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const invoice = await call('POST', '/commercial/invoices', masterToken, { tenantId: tenant.id, couponCode: code, dueDate: due });
    assert.equal(invoice.status, 201);
    assert.equal(Number(invoice.body.total), 341.2);
    assert.equal((await call('POST', '/commercial/invoices', masterToken, { tenantId: tenant.id, dueDate: due })).status, 409, 'no duplicate charge for the same competence');
    assert.equal((await call('POST', '/commercial/coupons/validate', masterToken, { tenantId: tenant.id, couponCode: code })).status, 400, 'per-tenant limit reached');
    assert.equal((await call('GET', `/commercial/coupons/${coupon.body.id}/redemptions`, masterToken)).body.items.length, 1);

    const cancelled = await call('POST', `/commercial/invoices/${invoice.body.id}/cancel`, masterToken, { reason: 'Reemissão' });
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.equal((await call('GET', `/commercial/coupons/${coupon.body.id}/redemptions`, masterToken)).body.items.length, 0, 'cancelling releases the coupon');

    const second = await call('POST', '/commercial/invoices', masterToken, { tenantId: tenant.id, dueDate: due });
    assert.equal(second.status, 201);
    assert.equal(Number(second.body.total), 368, 'activation fee is billed again only because the first invoice was cancelled');
    const paid = await call('POST', `/commercial/invoices/${second.body.id}/pay`, masterToken, { method: 'PIX', reference: 'E2E123' });
    assert.equal(paid.body.status, 'PAID');
    assert.equal((await call('POST', `/commercial/invoices/${second.body.id}/pay`, masterToken, { method: 'PIX' })).status, 409, 'payment is not registered twice');
    assert.equal((await call('POST', `/commercial/invoices/${second.body.id}/cancel`, masterToken, { reason: 'Tentativa' })).status, 409);
    const refreshed = await prisma.tenantLicense.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    assert.ok(refreshed.validUntil && refreshed.validUntil.getTime() > Date.now() + 25 * 86_400_000, 'license renewed by the paid period');

    const overview = await call('GET', '/commercial/overview', masterToken);
    assert.equal(overview.status, 200);
    assert.ok(overview.body.revenue.received >= 368);
    assert.ok(overview.body.revenue.mrr >= 268);
    assert.ok(overview.body.byPlan.some((plan: { id: string; subscriptions: number }) => plan.id === planId && plan.subscriptions === 1));
    assert.equal((await call('GET', '/commercial/invoices?status=PAID', masterToken)).body.items.some((item: { id: string }) => item.id === second.body.id), true);
  });

  await t.test('suspension and grace period', async () => {
    assert.equal((await call('POST', `/commercial/tenants/${tenant.id}/access`, masterToken, { action: 'SUSPEND', reason: 'Inadimplência' })).status, 200);
    assert.equal((await call('GET', '/couriers', adminToken)).status, 403);
    await call('POST', `/commercial/tenants/${tenant.id}/access`, masterToken, { action: 'REACTIVATE', reason: 'Pago' });
    await prisma.tenantLicense.update({ where: { tenantId: tenant.id }, data: { validUntil: new Date(Date.now() - 2 * 86_400_000), graceDays: 0 } });
    assert.equal((await call('GET', '/couriers', adminToken)).status, 403, 'expired');
    await prisma.tenantLicense.update({ where: { tenantId: tenant.id }, data: { graceDays: 5 } });
    assert.equal((await call('GET', '/couriers', adminToken)).status, 200, 'inside the grace period');
    assert.ok(await prisma.auditLog.findFirst({ where: { action: 'SUBSCRIPTION_SUSPENDED', tenantId: tenant.id } }));
  });
});
