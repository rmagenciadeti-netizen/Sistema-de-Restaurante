import { Router } from 'express';
import { DiscountType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, MANAGEMENT_ROLES, SALES_ROLES } from '../lib/permissions';
import { moneySchema } from '../lib/money';

export const couponRoutes = Router();
couponRoutes.use(requireAuth, requireTenant, allowRead(SALES_ROLES, MANAGEMENT_ROLES));
const couponSchema = z.object({
  code: z.string().min(3).max(40).regex(/^[A-Za-z0-9_-]+$/).transform(code => code.toUpperCase()),
  type: z.nativeEnum(DiscountType), value: moneySchema.refine(value => value > 0, 'Value must be positive'),
  minOrder: moneySchema.optional(), maxUses: z.number().int().positive().optional(),
  validFrom: z.string().datetime().optional(), validUntil: z.string().datetime().optional(),
}).refine(coupon => coupon.type !== DiscountType.PERCENT || coupon.value <= 100, { message: 'Percent discount cannot exceed 100', path: ['value'] })
  .refine(coupon => !coupon.validFrom || !coupon.validUntil || coupon.validFrom <= coupon.validUntil, { message: 'validUntil must be after validFrom', path: ['validUntil'] });
const dates = (data: { validFrom?: string; validUntil?: string }) => ({ validFrom: data.validFrom ? new Date(data.validFrom) : undefined, validUntil: data.validUntil ? new Date(data.validUntil) : undefined });

couponRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.coupon.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { createdAt: 'desc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
couponRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = couponSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    if (await prisma.coupon.findUnique({ where: { tenantId_code: { tenantId, code: parsed.data.code } } })) return res.status(409).json({ message: 'Coupon code already exists' });
    return res.status(201).json(await prisma.coupon.create({ data: { ...parsed.data, ...dates(parsed.data), tenantId } }));
  } catch (error) { return next(error); }
});
couponRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ active: z.boolean().optional(), maxUses: z.number().int().positive().nullable().optional(), validUntil: z.string().datetime().nullable().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.coupon.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); if (!current) return res.status(404).json({ message: 'Coupon not found' });
    const { validUntil, ...rest } = parsed.data;
    return res.json(await prisma.coupon.update({ where: { id: current.id }, data: { ...rest, ...(validUntil === undefined ? {} : { validUntil: validUntil ? new Date(validUntil) : null }) } }));
  } catch (error) { return next(error); }
});
