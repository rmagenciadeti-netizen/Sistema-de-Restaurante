import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('bank reconciliation and commission closing', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'i'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString('base64');
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };
  const id = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${id}`, slug: `${label}-${id}`, status: 'ACTIVE' } });
    const user = (role: UserRole) => prisma.user.create({ data: { tenantId: tenant.id, name: `${role}${label}`, email: `${role}-${label}-${id}@test.local`, passwordHash: 'x', role } });
    return { tenant, user };
  };
  const A = await makeTenant('rec'); const B = await makeTenant('recother');
  const adminUser = await A.user(UserRole.ADMIN); const waiterUser = await A.user(UserRole.WAITER); const cashierUser = await A.user(UserRole.CASHIER); const otherUser = await B.user(UserRole.ADMIN);
  const tokenOf = (user: { id: string }, tenantId: string, role: UserRole) => signAccessToken({ userId: user.id, tenantId, unitId: null, role });
  const admin = tokenOf(adminUser, A.tenant.id, UserRole.ADMIN); const cashier = tokenOf(cashierUser, A.tenant.id, UserRole.CASHIER); const otherAdmin = tokenOf(otherUser, B.tenant.id, UserRole.ADMIN);
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [A.tenant.id, B.tenant.id] } } });
    await prisma.$disconnect();
  });

  await t.test('bank statement matches paid entries, confirms once, and stays inside the restaurant', async () => {
    const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
    const income = await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, description: 'Recebimento Pix', type: 'INCOME', amount: 150.5, paidAmount: 150.5, status: 'PAID', settledAt: day('2026-11-05') } });
    await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, description: 'Aluguel', type: 'EXPENSE', amount: 2000, paidAmount: 2000, status: 'PAID', settledAt: day('2026-11-06') } });
    await prisma.financialEntry.create({ data: { tenantId: A.tenant.id, description: 'Sem extrato', type: 'EXPENSE', amount: 33, paidAmount: 33, status: 'PAID', settledAt: day('2026-11-05') } });
    await prisma.financialEntry.create({ data: { tenantId: B.tenant.id, description: 'Outro restaurante', type: 'INCOME', amount: 99, paidAmount: 99, status: 'PAID', settledAt: day('2026-11-05') } });
    const csv = 'data;descricao;valor\n05/11/2026;Pix;150,50\n06/11/2026;Aluguel;-2.000,00\n05/11/2026;Tarifa;-12,00\n05/11/2026;Outro;99,00';
    const match = await call('POST', '/bank-reconciliation/match', admin, { format: 'CSV', content: csv });
    assert.equal(match.status, 200, JSON.stringify(match.body));
    assert.deepEqual(match.body.summary, { lines: 4, matched: 2, unmatchedLines: 2, unmatchedEntries: 1 });
    assert.equal(match.body.unmatchedEntries[0].description, 'Sem extrato');
    const ids = match.body.matches.filter((item: any) => item.entryId).map((item: any) => item.entryId);
    assert.equal((await call('POST', '/bank-reconciliation/confirm', cashier, { entryIds: ids })).status, 403);
    assert.equal((await call('POST', '/bank-reconciliation/confirm', otherAdmin, { entryIds: ids })).body.reconciled, 0, 'entries of another restaurant are untouched');
    assert.equal((await call('POST', '/bank-reconciliation/confirm', admin, { entryIds: ids })).body.reconciled, 2);
    assert.equal((await call('POST', '/bank-reconciliation/confirm', admin, { entryIds: ids })).body.reconciled, 0, 'idempotent');
    assert.ok((await prisma.financialEntry.findUnique({ where: { id: income.id } }))!.reconciledAt);
    const again = await call('POST', '/bank-reconciliation/match', admin, { format: 'CSV', content: csv });
    assert.equal(again.body.summary.matched, 0, 'reconciled entries are not offered again');
    assert.equal((await call('POST', '/bank-reconciliation/match', admin, { format: 'CSV', content: 'nada\nvalido' })).status, 400);
  });

  await t.test('commission closing is frozen; later cancellation shows as adjustment; no overlap', async () => {
    const product = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Prato', price: 100 } });
    const order = await prisma.order.create({ data: { tenantId: A.tenant.id, code: `K${id}`, status: 'COMPLETED', subtotal: 100, total: 100, createdByUserId: waiterUser.id, items: { create: [{ productId: product.id, quantity: 1, unitPrice: 100, total: 100 }] } } });
    await prisma.user.update({ where: { id: waiterUser.id }, data: { commissionPercent: 10 } });
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString() };
    const closed = await call('POST', '/commissions/closings', admin, range);
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.total, 10);
    assert.equal((await call('POST', '/commissions/closings', admin, range)).status, 409);
    assert.equal((await call('POST', '/commissions/closings', cashier, range)).status, 403);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
    const list = await call('GET', '/commissions/closings', admin);
    assert.deepEqual([list.body.items[0].closedTotal, list.body.items[0].currentTotal, list.body.items[0].adjustment], [10, 0, -10]);
    assert.deepEqual((await call('GET', '/commissions/closings', otherAdmin)).body.items, []);
  });
});
