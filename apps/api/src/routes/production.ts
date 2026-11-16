import { Router } from 'express';
import { z } from 'zod';
import { OrderItemStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const productionRoutes = Router();
productionRoutes.use(requireAuth, requireTenant);
const sectorSchema = z.object({ name: z.string().min(2).max(100), code: z.string().max(30).optional(), unitId: z.string().uuid().optional(), color: z.string().max(20).optional(), autoPrint: z.boolean().default(false), showOnKds: z.boolean().default(true) });
productionRoutes.get('/sectors', async (req, res, next) => {
  try { const items = await prisma.productionSector.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }, include: { printers: true }, orderBy: { name: 'asc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
productionRoutes.post('/sectors', async (req, res, next) => {
  try {
    const parsed = sectorSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const sector = await prisma.productionSector.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId!, unitId } });
    return res.status(201).json(sector);
  } catch (error) { return next(error); }
});
productionRoutes.get('/kds', async (req, res, next) => {
  try {
    const sectorId = typeof req.query.sectorId === 'string' ? req.query.sectorId : undefined;
    const items = await prisma.orderItem.findMany({ where: { ...(sectorId ? { sectorId } : {}), status: { in: [OrderItemStatus.PENDING, OrderItemStatus.PREPARING, OrderItemStatus.READY] }, order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: ['OPEN', 'PREPARING', 'READY'] } } }, include: { product: { include: { sector: true } }, order: { select: { id: true, code: true, channel: true, tableLabel: true, customerName: true, createdAt: true } } }, orderBy: { createdAt: 'asc' }, take: 200 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
productionRoutes.patch('/items/:id/status', async (req, res, next) => {
  try {
    const parsed = z.nativeEnum(OrderItemStatus).safeParse(req.body?.status); if (!parsed.success) return res.status(400).json({ message: 'Invalid production status' });
    const item = await prisma.orderItem.findFirst({ where: { id: req.params.id, order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } } });
    if (!item) return res.status(404).json({ message: 'Production item not found' });
    const updated = await prisma.orderItem.update({ where: { id: item.id }, data: { status: parsed.data } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'KDS_ITEM_STATUS_CHANGED', entityType: 'OrderItem', entityId: item.id, metadata: { status: parsed.data } } });
    return res.json(updated);
  } catch (error) { return next(error); }
});
