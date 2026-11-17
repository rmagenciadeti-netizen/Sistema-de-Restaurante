import { BillingPeriod } from '@prisma/client';

export const PERIOD_MONTHS: Record<BillingPeriod, number> = { MONTHLY: 1, QUARTERLY: 3, SEMIANNUAL: 6, ANNUAL: 12 };

type Numeric = number | string | { toString(): string } | null | undefined;
export const toCents = (value: Numeric) => Math.round(Number(value ?? 0) * 100);
export const fromCents = (cents: number) => cents / 100;

export type QuoteLine = { type: 'PLAN' | 'MODULE' | 'FEE' | 'DISCOUNT'; key?: string; label: string; amount: number };
export type DiscountRule = { label: string; type: 'PERCENT' | 'FIXED'; value: number; source: 'NEGOTIATED' | 'CAMPAIGN' | 'COUPON' };
export type Quote = { lines: QuoteLine[]; subtotal: number; discount: number; total: number };

export type CatalogModulePrice = {
  billing: 'MONTHLY' | 'ANNUAL' | 'ONE_TIME' | 'FREE';
  monthlyPrice: Numeric; annualPrice: Numeric; oneTimePrice: Numeric;
  promoPrice?: Numeric; promoStartsAt?: Date | null; promoEndsAt?: Date | null;
};
export type AddonGrant = { moduleKey: string; unitPrice?: Numeric; discountPercent?: Numeric; free?: boolean; blocked?: boolean; startsAt?: Date | null; endsAt?: Date | null };

export function isPromoActive(module: Pick<CatalogModulePrice, 'promoPrice' | 'promoStartsAt' | 'promoEndsAt'>, at: Date) {
  if (module.promoPrice === null || module.promoPrice === undefined) return false;
  return (!module.promoStartsAt || module.promoStartsAt <= at) && (!module.promoEndsAt || module.promoEndsAt >= at);
}

// Recurring amount (in cents) of an add-on for one billing period. ONE_TIME modules are never recurring and FREE ones cost nothing.
export function addonRecurringCents(grant: AddonGrant, module: CatalogModulePrice, period: BillingPeriod, at: Date): number {
  if (grant.free || grant.blocked || module.billing === 'FREE' || module.billing === 'ONE_TIME') return 0;
  if ((grant.startsAt && grant.startsAt > at) || (grant.endsAt && grant.endsAt < at)) return 0;
  const months = PERIOD_MONTHS[period];
  let base: number;
  if (grant.unitPrice !== null && grant.unitPrice !== undefined) base = toCents(grant.unitPrice) * months;
  else if (module.billing === 'ANNUAL') base = Math.round(toCents(module.annualPrice) * months / 12);
  else base = toCents(isPromoActive(module, at) ? module.promoPrice : module.monthlyPrice) * months;
  const percent = Math.min(100, Math.max(0, Number(grant.discountPercent ?? 0)));
  return Math.round(base * (100 - percent) / 100);
}

export type QuoteInput = {
  planLabel: string; planCents: number;
  addons: { key: string; label: string; cents: number }[];
  fees: { label: string; cents: number }[];
  discounts: DiscountRule[];
};

// Discounts apply to the recurring part (plan + add-ons) only, each over the same base (no compounding), and can never exceed it; fees are never discounted.
export function computeQuote(input: QuoteInput): Quote {
  const lines: QuoteLine[] = [{ type: 'PLAN', label: input.planLabel, amount: fromCents(input.planCents) }];
  for (const addon of input.addons) if (addon.cents > 0) lines.push({ type: 'MODULE', key: addon.key, label: addon.label, amount: fromCents(addon.cents) });
  const recurring = input.planCents + input.addons.reduce((sum, addon) => sum + Math.max(0, addon.cents), 0);
  let remaining = recurring;
  let discountTotal = 0;
  for (const rule of input.discounts) {
    const raw = rule.type === 'PERCENT' ? Math.round(recurring * Math.min(100, Math.max(0, rule.value)) / 100) : toCents(rule.value);
    const applied = Math.min(raw, remaining);
    if (applied <= 0) continue;
    remaining -= applied; discountTotal += applied;
    lines.push({ type: 'DISCOUNT', label: rule.label, amount: -fromCents(applied) });
  }
  const feeTotal = input.fees.reduce((sum, fee) => sum + Math.max(0, fee.cents), 0);
  for (const fee of input.fees) if (fee.cents > 0) lines.push({ type: 'FEE', label: fee.label, amount: fromCents(fee.cents) });
  return { lines, subtotal: fromCents(recurring + feeTotal), discount: fromCents(discountTotal), total: fromCents(recurring - discountTotal + feeTotal) };
}

