import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { OrderStatus, Prisma, UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { orderRoutes } from './orders';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const unitId = '33333333-3333-4333-8333-333333333333';
const orderId = '44444444-4444-4444-8444-444444444444';
const productId = '55555555-5555-4555-8555-555555555555';
const ingredientId = '66666666-6666-4666-8666-666666666666';
const userId = '77777777-7777-4777-8777-777777777777';

test('order preparation consumes recipe stock atomically and respects state transitions', async t => {
  process.env.JWT_SECRET = 'a'.repeat(32);
  const originalFindUser = prisma.user.findUnique;
  const originalTransaction = prisma.$transaction;
  prisma.user.findUnique = (async () => ({ id: userId, tenantId, unitId: null, role: UserRole.ADMIN, status: UserStatus.ACTIVE, tenant: { status: 'ACTIVE' } })) as never;
  let tx: any;
  const transactionOptions: unknown[] = [];
  prisma.$transaction = (async (operation: any, options: unknown) => {
    transactionOptions.push(options);
    return operation(tx);
  }) as never;
  t.after(() => {
    prisma.user.findUnique = originalFindUser;
    prisma.$transaction = originalTransaction;
  });

  const token = signAccessToken({ userId, tenantId: otherTenantId, unitId, role: UserRole.MASTER_ADMIN });
  const app = express();
  app.use(express.json(), orderRoutes);
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ message: 'error' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const patch = async (status: string) => {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${orderId}/status`, {
      method: 'PATCH',
      headers: { authorization: ['Bearer', token].join(' '), 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  const makeOrder = (overrides: Record<string, unknown> = {}) => ({
    id: orderId,
    code: 'P-100',
    tenantId,
    unitId,
    status: OrderStatus.OPEN,
    items: [{
      quantity: 3,
      product: {
        id: productId,
        tenantId,
        recipe: {
          tenantId,
          productId,
          yield: new Prisma.Decimal(2),
          ingredients: [{
            quantity: new Prisma.Decimal('0.25'),
            ingredient: {
              id: ingredientId,
              tenantId,
              unitId: null,
              active: true,
            },
          }],
        },
      },
    }],
    ...overrides,
  });

  await t.test('deducts aggregated recipe quantity once and writes a movement in the same transaction', async () => {
    let orderWhere: any;
    let stockUpdate: any;
    let movement: any;
    let updatedOrder: any;
    let audit: any;
    tx = {
      order: {
        findFirst: async ({ where }: any) => { orderWhere = where; return makeOrder(); },
        update: async ({ data }: any) => { updatedOrder = data; return { id: orderId, ...data }; },
      },
      ingredient: { updateMany: async (args: any) => { stockUpdate = args; return { count: 1 }; } },
      stockMovement: { create: async ({ data }: any) => { movement = data; } },
      auditLog: { create: async ({ data }: any) => { audit = data; } },
    };

    const response = await patch('PREPARING');
    assert.equal(response.status, 200);
    assert.deepEqual(orderWhere, { id: orderId, tenantId });
    assert.deepEqual(stockUpdate.where, {
      id: ingredientId,
      tenantId,
      unitId: null,
      active: true,
      currentStock: { gte: new Prisma.Decimal('0.375') },
    });
    assert.deepEqual(stockUpdate.data, { currentStock: { decrement: new Prisma.Decimal('0.375') } });
    assert.equal(movement.type, 'ORDER_CONSUMPTION');
    assert.equal(movement.quantity.toString(), '-0.375');
    assert.equal(movement.reference, orderId);
    assert.equal(movement.actorUserId, userId);
    assert.equal(updatedOrder.status, 'PREPARING');
    assert.equal(audit.tenantId, tenantId);
    assert.deepEqual(transactionOptions.at(-1), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });

  await t.test('rolls back the status change when stock is insufficient', async () => {
    let orderUpdates = 0;
    let movements = 0;
    tx = {
      order: { findFirst: async () => makeOrder(), update: async () => { orderUpdates++; } },
      ingredient: { updateMany: async () => ({ count: 0 }) },
      stockMovement: { create: async () => { movements++; } },
      auditLog: { create: async () => assert.fail('must not audit a failed transition') },
    };
    const response = await patch('PREPARING');
    assert.equal(response.status, 409);
    assert.match(response.body.message, /Insufficient stock/);
    assert.equal(orderUpdates, 0);
    assert.equal(movements, 0);
  });

  await t.test('rejects recipes referring to another tenant inventory', async () => {
    let stockUpdates = 0;
    tx = {
      order: { findFirst: async () => makeOrder({
        items: [{
          quantity: 1,
          product: {
            id: productId,
            tenantId,
            recipe: {
              tenantId,
              productId,
              yield: new Prisma.Decimal(1),
              ingredients: [{ quantity: new Prisma.Decimal(1), ingredient: { id: ingredientId, tenantId: otherTenantId, unitId, active: true } }],
            },
          },
        }],
      }) },
      ingredient: { updateMany: async () => { stockUpdates++; return { count: 1 }; } },
    };
    const response = await patch('PREPARING');
    assert.equal(response.status, 409);
    assert.match(response.body.message, /invalid or out-of-scope/);
    assert.equal(stockUpdates, 0);
  });

  await t.test('allows orders without recipes and makes repeated status requests idempotent', async () => {
    let stockUpdates = 0;
    let orderUpdates = 0;
    tx = {
      order: {
        findFirst: async () => makeOrder({ items: [{ quantity: 1, product: { id: productId, tenantId, recipe: null } }] }),
        update: async ({ data }: any) => { orderUpdates++; return { id: orderId, ...data }; },
      },
      ingredient: { updateMany: async () => { stockUpdates++; return { count: 1 }; } },
      stockMovement: { create: async () => assert.fail('no recipe should not create stock movements') },
      auditLog: { create: async () => undefined },
    };
    assert.equal((await patch('PREPARING')).status, 200);
    assert.equal(stockUpdates, 0);
    assert.equal(orderUpdates, 1);

    tx.order.findFirst = async () => makeOrder({ status: OrderStatus.PREPARING });
    assert.equal((await patch('PREPARING')).status, 200);
    assert.equal(orderUpdates, 1);
    assert.equal(stockUpdates, 0);
  });

  await t.test('rejects skipped or backward status transitions', async () => {
    tx = { order: { findFirst: async () => makeOrder() } };
    const skipped = await patch('COMPLETED');
    assert.equal(skipped.status, 409);
    tx.order.findFirst = async () => makeOrder({ status: OrderStatus.READY });
    assert.equal((await patch('PREPARING')).status, 409);
  });
});
