import test from 'node:test';
import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';

test('signed-in users have their own rate-limit budget; anonymous callers keep the strict per-IP one', async () => {
  process.env.JWT_SECRET = 'r'.repeat(32);
  const { signAccessToken, signScopedToken, sessionRateKey } = await import('./middleware/auth');
  const { app } = await import('./index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/health`;
    const hit = async (token?: string) => (await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;
    const staff = signAccessToken({ userId: '11111111-1111-4111-8111-111111111111', tenantId: null, unitId: null, role: UserRole.ADMIN });
    const forged = jwt.sign({ userId: 'x' }, 'z'.repeat(32), { issuer: 'rm-restaurant-api' });
    const scoped = signScopedToken('11111111-1111-4111-8111-111111111111', 'master_mfa_login', 1);
    assert.equal(sessionRateKey({ headers: { authorization: `Bearer ${staff}` } } as never), 'user:11111111-1111-4111-8111-111111111111');
    assert.equal(sessionRateKey({ headers: { authorization: `Bearer ${forged}` } } as never), null, 'forged tokens fall back to the IP bucket');
    assert.equal(sessionRateKey({ headers: { authorization: `Bearer ${scoped}` } } as never), null, 'scoped tokens are not sessions');
    assert.equal(sessionRateKey({ headers: {} } as never), null);

    // The signed-in user goes past the anonymous budget (300) without being throttled.
    for (let index = 0; index < 320; index++) assert.equal(await hit(staff), 200, `request ${index}`);
    // A forged token is treated as anonymous: it gets throttled once the per-IP budget is used up.
    const statuses: number[] = [];
    for (let index = 0; index < 330; index++) statuses.push(await hit(forged));
    assert.ok(statuses.includes(429), 'anonymous/forged callers are throttled');
    assert.equal(statuses.indexOf(429) >= 290, true, 'but only after the shared budget is spent');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
