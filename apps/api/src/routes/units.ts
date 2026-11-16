import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const unitRoutes = Router();
unitRoutes.use(requireAuth, requireTenant);
const schema = z.object({ name: z.string().min(2), code: z.string().max(30).optional(), address: z.string().max(500).optional() });
unitRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.unit.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { id: req.auth!.unitId } : {}) }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
unitRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    if (req.auth!.unitId) return res.status(403).json({ message: 'Only tenant-wide administrators can create units' });
    const unit = await prisma.unit.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId! } });
    return res.status(201).json(unit);
  } catch (error) { return next(error); }
});
