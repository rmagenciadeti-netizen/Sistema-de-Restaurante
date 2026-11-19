import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { tefAdapters } from '../lib/tef/adapter';
import { createMockAdapter } from '../lib/tef/mock-adapter';

// TEF day-to-day operation (undo, recovery sweep, events, voucher) and receipt printing (copies, widths, footer, dedup, audited reprint). Needs RUN_DB_TESTS=1.
const enabled = process.env.RUN_DB_TESTS === '1';

test('TEF operation and receipt printing', { skip: !enabled, timeout: 180_000 }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32); process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64'); process.env.FISCAL_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://r.example'; process.env.RM_ADMIN_URL = 'https://a.example';
  const mock = createMockAdapter(); tefAdapters.register(mock);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token: string, body?: unknown) => { const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) as any }; };
  const sfx = randomBytes(4).toString('hex');
  const mk = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${sfx}`, slug: `${label}-${sfx}`, status: 'ACTIVE' } });
    const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
    const tokens = {} as Record<'ADMIN' | 'CASHIER' | 'WAITER' | 'FINANCE', string>;
    for (const role of ['ADMIN', 'CASHIER', 'WAITER', 'FINANCE'] as const) { const user = await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${label}-${sfx}@t.local`, passwordHash: 'x', role: UserRole[role] } }); tokens[role] = signAccessToken({ userId: user.id, tenantId: tenant.id, unitId: null, role: UserRole[role] }); }
    return { tenant, unit, tokens };
  };
  const A = await mk('op'); const B = await mk('opx');
  const { ADMIN: admin, CASHIER: cashier, WAITER: waiter, FINANCE: finance } = A.tokens;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); tefAdapters.clear(); const ids = [A.tenant.id, B.tenant.id]; await prisma.order.deleteMany({ where: { tenantId: { in: ids } } }); await prisma.tenant.deleteMany({ where: { id: { in: ids } } }); await prisma.$disconnect(); });
  await call('PUT', '/tef/config/mock', admin, { establishmentCnpj: '11222333000181', terminalId: 'SIM-1' }); await call('POST', '/tef/config/mock/test', admin);
  const product = await prisma.product.create({ data: { tenantId: A.tenant.id, name: 'Prato', price: 100 } });
  const newOrder = async () => (await call('POST', '/orders', admin, { channel: 'POS', unitId: A.unit.id, items: [{ productId: product.id, quantity: 1 }] })).body.id as string;
  const pay = (orderId: string, extra: Record<string, unknown> = {}) => call('POST', '/tef/transactions', cashier, { orderId, provider: 'mock', method: 'CREDIT_CARD', amount: 100, idempotencyKey: randomUUID(), ...extra });
  const payments = (orderId: string) => prisma.payment.count({ where: { orderId, status: 'CONFIRMED' } });

  await t.test('undo: an unresolved charge is closed only on provider confirmation; an approved one is never undone', async () => {
    const pending = await pay(await newOrder(), { hints: { scenario: 'waiting' } }); const id = pending.body.transaction.id;
    assert.equal((await call('POST', `/tef/transactions/${id}/undo`, cashier, { reason: 'x', confirm: true })).status, 400, 'reason and confirmation are mandatory');
    const undone = await call('POST', `/tef/transactions/${id}/undo`, cashier, { reason: 'Cliente desistiu', confirm: true });
    assert.equal(undone.status, 200, JSON.stringify(undone.body)); assert.equal(undone.body.transaction.status, 'CANCELLED'); assert.equal(await payments(pending.body.transaction.orderId), 0);
    assert.equal(await prisma.auditLog.count({ where: { tenantId: A.tenant.id, action: 'TEF_TRANSACTION_UNDONE', entityId: id } }), 1);
    assert.equal((await call('POST', `/tef/transactions/${id}/undo`, cashier, { reason: 'Cliente desistiu', confirm: true })).body.outcome, 'ALREADY_CLOSED');
    // Timeout that the provider actually approved: the query finds the approval, so it is recorded (once) and NOT undone.
    const timeout = await pay(await newOrder(), { hints: { scenario: 'timeout' } }); assert.equal(timeout.body.transaction.status, 'TIMEOUT');
    const refused = await call('POST', `/tef/transactions/${timeout.body.transaction.id}/undo`, cashier, { reason: 'Tentativa de desfazer', confirm: true });
    assert.equal(refused.status, 409); assert.equal(refused.body.outcome, 'APPROVED_USE_REVERSAL'); assert.equal(await payments(timeout.body.transaction.orderId), 1, 'the real approval was recorded exactly once');
    assert.equal((await call('POST', `/tef/transactions/${timeout.body.transaction.id}/undo`, B.tokens.CASHIER, { reason: 'Outra empresa', confirm: true })).status, 404);
  });

  await t.test('recovery sweep finds approvals lost to timeouts, once, without resending', async () => {
    const orderIds = [await newOrder(), await newOrder()];
    const stuck = [await pay(orderIds[0], { hints: { scenario: 'timeout' } }), await pay(orderIds[1], { hints: { scenario: 'timeout' } })];
    assert.equal((await call('POST', '/tef/recover', cashier)).body.checked, 0, 'recent attempts are left alone');
    await prisma.tefTransaction.updateMany({ where: { id: { in: stuck.map(item => item.body.transaction.id) } }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    mock.remote.delete(stuck[1].body.transaction.id);
    const swept = await call('POST', '/tef/recover', cashier);
    assert.deepEqual([swept.body.checked, swept.body.approved, swept.body.closed], [2, 1, 1]);
    assert.deepEqual([await payments(orderIds[0]), await payments(orderIds[1])], [1, 0]);
    assert.equal((await call('POST', '/tef/recover', cashier)).body.checked, 0, 'a second sweep finds nothing and never duplicates');
    assert.equal((await call('POST', '/tef/recover', waiter)).status, 403);
  });

  await t.test('events: finance roles only, no amounts; voucher goes through the same validated path', async () => {
    const voucher = await pay(await newOrder(), { method: 'VOUCHER' });
    assert.equal(voucher.body.transaction.status, 'APPROVED'); assert.equal(voucher.body.transaction.method, 'VOUCHER');
    assert.equal((await call('GET', '/tef/events', cashier)).status, 403);
    const events = await call('GET', '/tef/events', finance);
    assert.equal(events.status, 200); assert.ok(events.body.items.length >= 6); assert.ok(!JSON.stringify(events.body).match(/"amount"/));
    assert.equal((await call('GET', '/tef/events', B.tokens.ADMIN)).body.total, 0, 'another company sees none of them');
  });

  await t.test('receipts: copies, paper widths, footer, original printed once, reprint audited, dedup, no TEF slip without approval', async () => {
    await call('PUT', '/settings/printing', admin, { footer: 'Obrigado pela preferência! Volte sempre.', receiptCopies: 2, tefCopies: 'BOTH', paper: '55mm' });
    const orderId = await newOrder(); const approved = await pay(orderId); const id = approved.body.transaction.id;
    // No receipt printer yet: the job is queued as FAILED (retryable), never silently lost.
    const noPrinter = await call('POST', `/printing/receipts/tef/${id}`, cashier, {});
    assert.equal(noPrinter.status, 201); assert.equal(noPrinter.body.printerFound, false); assert.ok(noPrinter.body.items.every((job: any) => job.status === 'FAILED' && job.error === 'NO_ACTIVE_RECEIPT_PRINTER'));
    await prisma.printJob.deleteMany({ where: { tenantId: A.tenant.id } });
    const widths: Record<number, number> = { 55: 30, 58: 32, 80: 48 }; const printers: Record<number, string> = {};
    for (const mm of [55, 58, 80]) { const made = await call('POST', '/printing/printers', admin, { name: `Cupom ${mm}`, connectionType: 'NETWORK', address: '10.0.0.1', port: 9100, kind: 'RECEIPT', paperWidthMm: mm, isPrimary: mm === 80 }); assert.equal(made.status, 201, JSON.stringify(made.body)); printers[mm] = made.body.id; }
    const first = await call('POST', `/printing/receipts/tef/${id}`, cashier, { copy: 'BOTH' });
    assert.equal(first.status, 201); assert.equal(first.body.items.length, 2, 'customer and merchant copies'); assert.ok(first.body.items.every((job: any) => job.kind === 'RECEIPT' && job.status === 'PENDING' && job.printerId === printers[80]));
    const text = first.body.items.map((job: any) => job.content).join('\n');
    assert.ok(text.replace(/\s+/g, ' ').includes('VIA CLIENTE') && text.replace(/\s+/g, ' ').includes('VIA ESTABELECIMENTO') && text.replace(/\s+/g, ' ').includes('SIMULAÇÃO - SEM VALOR') && text.includes('R$ 100,00'));
    const again = await call('POST', `/printing/receipts/tef/${id}`, cashier, { copy: 'BOTH' });
    assert.equal(again.status, 200); assert.equal(again.body.deduplicated, true); assert.equal(await prisma.printJob.count({ where: { tenantId: A.tenant.id, kind: 'RECEIPT' } }), 2, 'double click queues nothing new');
    const noReason = await call('POST', `/printing/receipts/tef/${id}`, cashier, { copy: 'CUSTOMER', reason: 'x' }); assert.equal(noReason.status, 400);
    const reprint = await call('POST', `/printing/receipts/tef/${id}`, cashier, { copy: 'CUSTOMER', reason: 'Papel emperrou na primeira via' });
    assert.equal(reprint.status, 201); assert.ok(reprint.body.items[0].content.includes('REIMPRESSÃO'));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: A.tenant.id, action: 'RECEIPT_REPRINTED' } }); assert.equal((audit.metadata as any).reason, 'Papel emperrou na primeira via');
    // Paper widths and the configured footer on the sale receipt (2 copies).
    for (const mm of [55, 58, 80]) {
      const o = await newOrder(); await pay(o);
      const sale = await call('POST', `/printing/receipts/order/${o}`, cashier, { printerId: printers[mm] }); assert.equal(sale.status, 201, JSON.stringify(sale.body));
      assert.equal(sale.body.items.length, 2, 'configured copies');
      const lines = sale.body.items[0].content.split('\n'); assert.ok(lines.every((line: string) => line.length <= widths[mm]), `${mm}mm fits ${widths[mm]} columns`);
      const flat = sale.body.items[0].content.replace(/\s+/g, ' '); assert.ok(flat.includes('NÃO É DOCUMENTO FISCAL') && flat.includes('Obrigado'));
    }
    // Not approved: no slip. Waiter and other company are refused.
    const denied = await pay(await newOrder(), { hints: { scenario: 'deny' } });
    assert.equal((await call('POST', `/printing/receipts/tef/${denied.body.transaction.id}`, cashier, {})).status, 409);
    assert.equal((await call('POST', `/printing/receipts/tef/${id}`, waiter, {})).status, 403);
    assert.equal((await call('POST', `/printing/receipts/tef/${id}`, B.tokens.CASHIER, {})).status, 404);
    // Fiscal document: only authorised documents print; homologation is marked on the slip.
    const doc = await prisma.fiscalDocument.create({ data: { tenantId: A.tenant.id, unitId: A.unit.id, orderId, provider: 'focus', kind: 'NFCE', status: 'PENDING', series: '1', number: '42', environment: 'HOMOLOGATION' } });
    assert.equal((await call('POST', `/printing/receipts/fiscal/${doc.id}`, cashier, {})).status, 409);
    await prisma.fiscalDocument.update({ where: { id: doc.id }, data: { status: 'AUTHORIZED', accessKey: '3'.repeat(44), protocol: '135260000000001' } });
    const fiscal = await call('POST', `/printing/receipts/fiscal/${doc.id}`, cashier, {}); assert.equal(fiscal.status, 201, JSON.stringify(fiscal.body));
    assert.ok(fiscal.body.items[0].content.includes('SEM VALOR FISCAL') && fiscal.body.items[0].content.includes('Nº 42'));
    assert.equal((await call('POST', `/printing/receipts/fiscal/${doc.id}`, cashier, {})).body.deduplicated, true);
  });
  await t.test('automatic slip: queued once after approval when the terminal asks for it, never for an unapproved charge', async () => {
    await call('PUT', '/tef/config/mock', admin, { establishmentCnpj: '11222333000181', terminalId: 'SIM-1', printing: { autoPrint: true, copies: 1, paper: '80mm', allowReprint: true } });
    const before = await prisma.printJob.count({ where: { tenantId: A.tenant.id, kind: 'RECEIPT' } });
    const approved = await pay(await newOrder()); assert.equal(approved.body.paid, true);
    assert.equal(await prisma.printJob.count({ where: { tenantId: A.tenant.id, kind: 'RECEIPT' } }), before + 2, 'customer and merchant copies');
    await call('POST', `/tef/transactions/${approved.body.transaction.id}/sync`, cashier);
    assert.equal(await prisma.printJob.count({ where: { tenantId: A.tenant.id, kind: 'RECEIPT' } }), before + 2, 'a later query does not print again');
    await pay(await newOrder(), { hints: { scenario: 'deny' } });
    assert.equal(await prisma.printJob.count({ where: { tenantId: A.tenant.id, kind: 'RECEIPT' } }), before + 2, 'denied: nothing printed');
  });
});
