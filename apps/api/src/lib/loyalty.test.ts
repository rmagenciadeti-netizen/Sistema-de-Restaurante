import test from 'node:test';
import assert from 'node:assert/strict';
import { daysSince, idleExpired, isBirthdayMonth, newCouponCode, pointsForOrder, redeemValue, type LoyaltyConfig } from './loyalty';

const config: LoyaltyConfig = { enabled: true, pointsPerReal: 1, redeemValuePerPoint: 0.05, minRedeemPoints: 100, validityDays: 90, couponValidDays: 30 };

test('points follow the configured rate and never go negative', () => {
  assert.equal(pointsForOrder(59.9, config), 59);
  assert.equal(pointsForOrder(59.9, { ...config, pointsPerReal: 2 }), 119);
  assert.equal(pointsForOrder(59.9, { ...config, enabled: false }), 0);
  assert.equal(pointsForOrder(-5, config), 0);
});

test('redeem value is rounded to cents', () => {
  assert.equal(redeemValue(100, config), 5);
  assert.equal(redeemValue(333, { ...config, redeemValuePerPoint: 0.03 }), 9.99);
});

test('idle expiry only applies with a validity and a previous purchase', () => {
  const now = new Date('2026-06-30T12:00:00Z');
  assert.equal(idleExpired(new Date('2026-03-01T12:00:00Z'), config, now), true);
  assert.equal(idleExpired(new Date('2026-06-01T12:00:00Z'), config, now), false);
  assert.equal(idleExpired(new Date('2026-01-01T12:00:00Z'), { ...config, validityDays: 0 }, now), false);
  assert.equal(idleExpired(null, config, now), false);
});

test('birthday month is read from the calendar date', () => {
  assert.equal(isBirthdayMonth(new Date('1990-06-15T00:00:00Z'), new Date('2026-06-30T23:00:00Z')), true);
  assert.equal(isBirthdayMonth(new Date('1990-07-01T00:00:00Z'), new Date('2026-06-30T12:00:00Z')), false);
  assert.equal(isBirthdayMonth(null, new Date()), false);
});

test('days since and coupon code format', () => {
  assert.equal(daysSince(new Date('2026-06-20T12:00:00Z'), new Date('2026-06-30T12:00:00Z')), 10);
  assert.equal(daysSince(null, new Date()), null);
  assert.match(newCouponCode(), /^FID-[0-9A-F]{8}$/);
});
