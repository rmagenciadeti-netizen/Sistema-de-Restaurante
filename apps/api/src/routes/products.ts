import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const productRoutes = Router();
productRoutes.use(requireAuth, requireTenant);
const schema = z.object({ name: z.string().min(2), categoryId: z.string().uuid().optional(), sectorId: z.string().uuid().optional(), unitId: z.string().uuid().optional(), code: z.string().max(50).optional(), price: z.number().nonnegative(), cost: z.number().nonnegative().optional(), active: z.boolean().default(true), prepTimeMinutes: z.number().int().nonnegative().optional() });
productRoutes.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) };
    const [items, total] = await Promise.all([prisma.product.findMany({ where, include: { category: true, sector: true }, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.product.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
productRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { unitId, categoryId, sectorId, ...data } = parsed.data;
    const effectiveUnitId = unitId ?? req.auth!.unitId;
    if (effectiveUnitId && !await prisma.unit.findFirst({ where: { id: effectiveUnitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (categoryId && !await prisma.productCategory.findFirst({ where: { id: categoryId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Category does not belong to this tenant' });
    if (sectorId && !await prisma.productionSector.findFirst({ where: { id: sectorId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Production sector does not belong to this tenant' });
    const item = await prisma.product.create({ data: { ...data, tenantId: req.auth!.tenantId!, unitId: effectiveUnitId, categoryId, sectorId } });
    return res.status(201).json(item);
  } catch (error) { return next(error); }
});
