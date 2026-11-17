import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { cashRoutes } from './cash';

const tenant = '11111111-1111-4111-8111-111111111111';
const otherTenant = '22222222-2222-4222-8222-222222222222';
const unit = '33333333-3333-4333-8333-333333333333';
const otherUnit = '44444444-4444-4444-8444-444444444444';
const orderId = '55555555-5555-4555-8555-555555555555';
const sessionId = '66666666-6666-4666-8666-666666666666';
const userId = '77777777-7777-4777-8777-777777777777';

test('cash routes use authenticated database scope and atomic transactions', async t => {
  process.env.JWT_SECRET = 'a'.repeat(32);
  const originalFindUser = prisma.user.findUnique;
  prisma.user.findUnique = (async () => ({ id: userId, tenantId: tenant, unitId: null, role: UserRole.ADMIN, status: UserStatus.ACTIVE, authVersion: 0, tenant: { status: 'ACTIVE', license: null, modules: [] } })) as never;
  t.after(() => { prisma.user.findUnique = originalFindUser; });
  const token = signAccessToken({ userId, tenantId: otherTenant, unitId: otherUnit, role: UserRole.MASTER_ADMIN });
  const app = express();
  app.use(express.json(), cashRoutes);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: 'error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  let tx: any;
  const options: any[] = [];
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = (async (fn: any, option: unknown) => { options.push(option); return fn(tx); }) as never;
  t.after(() => { prisma.$transaction = originalTransaction; });

  await t.test('rejects invalid monetary inputs before database writes', async () => {
    const before = options.length;
    for (const value of [-1, 0.001, 10000000000, '1']) {
      assert.equal((await post('/sessions', { openingAmount: value })).status, 400);
      assert.equal((await post(`/sessions/${sessionId}/close`, { closingAmount: value })).status, 400);
      assert.equal((await post('/payments', { orderId, method: 'CASH', amount: value })).status, 400);
    }
    assert.equal((await post('/payments', { orderId, method: 'CASH', amount: 0 })).status, 400);
    assert.equal(options.length, before);
  });

  await t.test('rejects a session in another unit even for an unassigned user', async () => {
    let orderWhere: any;
    let sessionWhere: any;
    tx = {
      order: { findFirst: async ({ where }: any) => { orderWhere = where; return { id: orderId, unitId: unit, total: new Prisma.Decimal(10) }; } },
      cashSession: { findFirst: async ({ where }: any) => { sessionWhere = where; return null; } },
    };
    const response = await post('/payments', { orderId, cashSessionId: sessionId, method: 'CASH', amount: 1 });
    assert.equal(response.status, 400);
    assert.deepEqual(orderWhere, { id: orderId, tenantId: tenant });
    assert.deepEqual(sessionWhere, { id: sessionId, tenantId: tenant, unitId: unit, status: 'OPEN' });
  });

  await t.test('records payment and audit with the order unit and tenant', async () => {
    let data: any;
    let aggregateWhere: any;
    let audit: any;
    tx = {
      order: { findFirst: async () => ({ id: orderId, unitId: unit, total: new Prisma.Decimal(10) }) },
      cashSession: { findFirst: async () => ({ id: sessionId }) },
      payment: {
        create: async (args: any) => { data = args.data; return { id: 'payment', ...data }; },
        aggregate: async ({ where }: any) => { aggregateWhere = where; return { _sum: { amount: new Prisma.Decimal('0.25') } }; },
      },
      financialEntry: { findUnique: async () => null },
      auditLog: { create: async (args: any) => { audit = args.data; } },
    };
    const response = await post('/payments', { orderId, cashSessionId: sessionId, method: 'CASH', amount: 1.25 });
    assert.equal(response.status, 201);
    assert.equal(data.tenantId, tenant);
    assert.equal(data.unitId, unit);
    assert.deepEqual(aggregateWhere, { tenantId: tenant, orderId, status: 'CONFIRMED' });
    assert.equal(response.body.amountPaid, '1.5');
    assert.equal(audit.actorUserId, userId);
  });

  await t.test('rejects cancelled orders and payments exceeding confirmed remaining balance', async () => {
    tx = { order: { findFirst: async () => ({ id: orderId, status: 'CANCELLED' }) } };
    assert.equal((await post('/payments', { orderId, method: 'CASH', amount: 1 })).status, 409);
    tx = {
      order: { findFirst: async () => ({ id: orderId, status: 'OPEN', unitId: null, total: new Prisma.Decimal('1.00') }) },
      payment: { aggregate: async () => ({ _sum: { amount: new Prisma.Decimal('0.80') } }) },
    };
    assert.equal((await post('/payments', { orderId, method: 'CASH', amount: 0.21 })).status, 409);
  });

  await t.test('open session query preserves explicit null unit scope', async () => {
    let where: any;
    tx = { cashSession: { findFirst: async (args: any) => { where = args.where; return { id: sessionId }; } } };
    assert.equal((await post('/sessions', { openingAmount: 0 })).status, 409);
    assert.deepEqual(where, { tenantId: tenant, unitId: null, status: 'OPEN' });
  });

  await t.test('closes using confirmed cash only and records audit in the transaction', async () => {
    let paymentWhere: any;
    let update: any;
    let audit: any;
    tx = {
      cashSession: {
        findFirst: async ({ where }: any) => { assert.equal(where.tenantId, tenant); return { id: sessionId, openingAmount: new Prisma.Decimal('0.10') }; },
        update: async (args: any) => { update = args; return args.data; },
      },
      payment: { aggregate: async ({ where }: any) => { paymentWhere = where; return { _sum: { amount: new Prisma.Decimal('0.20') } }; } },
      auditLog: { create: async (args: any) => { audit = args.data; } },
    };
    const response = await post(`/sessions/${sessionId}/close`, { closingAmount: 0.3 });
    assert.equal(response.status, 200);
    assert.deepEqual(paymentWhere, { tenantId: tenant, cashSessionId: sessionId, status: 'CONFIRMED', method: 'CASH' });
    assert.equal(update.data.expectedAmount.toString(), '0.3');
    assert.equal(audit.tenantId, tenant);
    assert.equal(audit.actorUserId, userId);
    assert.equal(audit.metadata.expected, '0.3');
    assert.deepEqual(options.at(-1), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  await t.test('does not close when expected amount exceeds database precision', async () => {
    tx = {
      cashSession: { findFirst: async () => ({ id: sessionId, openingAmount: new Prisma.Decimal('9999999999.99') }) },
      payment: { aggregate: async () => ({ _sum: { amount: new Prisma.Decimal('0.01') } }) },
    };
    assert.equal((await post(`/sessions/${sessionId}/close`, { closingAmount: 0 })).status, 409);
  });
});
