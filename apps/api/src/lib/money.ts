import { Prisma } from '@prisma/client';
import { z } from 'zod';

export const MAX_MONEY = new Prisma.Decimal('9999999999.99');

export const moneySchema = z.number().finite().nonnegative().refine(
  value => {
    const decimal = new Prisma.Decimal(value);
    return decimal.decimalPlaces() <= 2 && decimal.lte(MAX_MONEY);
  },
  'Amount must have at most two decimal places and fit Decimal(12,2)',
);

export const positiveMoneySchema = moneySchema.refine(value => value > 0, 'Amount must be positive');

export const positiveQuantitySchema = (max: number) => z.number().finite().positive().max(max).refine(
  value => new Prisma.Decimal(value).decimalPlaces() <= 3,
  'Quantity must have at most three decimal places',
);
