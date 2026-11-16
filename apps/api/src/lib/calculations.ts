import { Prisma } from '@prisma/client';

export function calculateLineTotal(unitPrice: Prisma.Decimal, quantity: number): Prisma.Decimal {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new RangeError('Quantity must be a positive integer');
  return unitPrice.mul(quantity).toDecimalPlaces(2);
}

export function calculateCashDifference(opening: Prisma.Decimal, cashPayments: Prisma.Decimal, closing: Prisma.Decimal): Prisma.Decimal {
  return closing.sub(opening.add(cashPayments)).toDecimalPlaces(2);
}
