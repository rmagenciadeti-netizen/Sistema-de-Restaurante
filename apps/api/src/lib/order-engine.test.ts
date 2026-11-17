import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscountType, OrderChannel, Prisma } from '@prisma/client';
import { renderProductionTicket, paperColumns } from './ticket';
import { computeDiscount, normalizePhone, resolveOrderUnitPrice, OrderEngineError } from './order-engine';

test('production ticket wraps long lines to the paper width and lists notes', () => {
  const ticket = renderProductionTicket({
    title: 'Cozinha', orderCode: 'P-1', channel: 'TABLE', tableLabel: '12', customerName: 'Maria',
    createdAt: new Date('2026-01-02T03:04:00Z'),
    items: [{ quantity: 2, name: 'Hambúrguer artesanal de costela com queijo prato e cebola caramelizada', notes: 'sem cebola' }],
    companyHeader: ['Restaurante Exemplo', '12.345.678/0001-90'],
  }, 58);
  const lines = ticket.split('\n');
  assert.ok(lines.every(line => line.length <= paperColumns(58)));
  assert.ok(lines.includes('Mesa: 12'));
  assert.ok(lines.some(line => line.trim() === '* sem cebola'));
  assert.ok(lines.some(line => line.includes('Restaurante Exemplo')));
  assert.ok(lines.some(line => line.includes('12.345.678/0001-90')));
  const withPackaging = renderProductionTicket({ title: 'Cozinha', orderCode: 'P-1', channel: 'POS', createdAt: new Date('2026-01-02T03:04:00Z'), items: [{ quantity: 1, name: 'Marmita', extras: ['Embalagem'] }] });
  assert.match(withPackaging, /\+ Embalagem/);
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

test('free unit prices override promotions only for enabled POS products', () => {
  const product = { id: 'product-1', price: new Prisma.Decimal('10.00'), allowFreePrice: true, allowFractionalQuantity: false, soldByWeight: false };
  const promotions = [{ type: DiscountType.PERCENT, value: new Prisma.Decimal(50), startsAt: new Date(0), endsAt: null, active: true, productIds: ['product-1'] }];
  const now = new Date();
  assert.equal(resolveOrderUnitPrice(product, 7.5, OrderChannel.POS, promotions, now).toFixed(2), '7.50');
  assert.equal(resolveOrderUnitPrice(product, undefined, OrderChannel.POS, promotions, now).toFixed(2), '5.00');
  assert.throws(() => resolveOrderUnitPrice({ ...product, allowFreePrice: false }, 7.5, OrderChannel.POS, [], now), (error: unknown) => error instanceof OrderEngineError && error.reason === 'FREE_PRICE_NOT_ALLOWED');
  assert.throws(() => resolveOrderUnitPrice(product, 7.5, OrderChannel.TABLE, [], now), (error: unknown) => error instanceof OrderEngineError && error.reason === 'FREE_PRICE_NOT_ALLOWED');
  assert.throws(() => resolveOrderUnitPrice(product, 7.555, OrderChannel.POS, [], now), (error: unknown) => error instanceof OrderEngineError && error.reason === 'FREE_PRICE_INVALID');
});

test('production tickets preserve fractional quantities to three decimal places', () => {
  const ticket = renderProductionTicket({
    title: 'Cozinha', orderCode: 'P-2', channel: 'POS', createdAt: new Date('2026-01-02T03:04:00Z'),
    items: [{ quantity: 0.375, name: 'Queijo' }],
  });
  assert.match(ticket, /0\.375x Queijo/);
});
