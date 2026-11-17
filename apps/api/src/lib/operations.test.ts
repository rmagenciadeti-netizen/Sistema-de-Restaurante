import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscountType, Prisma } from '@prisma/client';
import { decideSchedule, isStoreOpen, localParts } from './scheduling';
import { buildScaleBarcode, buildScaleFile, eanCheckDigit, parseScaleBarcode } from './scale';
import { effectiveUnitPrice } from './promotions';
import { parseSettings } from './settings';

const dec = (value: string | number) => new Prisma.Decimal(value);
const scheduling = (overrides: Partial<ReturnType<typeof parseSettings>['scheduling']> = {}) => ({ ...parseSettings({}).scheduling, enabled: true, ...overrides });

test('settings fall back to defaults per section and keep valid ones', () => {
  const parsed = parseSettings({ hours: { mode: 'BOGUS' }, scale: { enabled: true, prefix: '2' }, scheduling: 'nope' });
  assert.equal(parsed.hours.mode, 'OPEN');
  assert.equal(parsed.scale.enabled, true);
  assert.equal(parsed.scheduling.enabled, false);
  assert.ok(parsed.orderStatuses.items.some(item => item.key === 'OUT_FOR_DELIVERY' && item.active));
});

test('scheduling enforces lead, horizon, blocked period and weekly slots in the restaurant time zone', () => {
  const now = new Date('2026-03-02T15:00:00Z'); // Monday 12:00 in São Paulo
  const tz = 'America/Sao_Paulo';
  assert.equal(decideSchedule(new Date('2026-03-02T15:02:00Z'), scheduling(), tz, now).ok, false);
  assert.deepEqual(decideSchedule(new Date('2026-03-20T15:00:00Z'), scheduling({ maxDaysAhead: 7 }), tz, now), { ok: false, reason: 'SCHEDULE_TOO_FAR' });
  assert.deepEqual(decideSchedule(new Date('2026-03-04T15:00:00Z'), scheduling({ blockedFrom: '2026-03-04', blockedTo: '2026-03-05' }), tz, now), { ok: false, reason: 'SCHEDULE_BLOCKED' });
  const slots = [{ day: 3, start: '11:00', end: '14:00' }];
  assert.deepEqual(decideSchedule(new Date('2026-03-04T22:00:00Z'), scheduling({ slots }), tz, now), { ok: false, reason: 'SCHEDULE_OUTSIDE_SLOTS' });
  const inside = decideSchedule(new Date('2026-03-04T16:00:00Z'), scheduling({ slots, leadTime: '01:00' }), tz, now);
  assert.ok(inside.ok);
  if (inside.ok) { assert.equal(inside.releaseAt.toISOString(), '2026-03-04T15:00:00.000Z'); assert.equal(inside.releaseNow, false); }
  assert.deepEqual(decideSchedule(new Date('2026-03-04T16:00:00Z'), { ...scheduling(), enabled: false }, tz, now), { ok: false, reason: 'SCHEDULING_DISABLED' });
});

test('orders scheduled close to now are released immediately; prep time can extend the lead', () => {
  const now = new Date('2026-03-02T15:00:00Z');
  const soon = decideSchedule(new Date('2026-03-02T15:20:00Z'), scheduling({ leadTime: '00:30' }), 'UTC', now);
  assert.ok(soon.ok && soon.releaseNow);
  const long = decideSchedule(new Date('2026-03-02T17:00:00Z'), scheduling({ leadTime: '00:30' }), 'UTC', now, 90);
  assert.ok(long.ok && long.releaseAt.toISOString() === '2026-03-02T15:30:00.000Z');
});

test('local time and opening hours use the configured time zone', () => {
  assert.deepEqual(localParts(new Date('2026-03-02T02:30:00Z'), 'America/Sao_Paulo'), { weekday: 0, minutes: 23 * 60 + 30, day: '2026-03-01' });
  const hours = { timezone: 'America/Sao_Paulo', mode: 'SCHEDULE' as const, weekly: [{ day: 1, start: '11:00', end: '23:00' }] };
  assert.equal(isStoreOpen(hours, new Date('2026-03-02T15:00:00Z')), true);
  assert.equal(isStoreOpen(hours, new Date('2026-03-02T05:00:00Z')), false);
  assert.equal(isStoreOpen({ ...hours, mode: 'CLOSED' }, new Date('2026-03-02T15:00:00Z')), false);
});

test('scale barcodes round-trip weight and price and reject bad check digits', () => {
  const weight = { prefix: '2', codeLength: 6, barcodeLength: 13, saleType: 'WEIGHT' as const };
  const code = buildScaleBarcode(weight, 123, 1250);
  assert.equal(code.length, 13);
  assert.equal(eanCheckDigit(code.slice(0, -1)), Number(code.at(-1)));
  const parsed = parseScaleBarcode(code, weight);
  assert.equal(parsed?.scaleCode, 123);
  assert.equal(parsed?.weightKg?.toString(), '1.25');
  assert.equal(parseScaleBarcode(code.slice(0, -1) + String((Number(code.at(-1)) + 1) % 10), weight), null);
  assert.equal(parseScaleBarcode('7891234567895', weight), null);
  const price = { ...weight, saleType: 'PRICE' as const };
  assert.equal(parseScaleBarcode(buildScaleBarcode(price, 7, 1990), price)?.total?.toString(), '19.9');
});

test('scale files list every product and strip accents', () => {
  const { fileName, content } = buildScaleFile('TOLEDO', [{ scaleCode: 5, name: 'Pão de açúcar', price: dec('12.5'), sellByWeight: true, shelfLifeDays: 3, department: 2, notes: null }]);
  assert.equal(fileName, 'ITENSMGV.TXT');
  assert.match(content, /^020000005001250003Pao de acucar/);
});

test('promotions pick the lowest live price and never go below zero', () => {
  const now = new Date('2026-03-02T12:00:00Z');
  const base = { startsAt: new Date('2026-03-01T00:00:00Z'), endsAt: null, active: true, productIds: ['p1'] };
  const promos = [{ ...base, type: DiscountType.PERCENT, value: dec(10) }, { ...base, type: DiscountType.FIXED, value: dec(3) }, { ...base, type: DiscountType.FIXED, value: dec(99), productIds: ['other'] }, { ...base, type: DiscountType.FIXED, value: dec(5), active: false }];
  assert.equal(effectiveUnitPrice('p1', dec(20), promos, now).toString(), '17');
  assert.equal(effectiveUnitPrice('p1', dec(2), promos, now).toString(), '0');
  assert.equal(effectiveUnitPrice('p1', dec(20), [{ ...promos[0], startsAt: new Date('2026-04-01T00:00:00Z') }], now).toString(), '20');
});
