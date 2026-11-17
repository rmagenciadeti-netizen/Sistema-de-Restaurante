import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, addonRecurringCents, computeQuote, invoiceReference, monthlyRecurringCents, promotionDenial, type PromotionContext, type PromotionRules } from './commercial';
import { effectiveModules, licenseDenial } from './licensing';

const at = new Date('2026-11-18T12:00:00Z');
const module = { billing: 'MONTHLY' as const, monthlyPrice: 50, annualPrice: 500, oneTimePrice: 0 };

test('quote applies percent and fixed discounts over the recurring base and never discounts fees', () => {
  const quote = computeQuote({
    planLabel: 'RM PRO', planCents: 20000, addons: [{ key: 'delivery', label: 'Delivery', cents: 5000 }], fees: [{ label: 'Implantação', cents: 10000 }],
    discounts: [{ label: '10%', type: 'PERCENT', value: 10, source: 'COUPON' }, { label: 'Fixo', type: 'FIXED', value: 30, source: 'CAMPAIGN' }],
  });
  assert.equal(quote.discount, 55);
  assert.equal(quote.subtotal, 350);
  assert.equal(quote.total, 295);
  const capped = computeQuote({ planLabel: 'P', planCents: 1000, addons: [], fees: [], discounts: [{ label: 'x', type: 'FIXED', value: 999, source: 'COUPON' }] });
  assert.equal(capped.total, 0);
});

test('add-ons price by period, honour promo window, free grants, discounts and dates', () => {
  assert.equal(addonRecurringCents({ moduleKey: 'crm' }, module, 'QUARTERLY', at), 15000);
  assert.equal(addonRecurringCents({ moduleKey: 'crm' }, { ...module, promoPrice: 30, promoStartsAt: new Date('2026-11-01'), promoEndsAt: new Date('2026-11-30') }, 'MONTHLY', at), 3000);
  assert.equal(addonRecurringCents({ moduleKey: 'crm' }, { ...module, promoPrice: 30, promoEndsAt: new Date('2026-10-31') }, 'MONTHLY', at), 5000);
  assert.equal(addonRecurringCents({ moduleKey: 'crm', free: true }, module, 'MONTHLY', at), 0);
  assert.equal(addonRecurringCents({ moduleKey: 'crm', unitPrice: 40, discountPercent: 25 }, module, 'MONTHLY', at), 3000);
  assert.equal(addonRecurringCents({ moduleKey: 'crm', endsAt: new Date('2026-10-01') }, module, 'MONTHLY', at), 0);
});

const rules: PromotionRules = { status: 'ACTIVE', planIds: ['p1'], moduleKeys: [], audience: 'NEW', validUntil: new Date('2026-12-31'), maxUses: 2, perTenantLimit: 1, cycles: 1, minAmount: 100 };
const ctx: PromotionContext = { now: at, planId: 'p1', moduleKeys: [], isNewCustomer: true, totalUses: 0, tenantUses: 0, recurringCents: 20000 };

test('coupons are validated for validity, audience, plan, limits and minimum value', () => {
  assert.equal(promotionDenial(rules, ctx), null);
  assert.match(promotionDenial({ ...rules, validUntil: new Date('2026-01-01') }, ctx) ?? '', /encerrada/);
  assert.match(promotionDenial(rules, { ...ctx, isNewCustomer: false }) ?? '', /novos/);
  assert.match(promotionDenial(rules, { ...ctx, planId: 'p2' }) ?? '', /plano/);
  assert.match(promotionDenial(rules, { ...ctx, totalUses: 2 }) ?? '', /total/);
  assert.match(promotionDenial(rules, { ...ctx, tenantUses: 1 }) ?? '', /por cliente/);
  assert.match(promotionDenial(rules, { ...ctx, recurringCents: 5000 }) ?? '', /mínimo/);
  assert.equal(promotionDenial({ ...rules, perTenantLimit: null, cycles: 3 }, { ...ctx, tenantUses: 2 }), null);
});

test('references prevent duplicates per competence and dates roll by month', () => {
  assert.equal(invoiceReference('MONTHLY', at), '2026-11');
  assert.equal(invoiceReference('QUARTERLY', at), '2026-Q4');
  assert.equal(invoiceReference('SEMIANNUAL', at), '2026-S2');
  assert.equal(invoiceReference('ANNUAL', at), '2026');
  assert.equal(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(monthlyRecurringCents(1200, 'ANNUAL', 50), 5000);
});

test('entitlements respect tenant blocks, global blocks, dates and grace period', () => {
  const grants = [{ moduleKey: 'pos' }, { moduleKey: 'crm', blocked: true }, { moduleKey: 'fiscal', endsAt: new Date('2026-01-01') }, { moduleKey: 'reports', startsAt: new Date('2027-01-01') }, { moduleKey: 'delivery' }];
  assert.deepEqual(effectiveModules(grants, ['delivery'], at), ['pos']);
  const expired = { status: 'ACTIVE' as const, validUntil: new Date('2026-11-10T00:00:00Z') };
  assert.match(licenseDenial(expired, [], '/api/v1/units', at) ?? '', /expired/);
  assert.equal(licenseDenial({ ...expired, graceDays: 10 }, [], '/api/v1/units', at), null);
});
