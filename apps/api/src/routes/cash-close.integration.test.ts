import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { clientKindOf } from '../lib/client-kind';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). Own file/process.
const enabled = process.env.RUN_DB_TESTS === '1';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 12; SUNMI V2) AppleWebKit/537.36 Chrome/110.0 Mobile Safari/537.36';

test('client kind is derived from the User-Agent', () => {
  assert.equal(clientKindOf(DESKTOP_UA), 'DESKTOP'); assert.equal(clientKindOf(ANDROID_UA), 'DEVICE');
  assert.equal(clientKindOf('Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit Mobile/15E148'), 'DEVICE');
  assert.equal(clientKindOf('curl/8.4.0'), 'API'); assert.equal(clientKindOf(undefined), 'API'); assert.equal(clientKindOf('PostmanRuntime/7.36'), 'API');
});

test('official cash closing: only from the computer, never twice, with concurrency control, audit and unchanged opening/payment flow for other clients', { skip: !enabled, timeout: 120_000 }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32); process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64'); process.env.RM_RESTAURANT_URL = 'https://r.example'; process.env.RM_ADMIN_URL = 'https://a.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const send = async (method: string, path: string, token: string | null, body?: unknown, ua = DESKTOP_UA) => { const r = await fetch(base + path, { method, headers: { 'user-agent': ua, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const sfx = randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: 'Caixa ' + sfx, slug: 'caixa-' + sfx, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
  const hash = await bcrypt.hash('Senha-123456', 4);
  const cashier = await prisma.user.create({ data: { tenantId: tenant.id, name: 'Caixa', email: `cx-${sfx}@t.local`, passwordHash: hash, role: UserRole.CASHIER, unitId: unit.id } });
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } }); await prisma.order.deleteMany({ where: { tenantId: tenant.id } }); await prisma.tenant.deleteMany({ where: { id: tenant.id } }); await prisma.$disconnect(); });
  const login = async (ua: string) => (await send('POST', '/auth/login', null, { email: cashier.email, password: 'Senha-123456' }, ua)).body.accessToken as string;
  const [desktop, device, script] = [await login(DESKTOP_UA), await login(ANDROID_UA), await login('curl/8.4.0')];
  const opened = await send('POST', '/cash/sessions', device, { openingAmount: 100 }, ANDROID_UA);
  assert.equal(opened.status, 201, 'opening stays available to the permitted profile on any client');
  const sessionId = opened.body.id as string;
  const product = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Prato', price: 60 } });
  const order = (await send('POST', '/orders', desktop, { channel: 'POS', unitId: unit.id, items: [{ productId: product.id, quantity: 1 }] })).body;
  assert.equal((await send('POST', '/cash/payments', device, { orderId: order.id, method: 'CASH', amount: 20, cashSessionId: sessionId }, ANDROID_UA)).status, 201, 'mixed payment: cash part');
  assert.equal((await send('POST', '/cash/payments', desktop, { orderId: order.id, method: 'PIX', amount: 40, cashSessionId: sessionId })).status, 201, 'mixed payment: pix part');

  for (const [label, token, ua] of [['terminal/phone', device, ANDROID_UA], ['direct API call (script)', script, 'curl/8.4.0'], ['forged token without client claim', signAccessToken({ userId: cashier.id, tenantId: tenant.id, unitId: unit.id, role: UserRole.CASHIER }), DESKTOP_UA]] as const) {
    const denied = await send('POST', `/cash/sessions/${sessionId}/close`, token, { closingAmount: 120 }, ua);
    assert.equal(denied.status, 403, label); assert.equal(denied.body.code, 'CASH_CLOSE_DESKTOP_ONLY', label);
  }
  assert.equal((await prisma.cashSession.findUniqueOrThrow({ where: { id: sessionId } })).status, 'OPEN', 'nothing closed');
  assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, action: 'CASH_CLOSE_DENIED' } }), 3, 'every refusal is audited');

  // Two simultaneous closings from the computer: exactly one wins.
  const race = await Promise.all([send('POST', `/cash/sessions/${sessionId}/close`, desktop, { closingAmount: 120 }), send('POST', `/cash/sessions/${sessionId}/close`, desktop, { closingAmount: 120 })]);
  assert.deepEqual(race.map(item => item.status).sort(), [200, 404]);
  const closed = await prisma.cashSession.findUniqueOrThrow({ where: { id: sessionId } });
  assert.deepEqual([closed.status, Number(closed.expectedAmount), Number(closed.closingAmount)], ['CLOSED', 120, 120], 'expected = opening 100 + cash 20 (the PIX part is not drawer cash)');
  assert.equal(await prisma.auditLog.count({ where: { tenantId: tenant.id, action: 'CASH_SESSION_CLOSED' } }), 1, 'one closing, one audit record');
  assert.equal((await send('POST', `/cash/sessions/${sessionId}/close`, desktop, { closingAmount: 120 })).status, 404, 'no duplicate closing');
});
