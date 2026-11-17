import { Router } from 'express';
import { z } from 'zod';
import { OrderItemStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { releaseDueOrders } from '../lib/scheduling';
import { requireAuth, requireTenant } from '../middleware/auth';
import { MANAGEMENT_ROLES, PRODUCTION_ROLES, requireRoles } from '../lib/permissions';

export const productionRoutes = Router();
productionRoutes.use(requireAuth, requireTenant);
const unitScoped = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {});
const sectorSchema = z.object({ name: z.string().min(2).max(100), code: z.string().max(30).optional(), unitId: z.string().uuid().optional(), color: z.string().max(20).optional(), description: z.string().max(300).optional(), sortOrder: z.number().int().min(0).max(1000).default(0), avgPrepMinutes: z.number().int().min(1).max(600).optional(), autoPrint: z.boolean().default(false), showOnKds: z.boolean().default(true) });
productionRoutes.get('/sectors', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try { const items = await prisma.productionSector.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}) }, include: { printers: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
productionRoutes.post('/sectors', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = sectorSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const sector = await prisma.productionSector.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId!, unitId } });
    return res.status(201).json(sector);
  } catch (error) { return next(error); }
});
productionRoutes.patch('/sectors/:id', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = sectorSchema.omit({ unitId: true }).partial().extend({ active: z.boolean().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.productionSector.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScoped(req) } }); if (!current) return res.status(404).json({ message: 'Sector not found' });
    const sector = await prisma.productionSector.update({ where: { id: current.id }, data: parsed.data });
    await prisma.auditLog.create({ data: { tenantId: current.tenantId, actorUserId: req.auth!.userId, action: 'SECTOR_UPDATED', entityType: 'ProductionSector', entityId: current.id } });
    return res.json(sector);
  } catch (error) { return next(error); }
});
productionRoutes.get('/kds', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const sectorId = typeof req.query.sectorId === 'string' ? req.query.sectorId : undefined;
    await releaseDueOrders(prisma, { tenantId: req.auth!.tenantId! });
    const items = await prisma.orderItem.findMany({ where: { ...(sectorId ? { sectorId } : {}), status: { in: [OrderItemStatus.PENDING, OrderItemStatus.PREPARING, OrderItemStatus.READY] }, product: { isCombo: false }, order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: ['OPEN', 'PREPARING', 'READY'] }, OR: [{ scheduledFor: null }, { releasedAt: { not: null } }] } }, include: { product: { include: { sector: true } }, modifiers: true, parentItem: { select: { product: { select: { name: true } } } }, order: { select: { id: true, code: true, channel: true, tableLabel: true, customerName: true, createdAt: true } } }, orderBy: { createdAt: 'asc' }, take: 200 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
productionRoutes.patch('/items/:id/status', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const parsed = z.nativeEnum(OrderItemStatus).safeParse(req.body?.status); if (!parsed.success) return res.status(400).json({ message: 'Invalid production status' });
    const item = await prisma.orderItem.findFirst({ where: { id: req.params.id, order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } } });
    if (!item) return res.status(404).json({ message: 'Production item not found' });
    const updated = await prisma.orderItem.update({ where: { id: item.id }, data: { status: parsed.data } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'KDS_ITEM_STATUS_CHANGED', entityType: 'OrderItem', entityId: item.id, metadata: { status: parsed.data } } });
    return res.json(updated);
  } catch (error) { return next(error); }
});
