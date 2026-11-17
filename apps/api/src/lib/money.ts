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
