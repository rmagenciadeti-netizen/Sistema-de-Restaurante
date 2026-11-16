import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const productRoutes = Router();
productRoutes.use(requireAuth, requireTenant);
const schema = z.object({ name: z.string().min(2).max(160), categoryId: z.string().uuid().optional().nullable(), sectorId: z.string().uuid().optional().nullable(), unitId: z.string().uuid().optional().nullable(), code: z.string().max(50).optional().nullable(), description: z.string().max(2000).optional().nullable(), price: z.number().nonnegative(), cost: z.number().nonnegative().optional().nullable(), active: z.boolean().default(true), prepTimeMinutes: z.number().int().nonnegative().optional().nullable() });
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
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { unitId, categoryId, sectorId, ...data } = parsed.data; const effectiveUnitId = unitId ?? req.auth!.unitId;
    if (effectiveUnitId && !await prisma.unit.findFirst({ where: { id: effectiveUnitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (categoryId && !await prisma.productCategory.findFirst({ where: { id: categoryId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Category does not belong to this tenant' });
    if (sectorId && !await prisma.productionSector.findFirst({ where: { id: sectorId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Production sector does not belong to this tenant' });
    const item = await prisma.product.create({ data: { ...data, tenantId: req.auth!.tenantId!, unitId: effectiveUnitId, categoryId, sectorId } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'PRODUCT_CREATED', entityType: 'Product', entityId: item.id } });
    return res.status(201).json(item);
  } catch (error) { return next(error); }
});
productRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const where = { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) };
    const current = await prisma.product.findFirst({ where }); if (!current) return res.status(404).json({ message: 'Product not found' });
    const unitId = parsed.data.unitId === undefined ? current.unitId : (parsed.data.unitId ?? req.auth!.unitId);
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (parsed.data.sectorId && !await prisma.productionSector.findFirst({ where: { id: parsed.data.sectorId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Production sector does not belong to this tenant' });
    const { unitId: _unitId, ...data } = parsed.data; const updated = await prisma.product.update({ where: { id: current.id }, data: { ...data, ...(parsed.data.unitId !== undefined ? { unitId } : {}) } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'PRODUCT_UPDATED', entityType: 'Product', entityId: updated.id } });
    return res.json(updated);
  } catch (error) { return next(error); }
});
