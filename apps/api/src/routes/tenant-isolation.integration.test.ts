import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process: own API rate-limit budget. Fictitious data only.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

test('multi-tenant isolation: one restaurant cannot read, change, delete, price or restore records of another', { skip: !enabled, timeout: 180_000 }, async t => {
  process.env.JWT_SECRET = 'e'.repeat(32);
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
  const [tenantA, tenantB] = [await prisma.tenant.create({ data: { name: `Iso A ${id}`, slug: `iso-a-${id}`, status: 'ACTIVE' } }), await prisma.tenant.create({ data: { name: `Iso B ${id}`, slug: `iso-b-${id}`, status: 'ACTIVE' } })];
  const adminA = await prisma.user.create({ data: { tenantId: tenantA.id, name: 'Admin A', email: `iso-a-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const adminB = await prisma.user.create({ data: { tenantId: tenantB.id, name: 'Admin B', email: `iso-b-${id}@test.local`, passwordHash: 'x', role: UserRole.ADMIN } });
  const master = await prisma.user.create({ data: { name: 'Master', email: `iso-m-${id}@test.local`, passwordHash: 'x', role: UserRole.MASTER_ADMIN } });
  const tokenA = signAccessToken({ userId: adminA.id, tenantId: tenantA.id, unitId: null, role: UserRole.ADMIN });
  const tokenB = signAccessToken({ userId: adminB.id, tenantId: tenantB.id, unitId: null, role: UserRole.ADMIN });
  const masterToken = signAccessToken({ userId: master.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN });
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: [adminA.id, adminB.id, master.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA.id, tenantB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [adminA.id, adminB.id, master.id] } } });
    await prisma.$disconnect();
  });

  const seed = async (tenantId: string, tag: string) => {
    const category = await prisma.productCategory.create({ data: { tenantId, name: `${tag} Categoria` } });
    const supplier = await prisma.supplier.create({ data: { tenantId, name: `${tag} Fornecedor` } });
    const customer = await prisma.customer.create({ data: { tenantId, name: `${tag} Cliente`, phone: `1190000${tag === 'A' ? '1' : '2'}${id.slice(0, 3).replace(/\D/g, '1')}` } });
    const product = await prisma.product.create({ data: { tenantId, name: `${tag} Produto`, code: `${tag}-1`, price: 25, cost: 10, categoryId: category.id, supplierId: supplier.id, stockControlled: true, stockQuantity: 5 } });
    const pricing = await prisma.productPricing.create({ data: { tenantId, productId: product.id, marginPercent: 40 } });
    const history = await prisma.priceHistory.create({ data: { tenantId, productId: product.id, price: 25, cost: 10, reason: 'SEED' } });
    const finCategory = await prisma.financialCategory.create({ data: { tenantId, type: 'EXPENSE', name: `${tag} Despesa` } });
    const costCenter = await prisma.costCenter.create({ data: { tenantId, name: `${tag} Centro` } });
    const bank = await prisma.bankAccount.create({ data: { tenantId, name: `${tag} Conta`, initialBalance: 100 } });
    const payable = await prisma.financialEntry.create({ data: { tenantId, type: 'EXPENSE', description: `${tag} Conta a pagar`, amount: 321.45, supplierId: supplier.id, costCenterId: costCenter.id, bankAccountId: bank.id, category: finCategory.name } });
    const receivable = await prisma.financialEntry.create({ data: { tenantId, type: 'INCOME', description: `${tag} Conta a receber`, amount: 99.9, customerId: customer.id } });
    const session = await prisma.migrationSession.create({ data: { tenantId, label: `${tag} sessão`, engineVersion: 't', status: 'PREVIEWED' } });
    const backup = await prisma.migrationBackup.create({ data: { tenantId, sessionId: session.id, status: 'VERIFIED', database: {}, engineVersion: 't', sha256: 'a'.repeat(64) } });
    return { category, supplier, customer, product, pricing, history, finCategory, costCenter, bank, payable, receivable, session, backup };
  };
  const a = await seed(tenantA.id, 'A'); const b = await seed(tenantB.id, 'B');
  const state = async (tenantId: string) => JSON.stringify({
    products: await prisma.product.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), customers: await prisma.customer.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    suppliers: await prisma.supplier.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), entries: await prisma.financialEntry.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    categories: await prisma.financialCategory.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), pricing: await prisma.productPricing.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    history: await prisma.priceHistory.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), sessions: await prisma.migrationSession.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }),
    backups: await prisma.migrationBackup.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), movements: await prisma.productStockMovement.count({ where: { tenantId } }), audit: 0,
  });
  const beforeB = await state(tenantB.id);
  const denied = (status: number) => [403, 404].includes(status);

  await t.test('reading: lists contain only the caller\'s records and foreign ids are 404', async () => {
    const entries = (await call('GET', '/financial/entries?pageSize=100', tokenA)).body;
    assert.deepEqual(entries.items.map((row: any) => row.id).sort(), [a.payable.id, a.receivable.id].sort());
    assert.ok(entries.items.every((row: any) => (row.supplier ? row.supplier.id === a.supplier.id : true)));
    assert.deepEqual((await call('GET', '/financial/cost-centers', tokenA)).body.items.map((row: any) => row.id), [a.costCenter.id]);
    assert.deepEqual((await call('GET', '/financial/bank-accounts', tokenA)).body.items.map((row: any) => row.id), [a.bank.id]);
    assert.deepEqual((await call('GET', '/products?pageSize=100', tokenA)).body.items.map((row: any) => row.id), [a.product.id]);
    assert.ok((await call('GET', '/customers', tokenA)).body.items.every((row: any) => row.id !== b.customer.id));
    assert.ok((await call('GET', '/purchasing/suppliers', tokenA)).body.items.every((row: any) => row.id !== b.supplier.id));
    assert.equal((await call('GET', `/customers/${b.customer.id}`, tokenA)).status, 404);
    assert.equal((await call('GET', `/customers/${b.customer.id}/export`, tokenA)).status, 404);
    assert.equal((await call('GET', `/products/${b.product.id}/stock-movements`, tokenA)).status, 404);
    assert.equal((await call('GET', `/pricing/products/${b.product.id}`, tokenA)).status, 404, 'costs, margins and price history of another restaurant');
    const panel = (await call('GET', '/pricing/panel', tokenA)).body;
    assert.ok(JSON.stringify(panel).includes(a.product.id) && !JSON.stringify(panel).includes(b.product.id));
  });

  await t.test('changing and deleting: every write against a foreign id is refused and nothing changes', async () => {
    const attempts: [string, string, unknown?][] = [
      ['PATCH', `/customers/${b.customer.id}`, { name: 'Invadido' }], ['POST', `/customers/${b.customer.id}/anonymize`, {}],
      ['PATCH', `/products/${b.product.id}`, { name: 'Invadido', price: 1 }], ['POST', `/products/${b.product.id}/stock-movements`, { type: 'ADJUSTMENT', action: 'ADD', quantity: 5 }],
      ['PATCH', `/purchasing/suppliers/${b.supplier.id}`, { name: 'Invadido' }], ['PATCH', `/financial-categories/${b.finCategory.id}`, { name: 'Invadido' }], ['DELETE', `/financial-categories/${b.finCategory.id}`],
      ['POST', `/financial/entries/${b.payable.id}/settle`, {}],
      ['PUT', `/pricing/products/${b.product.id}`, { freightCost: 0, otherAcquisitionCost: 0, marginPercent: 99, operationalCostPercent: null, operationalCostFixed: null, taxPercent: null, cardFeePercent: null, commissionPercent: null, otherVariablePercent: null, acquisitionCost: 1 }], ['POST', `/pricing/products/${b.product.id}/apply-price`, { price: 1, confirm: true }],
    ];
    for (const [method, path, body] of attempts) { const response = await call(method, path, tokenA, body); assert.ok(denied(response.status), `${method} ${path} → ${response.status} ${JSON.stringify(response.body)}`); }
    const bulk = await call('POST', '/pricing/bulk/preview', tokenA, { productIds: [b.product.id], marginPercent: 80 });
    assert.equal(bulk.status, 200); assert.equal(bulk.body.count, 0, 'bulk pricing cannot select another restaurant\'s products');
    assert.equal((await call('POST', '/pricing/bulk/apply', tokenA, { productIds: [b.product.id], marginPercent: 80, confirm: true, expectedCount: 1 })).status, 409);
    const order = await call('POST', '/orders', tokenA, { channel: 'POS', items: [{ productId: b.product.id, quantity: 1 }] });
    assert.ok(order.status >= 400 && order.status < 500, `order with a foreign product → ${order.status}`);
    assert.equal(await prisma.order.count({ where: { tenantId: tenantA.id } }), 0);
    assert.equal(await state(tenantB.id), beforeB, 'restaurant B is byte-for-byte unchanged (rows, prices, history, costs, stock)');
  });

  await t.test('own records still work (the refusals above are isolation, not a broken route)', async () => {
    assert.equal((await call('PATCH', `/customers/${a.customer.id}`, tokenA, { name: 'A Cliente Editado' })).status, 200);
    assert.equal((await call('POST', `/financial/entries/${a.payable.id}/settle`, tokenA, {})).status, 200);
    assert.equal((await call('POST', `/pricing/products/${a.product.id}/apply-price`, tokenA, { price: 30, confirm: true })).status, 200);
    assert.equal(await prisma.priceHistory.count({ where: { tenantId: tenantA.id, productId: a.product.id } }), 2);
    assert.equal(await prisma.priceHistory.count({ where: { tenantId: tenantB.id } }), 1, 'B history untouched');
    assert.equal(await state(tenantB.id), beforeB);
  });

  await t.test('Smart Migration and backups: sessions, backups and restoration are unreachable across restaurants and by restaurant users', async () => {
    const own = `/migrations/tenants/${tenantA.id}/sessions/${a.session.id}`; const crossed = `/migrations/tenants/${tenantA.id}/sessions/${b.session.id}`;
    assert.equal((await call('GET', own, masterToken)).status, 200);
    for (const path of ['', '/records', '/backups']) assert.equal((await call('GET', crossed + path, masterToken)).status, 404, `GET ${path || 'session'} of B's session through A's path`);
    assert.equal((await call('POST', `${crossed}/backups`, masterToken)).status, 404, 'cannot generate a backup of B through A');
    assert.equal((await call('POST', `${crossed}/backups/${b.backup.id}/verify`, masterToken)).status, 404);
    assert.equal((await call('POST', `${own}/backups/${b.backup.id}/verify`, masterToken)).status, 404, "B's backup id is not reachable from A's session");
    assert.equal((await call('POST', `${crossed}/approve`, masterToken, { confirm: 'EXECUTAR' })).status, 404);
    assert.deepEqual((await call('GET', `${own}/backups`, masterToken)).body.items.map((row: any) => row.id), [a.backup.id]);
    // Restaurant users (even administrators) have no access to the Smart Migration at all
    for (const path of [own, `${own}/backups`, `/migrations/tenants/${tenantB.id}/sessions/${b.session.id}`]) assert.ok(denied((await call('GET', path, tokenA)).status), path);
    assert.ok(denied((await call('POST', `/migrations/tenants/${tenantB.id}/sessions/${b.session.id}/backups`, tokenB)).status));
    assert.equal(await state(tenantB.id), beforeB);
  });
});
