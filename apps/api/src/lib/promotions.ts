import { DiscountType, Prisma } from '@prisma/client';

export type ActivePromotion = { type: DiscountType; value: Prisma.Decimal; startsAt: Date; endsAt: Date | null; active: boolean; productIds: string[] };

const round2 = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function isPromotionLive(promotion: Pick<ActivePromotion, 'active' | 'startsAt' | 'endsAt'>, now = new Date()) {
  return promotion.active && promotion.startsAt <= now && (!promotion.endsAt || promotion.endsAt >= now);
}

// Best (lowest) price among the live promotions that include the product; never below zero.
export function effectiveUnitPrice(productId: string, price: Prisma.Decimal, promotions: ActivePromotion[], now = new Date()): Prisma.Decimal {
  let best = price;
  for (const promotion of promotions) {
    if (!promotion.productIds.includes(productId) || !isPromotionLive(promotion, now)) continue;
    const reduction = promotion.type === DiscountType.PERCENT ? price.mul(promotion.value).div(100) : promotion.value;
    const candidate = round2(price.sub(reduction));
    const clamped = candidate.lt(0) ? new Prisma.Decimal(0) : candidate;
    if (clamped.lt(best)) best = clamped;
  }
  return best;
}
