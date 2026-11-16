import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const productionRoutes = Router();
productionRoutes.use(requireAuth, requireTenant);
const sectorSchema = z.object({ name: z.string().min(2), code: z.string().max(30).optional(), unitId: z.string().uuid().optional(), color: z.string().max(20).optional(), autoPrint: z.boolean().default(false), showOnKds: z.boolean().default(true) });
productionRoutes.get('/sectors', async (req, res, next) => {
  try { const items = await prisma.productionSector.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }, include: { printers: true }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
productionRoutes.post('/sectors', async (req, res, next) => {
  try {
    const parsed = sectorSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const sector = await prisma.productionSector.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId!, unitId } });
    return res.status(201).json(sector);
  } catch (error) { return next(error); }
});
productionRoutes.get('/kds', async (req, res, next) => {
  try { const items = await prisma.orderItem.findMany({ where: { order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: ['OPEN', 'PREPARING', 'READY'] } } }, include: { product: { include: { sector: true } }, order: { select: { id: true, code: true, createdAt: true } } }, orderBy: { createdAt: 'asc' }, take: 200 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
