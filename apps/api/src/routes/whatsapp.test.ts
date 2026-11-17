import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { whatsappRoutes } from './whatsapp';

test('WhatsApp outbox preserves JSON payloads and validates input', async t => {
  process.env.JWT_SECRET = 'a'.repeat(32);
  const findUser = prisma.user.findUnique;
  const createMessage = prisma.whatsappMessage.create;
  prisma.user.findUnique = (async () => ({ id: 'user', tenantId: 'tenant', unitId: null, role: UserRole.ADMIN, status: UserStatus.ACTIVE, authVersion: 0, tenant: { status: 'TRIAL', license: null, modules: [] } })) as never;
  let created: any;
  prisma.whatsappMessage.create = (async ({ data }: any) => { created = data; return data; }) as never;
  t.after(() => { prisma.user.findUnique = findUser; prisma.whatsappMessage.create = createMessage; });
  const token = signAccessToken({ userId: 'user', tenantId: 'tenant', unitId: null, role: UserRole.ADMIN });
  const app = express();
  app.use(express.json(), whatsappRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const post = (body: unknown) => fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/outbox`, {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = { customer: { name: 'Maria', extra: null }, items: [1, 'two', false, null] };
  assert.equal((await post({ toPhone: '12345678', template: 'order', payload })).status, 202);
  assert.deepEqual(created.payload, payload);
  assert.equal(created.tenantId, 'tenant');
  assert.equal(created.status, 'QUEUED');
  assert.equal((await post({ toPhone: '12345678', template: 'order' })).status, 202);
  assert.equal(created.payload, undefined);
  for (const invalidPayload of [null, [], 'invalid', 1]) {
    assert.equal((await post({ toPhone: '12345678', template: 'order', payload: invalidPayload })).status, 400);
  }
  assert.equal((await post({ toPhone: 'short', template: 'order', payload })).status, 400);
  assert.equal((await post({ toPhone: '12345678', template: '', payload })).status, 400);
  assert.equal((await post({ toPhone: '12345678', template: 'order', orderId: 'invalid', payload })).status, 400);
});