export type PromotionRules = {
  status: string; startsAt?: Date | null; endsAt?: Date | null; validUntil?: Date | null;
  planIds: string[]; moduleKeys: string[]; audience: 'NEW' | 'EXISTING' | 'BOTH';
  maxUses?: number | null; perTenantLimit?: number | null; cycles: number; minAmount?: Numeric;
};
export type PromotionContext = { now: Date; planId: string | null; moduleKeys: string[]; isNewCustomer: boolean; totalUses: number; tenantUses: number; recurringCents: number };

// Returns the reason a coupon/campaign cannot be applied, or null when it can.
export function promotionDenial(rules: PromotionRules, ctx: PromotionContext): string | null {
  if (rules.status !== 'ACTIVE') return 'Promoção ou cupom inativo';
  if (rules.startsAt && rules.startsAt > ctx.now) return 'Ainda não está vigente';
  const end = rules.endsAt ?? rules.validUntil;
  if (end && end < ctx.now) return 'Vigência encerrada';
  if (rules.audience === 'NEW' && !ctx.isNewCustomer) return 'Válido somente para novos clientes';
  if (rules.audience === 'EXISTING' && ctx.isNewCustomer) return 'Válido somente para clientes atuais';
  const restricted = rules.planIds.length > 0 || rules.moduleKeys.length > 0;
  if (restricted) {
    const planOk = ctx.planId !== null && rules.planIds.includes(ctx.planId);
    const moduleOk = rules.moduleKeys.some(key => ctx.moduleKeys.includes(key));
    if (!planOk && !moduleOk) return 'Não se aplica ao plano ou aos módulos do cliente';
  }
  if (rules.maxUses != null && ctx.totalUses >= rules.maxUses) return 'Limite total de utilizações atingido';
  const tenantLimit = Math.min(rules.perTenantLimit ?? Number.MAX_SAFE_INTEGER, Math.max(1, rules.cycles));
  if (ctx.tenantUses >= tenantLimit) return 'Limite de utilizações por cliente atingido';
  if (rules.minAmount !== null && rules.minAmount !== undefined && ctx.recurringCents < toCents(rules.minAmount)) return 'Valor mínimo não atingido';
  return null;
}

// Competence key used to prevent duplicate charges, e.g. 2026-11 (monthly), 2026-Q4, 2026-S2, 2026 (annual).
export function invoiceReference(period: BillingPeriod, at: Date): string {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  if (period === 'MONTHLY') return `${year}-${String(month + 1).padStart(2, '0')}`;
  if (period === 'QUARTERLY') return `${year}-Q${Math.floor(month / 3) + 1}`;
  if (period === 'SEMIANNUAL') return `${year}-S${month < 6 ? 1 : 2}`;
  return String(year);
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

// Monthly recurring revenue of one contract: contracted price normalised to a month, after the negotiated discount.
export function monthlyRecurringCents(contractedPrice: Numeric, period: BillingPeriod | null, discountPercent: Numeric): number {
  const months = PERIOD_MONTHS[period ?? 'MONTHLY'];
  const net = toCents(contractedPrice) * (100 - Math.min(100, Math.max(0, Number(discountPercent ?? 0)))) / 100;
  return Math.round(net / months);
}
