import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { buildScaleBarcode } from '../lib/scale';
import { loadSettings, saveSettingsSection } from '../lib/settings';
import { localParts } from '../lib/scheduling';

test('catalog tools: bulk price adjustment, scale lookup/export and category schedules', { skip: process.env.RUN_DB_TESTS !== '1' }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  async function call<T = any>(method: string, path: string, token?: string, body?: unknown) {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await response.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* plain text body */ }
    return { status: response.status, body: json as T, text, headers: response.headers };
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
  const A = await setup('catalog-a');
  const B = await setup('catalog-b');

  await t.test('product display and POS free-price options are persisted', async () => {
    const created = await call('POST', '/products', A.admin, { name: 'Preço variável', price: 12, allowFreePrice: true, alwaysShowDescription: true, allowFractionalQuantity: true, pickupTicket: true });
    assert.equal(created.status, 201);
    assert.equal(created.body.allowFreePrice, true);
    assert.equal(created.body.alwaysShowDescription, true);
    assert.equal(created.body.allowFractionalQuantity, true);
    assert.equal(created.body.pickupTicket, true);
    const updated = await call('PATCH', `/products/${created.body.id}`, A.admin, { allowFreePrice: false, alwaysShowDescription: false, allowFractionalQuantity: false, pickupTicket: false });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.allowFreePrice, false);
    assert.equal(updated.body.alwaysShowDescription, false);
    assert.equal(updated.body.allowFractionalQuantity, false);
    assert.equal(updated.body.pickupTicket, false);
    const stored = await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } });
    assert.equal(stored.allowFreePrice, false);
    assert.equal(stored.alwaysShowDescription, false);
    assert.equal(stored.allowFractionalQuantity, false);
    assert.equal(stored.pickupTicket, false);
  });

  await t.test('product stock is tenant-scoped, auditable and rejects negative balances', async () => {
    const invalidInitial = await call('POST', '/products', A.admin, { name: 'Sem controle', price: 4, initialStock: 2 });
    assert.equal(invalidInitial.status, 400);
    const created = await call('POST', '/products', A.admin, { name: 'Produto controlado', price: 7, stockControlled: true, stockMin: 1, initialStock: 3 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.stockQuantity, '3');
    assert.equal((await prisma.productStockMovement.count({ where: { productId: created.body.id } })), 1, 'opening balance creates a movement');

    const movement = (token: string, type: string, action: string, quantity: number) => call('POST', `/products/${created.body.id}/stock-movements`, token, { type, action, quantity });
    assert.equal((await movement(A.waiter, 'PURCHASE', 'ADD', 1)).status, 403, 'stock moves require management');
    assert.equal((await movement(A.admin, 'PURCHASE', 'REMOVE', 1)).status, 400, 'purchase cannot reduce stock');
    const purchase = await movement(A.admin, 'PURCHASE', 'ADD', 1.5);
    assert.equal(purchase.status, 201);
    assert.equal(purchase.body.stockQuantity, '4.5');
    const waste = await movement(A.admin, 'WASTE', 'REMOVE', 0.5);
    assert.equal(waste.status, 201);
    assert.equal(waste.body.stockQuantity, '4');
    assert.equal((await movement(A.admin, 'WASTE', 'REMOVE', 5)).status, 409);
    assert.equal((await movement(B.admin, 'PURCHASE', 'ADD', 1)).status, 404, 'products cannot cross tenants');
    assert.equal((await call('PATCH', `/products/${created.body.id}`, A.admin, { stockControlled: false })).status, 409, 'cannot turn off tracking with stock remaining');
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: created.body.id } })).stockQuantity.toString(), '4');
  });

  await t.test('bulk adjust previews, skips invalid items, applies atomically and stays tenant-scoped', async () => {
    const [cheap, costed, noCost] = await Promise.all([
      prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, name: 'Água', price: 3 } }),
      prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, name: 'Suco', price: 8, cost: 3 } }),
      prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, name: 'Torta', price: 12 } }),
    ]);
    const foreign = await prisma.product.create({ data: { tenantId: B.tenant.id, name: 'Alheio', price: 10 } });
    const productIds = [cheap.id, costed.id, noCost.id, foreign.id];
    assert.equal((await call('POST', '/product-tools/bulk-adjust/preview', A.waiter, { selection: { productIds }, price: { mode: 'ADD', value: 1 } })).status, 403);

    const body = { selection: { productIds }, price: { mode: 'COST_MARGIN', value: 100 }, rounding: 'UP_10C' };
    const preview = await call('POST', '/product-tools/bulk-adjust/preview', A.admin, body);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.total, 3, 'foreign product is not selectable');
    assert.equal(preview.body.changed, 1);
    const byName = Object.fromEntries(preview.body.items.map((item: any) => [item.name, item]));
    assert.equal(byName['Suco'].priceBefore, '8.00');
    assert.equal(byName['Suco'].priceAfter, '6.00');
    assert.equal(byName['Torta'].skipCode, 'NO_COST');
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: costed.id } })).price), 8, 'preview does not persist');

    const decrease = await call('POST', '/product-tools/bulk-adjust/apply', A.admin, { selection: { productIds }, price: { mode: 'SUBTRACT', value: 3 } });
    assert.equal(decrease.status, 200);
    assert.deepEqual(decrease.body, { selected: 3, updated: 2, skipped: 1 });
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: cheap.id } })).price), 3, 'price that would reach zero is untouched');
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: costed.id } })).price), 5);
    assert.equal(Number((await prisma.product.findUniqueOrThrow({ where: { id: foreign.id } })).price), 10);
    assert.equal(await prisma.auditLog.count({ where: { tenantId: A.tenant.id, action: 'PRODUCT_BULK_ADJUST' } }), 1);
  });

  await t.test('scale: product fields, barcode lookup and export file', async () => {
    const create = (extra: object) => call('POST', '/products', A.admin, { name: 'Queijo', price: 40, ...extra });
    assert.equal((await create({ sendToScale: true })).status, 400, 'sendToScale needs scaleCode');
    const queijo = await create({ name: 'Queijo prato', soldByWeight: true, sendToScale: true, scaleCode: 123, scaleDepartment: 2, shelfLifeDays: 30, barcode: '' });
    assert.equal(queijo.status, 201);
    assert.equal(queijo.body.scaleCode, 123);
    assert.equal(queijo.body.barcode, null);
    const duplicate = await create({ name: 'Presunto', scaleCode: 123 });
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.message, /balança/);
    assert.equal((await create({ name: 'Outro tenant', scaleCode: 123, taxRuleId: '00000000-0000-4000-8000-000000000000' })).status, 400);
    const inactive = await create({ name: 'Inativo', soldByWeight: true, sendToScale: true, scaleCode: 124, active: false });
    assert.equal(inactive.status, 201);
    assert.equal((await call('POST', '/products', B.admin, { name: 'Mesmo código em B', price: 5, scaleCode: 123 })).status, 201, 'scaleCode is unique per tenant');

    const config = (await loadSettings(prisma, A.tenant.id)).scale;
    const barcode = buildScaleBarcode({ ...config, saleType: 'WEIGHT' }, 123, 1250);
    const disabled = await call('GET', `/scale/lookup?barcode=${barcode}`, A.waiter);
    assert.equal(disabled.status, 404, 'lookup is off until scale is enabled');
    await saveSettingsSection(prisma, A.tenant.id, 'scale', { ...config, enabled: true, saleType: 'WEIGHT' });
    const weight = await call('GET', `/scale/lookup?barcode=${barcode}`, A.waiter);
    assert.equal(weight.status, 200);
    assert.equal(weight.body.kind, 'WEIGHT');
    assert.equal(weight.body.weightKg, '1.250');
    assert.equal(weight.body.product.id, queijo.body.id);
    assert.equal(weight.body.product.soldByWeight, true);
    assert.equal((await call('GET', `/scale/lookup?barcode=${barcode.slice(0, -1)}0`, A.waiter)).status, 404, 'bad check digit');
    assert.equal((await call('GET', `/scale/lookup?barcode=${buildScaleBarcode({ ...config, saleType: 'WEIGHT' }, 124, 500)}`, A.waiter)).status, 404, 'inactive product');
    assert.equal((await call('GET', `/scale/lookup?barcode=${barcode}`, B.waiter)).status, 404, 'other tenant');
    await saveSettingsSection(prisma, A.tenant.id, 'scale', { ...config, enabled: true, saleType: 'PRICE' });
    const price = await call('GET', `/scale/lookup?barcode=${buildScaleBarcode({ ...config, saleType: 'PRICE' }, 123, 1990)}`, A.waiter);
    assert.equal(price.body.kind, 'PRICE');
    assert.equal(price.body.total, '19.90');

    const list = await call('GET', '/scale/products', A.waiter);
    assert.deepEqual(list.body.items.map((item: any) => item.scaleCode), [123]);
    assert.equal((await call('GET', '/scale/export?brand=TOLEDO', A.waiter)).status, 403);
    assert.equal((await call('GET', '/scale/export?brand=NOPE', A.admin)).status, 400);
    const file = await call('GET', '/scale/export?brand=URANO_URF32', A.admin);
    assert.equal(file.status, 200);
    assert.match(file.headers.get('content-disposition') ?? '', /attachment; filename="URF32\.TXT"/);
    assert.match(file.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(file.text, '000123;0;Queijo prato;40.00;30\r\n');
  });

  await t.test('category windows hide categories on the public menu and promotions show the promo price', async () => {
    const hours = (await loadSettings(prisma, A.tenant.id)).hours;
    const now = localParts(new Date(), hours.timezone);
    const [lunch, always, night] = await Promise.all(['Almoço', 'Sempre', 'Noite'].map(name => prisma.productCategory.create({ data: { tenantId: A.tenant.id, name } })));
    const [, suco, ceia] = await Promise.all([
      prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, categoryId: lunch.id, name: 'Prato feito', price: 30 } }),
      prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, categoryId: always.id, name: 'Suco natural', price: 10 } }),
      prisma.product.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, categoryId: night.id, name: 'Ceia', price: 50 } }),
    ]);
    const table = await prisma.restaurantTable.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, label: 'M1', qrToken: `qr-${suffix}-catalog-tools-token` } });
    const menu = async () => (await call('GET', `/public/tables/${table.qrToken}/menu`)).body.categories.map((category: any) => category.name).filter((name: string) => name !== 'Outros').sort();
    assert.deepEqual(await menu(), ['Almoço', 'Noite', 'Sempre']);

    assert.equal((await call('PUT', `/category-schedules/${lunch.id}`, A.admin, { windows: [{ weekday: 1, startMinute: 600, endMinute: 600 }] })).status, 400, 'start must be before end');
    assert.equal((await call('PUT', `/category-schedules/${lunch.id}`, B.admin, { windows: [] })).status, 404, 'foreign category id is rejected for other tenants');
    assert.equal((await call('PUT', `/category-schedules/${lunch.id}`, A.waiter, { windows: [] })).status, 403);
    const otherDay = (now.weekday + 3) % 7;
    assert.equal((await call('PUT', `/category-schedules/${lunch.id}`, A.admin, { windows: [{ weekday: otherDay, startMinute: 0, endMinute: 1440 }] })).status, 200);
    assert.equal((await call('PUT', `/category-schedules/${night.id}`, A.admin, { windows: [{ weekday: now.weekday, startMinute: 0, endMinute: 1440 }] })).status, 200);
    assert.deepEqual(await menu(), ['Noite', 'Sempre']);

    const listed = await call('GET', '/category-schedules', A.waiter);
    assert.equal(listed.body.items.find((item: any) => item.categoryId === lunch.id).windows.length, 1);
    assert.equal(listed.body.items.find((item: any) => item.categoryId === always.id).windows.length, 0);
    await call('PUT', `/category-schedules/${lunch.id}`, A.admin, { windows: [] });
    assert.deepEqual(await menu(), ['Almoço', 'Noite', 'Sempre'], 'no windows means always visible');

    const startsAt = new Date(Date.now() - 3600_000).toISOString();
    const promo = await call('POST', '/promotions', A.admin, { name: 'Suco em dobro', type: 'PERCENT', value: 20, startsAt, productIds: [suco.id, ceia.id] });
    assert.equal(promo.status, 201);
    assert.equal(promo.body.products.length, 2);
    assert.equal((await call('POST', '/promotions', A.admin, { name: 'Inválida', type: 'FIXED', value: 1, startsAt, productIds: [(await prisma.product.findFirstOrThrow({ where: { tenantId: B.tenant.id } })).id] })).status, 400);
    const pricing = async () => {
      const categories = (await call('GET', `/public/tables/${table.qrToken}/menu`)).body.categories;
      return Object.fromEntries(categories.flatMap((category: any) => category.products).map((product: any) => [product.name, product.promoPrice ?? null]));
    };
    assert.equal((await pricing())['Suco natural'], '8.00');
    assert.equal((await pricing())['Prato feito'], null);
    assert.equal((await call('GET', '/promotions?status=ativas&q=suco', A.waiter)).body.total, 1);
    assert.equal((await call('PATCH', `/promotions/${promo.body.id}`, A.admin, { active: false })).body.status, 'INACTIVE');
    assert.equal((await pricing())['Suco natural'], null);
    assert.equal((await call('GET', '/promotions?status=inativas', A.admin)).body.total, 1);
    assert.equal((await call('GET', '/promotions?status=ativas', A.admin)).body.total, 0);
    await call('PATCH', `/promotions/${promo.body.id}`, A.admin, { active: true, endsAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal((await call('GET', '/promotions?status=expiradas', A.admin)).body.total, 1);
    assert.equal((await call('DELETE', `/promotions/${promo.body.id}`, A.admin)).status, 204);
    assert.equal((await call('GET', '/promotions', B.admin)).body.total, 0);
  });
});
