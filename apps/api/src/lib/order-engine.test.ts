import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscountType, Prisma } from '@prisma/client';
import { renderProductionTicket, paperColumns } from './ticket';
import { computeDiscount, normalizePhone } from './order-engine';

test('production ticket wraps long lines to the paper width and lists notes', () => {
  const ticket = renderProductionTicket({
    title: 'Cozinha', orderCode: 'P-1', channel: 'TABLE', tableLabel: '12', customerName: 'Maria',
    createdAt: new Date('2026-01-02T03:04:00Z'),
    items: [{ quantity: 2, name: 'Hambúrguer artesanal de costela com queijo prato e cebola caramelizada', notes: 'sem cebola' }],
  }, 58);
  const lines = ticket.split('\n');
  assert.ok(lines.every(line => line.length <= paperColumns(58)));
  assert.ok(lines.includes('Mesa: 12'));
  assert.ok(lines.some(line => line.trim() === '* sem cebola'));
  assert.match(ticket, /2x Hambúrguer/);
});

test('coupon discounts round to cents and never exceed the order base', () => {
  const base = new Prisma.Decimal('33.33');
  assert.equal(computeDiscount({ type: DiscountType.PERCENT, value: new Prisma.Decimal(10) }, base).toString(), '3.33');
  assert.equal(computeDiscount({ type: DiscountType.FIXED, value: new Prisma.Decimal(50) }, base).toString(), '33.33');
});

test('phone normalization keeps digits and rejects implausible numbers', () => {
  assert.equal(normalizePhone('+55 (11) 91234-5678'), '5511912345678');
  assert.equal(normalizePhone('123'), null);
});
