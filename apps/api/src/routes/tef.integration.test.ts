import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { tefAdapters, type TefAdapter, type TefResponse } from '../lib/tef/adapter';
import { createMockAdapter } from '../lib/tef/mock-adapter';
import { applyResponse } from '../lib/tef/service';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process: own API rate-limit budget.
const enabled = process.env.RUN_DB_TESTS === '1';

test('TEF core: configuration, approval, denial, timeout/recovery, idempotency, mixed payments, reversal, reconciliation and isolation', { skip: !enabled, timeout: 180_000 }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.FISCAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const mock = createMockAdapter();
  // A non-simulated adapter that answers whatever the test script says: it plays a real provider returning complete or incomplete data.
  const script = new Map<string, TefResponse>();
  const real: TefAdapter = {
    name: 'fakepay', label: 'Provedor de teste (não é real)', simulated: false, fields: [{ key: 'apiKey', label: 'Chave', secret: true, required: true }],
    capabilities: { methods: ['CREDIT_CARD', 'DEBIT_CARD', 'PIX'], installments: true, query: false, cancel: false, pix: true },
    testConnection: async () => ({ ok: true, message: 'ok' }), start: async request => script.get(request.reference) ?? script.get('next') ?? { outcome: 'DENIED' },
  };
  tefAdapters.register(mock); tefAdapters.register(real);
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
    const tokens = {} as Record<'ADMIN' | 'CASHIER' | 'WAITER', string>;
    for (const role of [UserRole.ADMIN, UserRole.CASHIER, UserRole.WAITER] as const) {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      tokens[role] = signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role });
    }
    return { tenant, unit, tokens };
  };
  const A = await makeTenant('tef'); const B = await makeTenant('tefx');
  const admin = A.tokens.ADMIN; const cashier = A.tokens.CASHIER;
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    tefAdapters.clear();
    const ids = [A.tenant.id, B.tenant.id];
    await prisma.order.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });
  const product = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Prato', price: 100 } });
  const newOrder = async (quantity = 1) => (await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: product.id, quantity }] })).body.id as string;
  const pay = (orderId: string, extra: Record<string, unknown> = {}) => call('POST', '/tef/transactions', cashier, { orderId, provider: 'mock', method: 'CREDIT_CARD', amount: 100, idempotencyKey: randomUUID(), ...extra });
  const confirmed = (orderId: string) => prisma.payment.findMany({ where: { orderId, status: 'CONFIRMED' } });

  await t.test('configuration is per company, dynamic by provider, secrets are sealed and homologation needs evidence', async () => {
    const list = await call('GET', '/tef/providers', cashier);
    assert.deepEqual(list.body.items.map((item: any) => item.provider).sort(), ['fakepay', 'mock']);
    assert.equal(list.body.items.find((item: any) => item.provider === 'mock').integrationStatus, 'NOT_CONFIGURED');
    assert.equal((await pay(await newOrder())).status, 409, 'no usable configuration: nothing is charged');
    assert.equal((await call('PUT', '/tef/config/mock', cashier, {})).status, 403, 'only management configures the TEF');
    const saved = await call('PUT', '/tef/config/fakepay', admin, { establishmentCnpj: '11222333000181', terminalId: 'T1', credentials: { apiKey: 'sk_live_SECRET' }, enabledMethods: ['CREDIT_CARD', 'DEBIT_CARD', 'PIX'] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.integrationStatus, 'CONFIGURED');
    assert.deepEqual(saved.body.credentials, { apiKey: true }); assert.ok(!JSON.stringify(saved.body).includes('SECRET'));
    const row = await prisma.tefProviderConfig.findFirstOrThrow({ where: { tenantId: A.tenant.id, provider: 'fakepay' } });
    assert.ok(row.credentialsEnc && !row.credentialsEnc.includes('SECRET'), 'sealed at rest');
    assert.equal((await call('PUT', '/tef/config/fakepay', admin, { establishmentCnpj: '11222333000181', credentials: { token: 'x' } })).status, 400, 'fields that do not apply to the provider are refused');
    assert.equal((await call('PUT', '/tef/config/fakepay', admin, { establishmentCnpj: '11222333000181', integrationStatus: 'HOMOLOGATED', homologationEvidence: 'Certificação nº 123 aprovada' })).status, 409, 'needs a successful test first');
    const tested = await call('POST', '/tef/config/fakepay/test', admin); assert.equal(tested.body.integrationStatus, 'IN_TESTING');
    assert.equal((await call('PUT', '/tef/config/fakepay', admin, { establishmentCnpj: '11222333000181', integrationStatus: 'HOMOLOGATED' })).status, 409, 'and a written evidence');
    assert.equal((await call('PUT', '/tef/config/fakepay', admin, { establishmentCnpj: '11222333000181', integrationStatus: 'HOMOLOGATED', homologationEvidence: 'Certificação nº 123 aprovada' })).body.integrationStatus, 'HOMOLOGATED');
    // The simulator can be tested but never homologated.
    await call('PUT', '/tef/config/mock', admin, { establishmentCnpj: '11222333000181', terminalId: 'SIM' });
    assert.equal((await call('POST', '/tef/config/mock/test', admin)).body.integrationStatus, 'IN_TESTING');
    assert.equal((await call('PUT', '/tef/config/mock', admin, { establishmentCnpj: '11222333000181', integrationStatus: 'HOMOLOGATED', homologationEvidence: 'tentativa de homologar o simulador' })).status, 409);
    await call('PUT', '/tef/config/fakepay', admin, { establishmentCnpj: '11222333000181', integrationStatus: 'PRODUCTION_ENABLED' });
    assert.equal((await prisma.tefProviderConfig.findFirstOrThrow({ where: { tenantId: A.tenant.id, provider: 'fakepay' } })).integrationStatus, 'HOMOLOGATED', 'production needs the production environment');
    assert.equal((await call('GET', '/tef/providers', B.tokens.ADMIN)).body.items.find((item: any) => item.provider === 'mock').integrationStatus, 'NOT_CONFIGURED', 'configuration is per company');
  });

  await t.test('approval creates exactly one payment and is idempotent; denial creates none', async () => {
    const orderId = await newOrder(); const key = randomUUID();
    const first = await pay(orderId, { idempotencyKey: key });
    assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(first.body.paid, true); assert.equal(first.body.transaction.status, 'APPROVED');
    const replay = await pay(orderId, { idempotencyKey: key });
    assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.transaction.id, first.body.transaction.id);
    assert.equal((await pay(orderId, { idempotencyKey: key, amount: 50 })).status, 409, 'same key with a different charge is refused');
    const payments = await confirmed(orderId);
    assert.equal(payments.length, 1); assert.equal(Number(payments[0].amount), 100); assert.equal(payments[0].integrated, false, 'a simulated approval never feeds fiscal data');
    assert.equal((await pay(orderId)).status, 409, 'the order has no remaining balance');
    const event = await call('GET', `/tef/transactions/${first.body.transaction.id}`, cashier);
    assert.deepEqual(event.body.events.map((row: any) => row.toStatus), ['PENDING', 'APPROVED']);
    const denied = await pay(await newOrder(), { hints: { scenario: 'deny' } });
    assert.equal(denied.body.paid, false); assert.equal(denied.body.transaction.status, 'DENIED'); assert.equal(await prisma.payment.count({ where: { orderId: denied.body.transaction.orderId } }), 0);
  });

  await t.test('timeout is never re-sent: it is queried, recovered once, and the balance stays reserved meanwhile', async () => {
    const orderId = await newOrder(); const key = randomUUID();
    const timeout = await pay(orderId, { idempotencyKey: key, hints: { scenario: 'timeout' } });
    assert.equal(timeout.body.transaction.status, 'TIMEOUT'); assert.equal(timeout.body.paid, false); assert.equal((await confirmed(orderId)).length, 0);
    assert.equal((await pay(orderId)).status, 409, 'the in-flight amount blocks a second charge for the same balance');
    assert.equal((await pay(orderId, { idempotencyKey: key })).body.transaction.status, 'TIMEOUT', 'a retry with the same key only returns the known state');
    const synced = await call('POST', `/tef/transactions/${timeout.body.transaction.id}/sync`, cashier);
    assert.equal(synced.body.transaction.status, 'APPROVED'); assert.equal(synced.body.paid, true);
    assert.equal((await call('POST', `/tef/transactions/${timeout.body.transaction.id}/sync`, cashier)).body.transaction.status, 'APPROVED');
    assert.equal((await confirmed(orderId)).length, 1, 'recovered exactly once');
    const pending = await pay(await newOrder(), { hints: { scenario: 'pending' } });
    assert.equal(pending.body.transaction.status, 'PENDING'); assert.equal(pending.body.paid, false);
    assert.equal((await call('POST', `/tef/transactions/${pending.body.transaction.id}/sync`, cashier)).body.transaction.status, 'APPROVED');
    // The provider has no record: nothing was charged, the attempt closes without a payment.
    const lost = await pay(await newOrder(), { hints: { scenario: 'timeout' } });
    mock.remote.delete(lost.body.transaction.id);
    assert.equal((await call('POST', `/tef/transactions/${lost.body.transaction.id}/sync`, cashier)).body.transaction.status, 'ERROR');
  });

  await t.test('mixed payment: cash plus card never exceed the total; another company cannot see it', async () => {
    const orderId = await newOrder();
    assert.equal((await call('POST', '/cash/payments', cashier, { orderId, method: 'CASH', amount: 40 })).status, 201);
    assert.equal((await pay(orderId, { amount: 70 })).status, 409, 'card amount above the remaining balance is refused');
    assert.equal((await pay(orderId, { amount: 60, installments: 3 })).body.paid, true);
    assert.equal((await confirmed(orderId)).length, 2); assert.equal((await prisma.payment.findFirstOrThrow({ where: { orderId, method: 'CREDIT_CARD' } })).installments, 3);
    const transaction = (await prisma.tefTransaction.findFirstOrThrow({ where: { orderId } }));
    assert.equal((await call('GET', `/tef/transactions/${transaction.id}`, B.tokens.ADMIN)).status, 404);
    assert.equal((await call('POST', `/tef/transactions/${transaction.id}/sync`, B.tokens.ADMIN)).status, 404);
    assert.equal((await call('POST', '/tef/transactions', B.tokens.ADMIN, { orderId, provider: 'mock', method: 'CREDIT_CARD', amount: 10, idempotencyKey: randomUUID() })).status, 409, 'no configuration in the other company');
    assert.equal((await call('GET', '/tef/transactions', B.tokens.ADMIN)).body.total, 0);
  });

  await t.test('a real provider answer is validated: complete data creates an integrated payment; missing NSU/authorisation, wrong amount, duplicate NSU are held for review', async () => {
    const orderId = await newOrder(5);
    const full: TefResponse = { outcome: 'APPROVED', providerRef: 'P-1', amount: '100.00', nsu: '123456', authorizationCode: 'A1B2C3', cardBrand: 'VISA', acquirerCnpj: '11.222.333/0001-81', terminalId: 'T1' };
    script.set('next', full);
    const ok = await call('POST', '/tef/transactions', cashier, { orderId, provider: 'fakepay', method: 'CREDIT_CARD', amount: 100, idempotencyKey: randomUUID() });
    assert.equal(ok.body.paid, true, JSON.stringify(ok.body));
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } });
    assert.deepEqual([payment.integrated, payment.nsu, payment.authorizationCode, payment.cardBrand, payment.acquirerCnpj], [true, '123456', 'A1B2C3', 'VISA', '11222333000181']);
    const attempt = async (response: TefResponse, method = 'CREDIT_CARD') => { script.set('next', response); return call('POST', '/tef/transactions', cashier, { orderId, provider: 'fakepay', method, amount: 50, idempotencyKey: randomUUID() }); };
    const noNsu = await attempt({ ...full, providerRef: 'P-2', amount: '50.00', nsu: undefined });
    assert.equal(noNsu.body.transaction.status, 'UNKNOWN'); assert.equal(noNsu.body.paid, false);
    assert.equal((await attempt({ ...full, providerRef: 'P-3', amount: '49.00', nsu: '777' })).body.transaction.status, 'UNKNOWN', 'amount differs from the request');
    assert.equal((await attempt({ ...full, providerRef: 'P-4', amount: '50.00', nsu: '123456' })).body.transaction.status, 'UNKNOWN', 'NSU already recorded');
    assert.equal((await confirmed(orderId)).length, 1, 'no unvalidated approval reached the books');
    const pix = await attempt({ outcome: 'APPROVED', providerRef: 'PIX-9', amount: '50.00', pixEndToEnd: 'E12345678901234567890123456789012' }, 'PIX');
    assert.equal(pix.body.paid, true); assert.equal((await prisma.payment.findFirstOrThrow({ where: { orderId, method: 'PIX' } })).pixEndToEnd, 'E12345678901234567890123456789012');
    // Re-applying an old answer to a closed transaction changes nothing.
    await applyResponse(ok.body.transaction.id, { outcome: 'DENIED' });
    assert.equal((await prisma.tefTransaction.findUniqueOrThrow({ where: { id: ok.body.transaction.id } })).status, 'APPROVED');
    const events = JSON.stringify(await prisma.tefEvent.findMany({ where: { tenantId: A.tenant.id } }));
    assert.ok(!events.includes('sk_live_SECRET'), 'credentials never reach the logs');
  });

  await t.test('reversal: needs confirmation and reason, books change only after the provider confirms, original stays linked; manual refund of a TEF payment is blocked', async () => {
    const orderId = await newOrder();
    const approved = (await pay(orderId)).body.transaction;
    const paymentId = approved.paymentId as string;
    assert.equal((await call('POST', `/cash/payments/${paymentId}/refund`, admin)).status, 409, 'a TEF payment is only reversed through the provider');
    assert.equal((await call('POST', `/tef/transactions/${approved.id}/cancel`, cashier, { reason: 'Cliente desistiu', confirm: true })).status, 403, 'cashier cannot reverse');
    assert.equal((await call('POST', `/tef/transactions/${approved.id}/cancel`, admin, { reason: 'x', confirm: true })).status, 400);
    assert.equal((await call('POST', `/tef/transactions/${approved.id}/cancel`, admin, { reason: 'Cliente desistiu' })).status, 400);
    const reversed = await call('POST', `/tef/transactions/${approved.id}/cancel`, admin, { reason: 'Cliente desistiu', confirm: true });
    assert.equal(reversed.status, 200, JSON.stringify(reversed.body)); assert.equal(reversed.body.transaction.status, 'REVERSED'); assert.equal(reversed.body.transaction.paymentId, paymentId);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } })).status, 'REFUNDED');
    assert.equal((await call('POST', `/tef/transactions/${approved.id}/cancel`, admin, { reason: 'Cliente desistiu', confirm: true })).status, 409, 'cannot be reversed twice');
    assert.ok(await prisma.auditLog.findFirst({ where: { tenantId: A.tenant.id, action: 'TEF_PAYMENT_REVERSED', entityId: approved.id } }));
    const declined = (await pay(await newOrder())).body.transaction;
    mock.remote.get(declined.id)!.response = { outcome: 'DENIED' };
    const refused = await call('POST', `/tef/transactions/${declined.id}/cancel`, admin, { reason: 'Estorno recusado', confirm: true });
    assert.equal(refused.status, 409); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: declined.paymentId } })).status, 'CONFIRMED', 'provider refused: books unchanged');
    assert.equal((await prisma.tefTransaction.findUniqueOrThrow({ where: { id: declined.id } })).reversalRef, null);
    // fakepay offers no cancellation: the user is told to use the provider portal and nothing changes.
    const noCancel = (await prisma.tefTransaction.findFirstOrThrow({ where: { tenantId: A.tenant.id, provider: 'fakepay', status: 'APPROVED' } }));
    assert.equal((await call('POST', `/tef/transactions/${noCancel.id}/cancel`, admin, { reason: 'Cliente desistiu', confirm: true })).status, 409);
  });

  await t.test('monitor and reconciliation list approvals, reversals, unresolved attempts and manual card payments', async () => {
    const orderId = await newOrder();
    await call('POST', '/cash/payments', cashier, { orderId, method: 'DEBIT_CARD', amount: 100, reference: 'maquininha avulsa' });
    const unresolved = await pay(await newOrder(), { hints: { scenario: 'timeout' } });
    const monitor = (await call('GET', '/tef/monitor', cashier)).body;
    const count = (status: string) => monitor.byStatus.find((row: any) => row.status === status)?.count ?? 0;
    assert.ok(count('APPROVED') >= 5 && count('DENIED') >= 1 && count('REVERSED') >= 1 && count('TIMEOUT') >= 1);
    const report = (await call('GET', '/tef/reconciliation', admin)).body;
    const types = report.divergences.map((row: any) => row.type);
    assert.ok(types.includes('PAYMENT_WITHOUT_TEF') && types.includes('UNRESOLVED'));
    assert.ok(report.divergences.some((row: any) => row.transactionId === unresolved.body.transaction.id && row.type === 'UNRESOLVED'));
    assert.ok(!types.includes('APPROVED_WITHOUT_PAYMENT') && !types.includes('AMOUNT_MISMATCH') && !types.includes('REVERSED_STILL_PAID'));
    const visa = report.totals.find((row: any) => row.method === 'CREDIT_CARD' && row.brand === 'VISA');
    assert.ok(visa.approved >= 4 && visa.reversed >= 1 && visa.approvedAmount >= 400);
    assert.match(report.notice, /liquidação/);
    assert.equal((await call('GET', '/tef/reconciliation', cashier)).status, 403);
    assert.equal((await call('GET', '/tef/reconciliation', B.tokens.ADMIN)).body.totals.length, 0);
  });
});
