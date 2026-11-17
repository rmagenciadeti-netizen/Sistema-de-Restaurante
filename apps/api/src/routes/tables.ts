import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, MANAGEMENT_ROLES, SALES_ROLES } from '../lib/permissions';

export const tableRoutes = Router();
tableRoutes.use(requireAuth, requireTenant, allowRead(SALES_ROLES, MANAGEMENT_ROLES));
const newQrToken = () => randomBytes(24).toString('base64url');
const schema = z.object({ label: z.string().min(1).max(30), seats: z.number().int().min(1).max(100).default(4), unitId: z.string().uuid().optional() });

tableRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.restaurantTable.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, orderBy: [{ unitId: 'asc' }, { label: 'asc' }] }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
tableRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (!unitId) return res.status(400).json({ message: 'unitId is required' });
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (!await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (await prisma.restaurantTable.findFirst({ where: { tenantId, unitId, label: parsed.data.label } })) return res.status(409).json({ message: 'Table label already exists in this unit' });
    const table = await prisma.restaurantTable.create({ data: { tenantId, unitId, label: parsed.data.label, seats: parsed.data.seats, qrToken: newQrToken() } });
    return res.status(201).json(table);
  } catch (error) { return next(error); }
});
tableRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ label: z.string().min(1).max(30), seats: z.number().int().min(1).max(100), active: z.boolean() }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.restaurantTable.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!current) return res.status(404).json({ message: 'Table not found' });
    if (parsed.data.label && parsed.data.label !== current.label && await prisma.restaurantTable.findFirst({ where: { tenantId: current.tenantId, unitId: current.unitId, label: parsed.data.label } })) return res.status(409).json({ message: 'Table label already exists in this unit' });
    return res.json(await prisma.restaurantTable.update({ where: { id: current.id }, data: parsed.data }));
  } catch (error) { return next(error); }
});
tableRoutes.post('/:id/rotate-qr', async (req, res, next) => {
  try {
    const current = await prisma.restaurantTable.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!current) return res.status(404).json({ message: 'Table not found' });
    const table = await prisma.restaurantTable.update({ where: { id: current.id }, data: { qrToken: newQrToken() } });
    await prisma.auditLog.create({ data: { tenantId: current.tenantId, actorUserId: req.auth!.userId, action: 'TABLE_QR_ROTATED', entityType: 'RestaurantTable', entityId: current.id } });
    return res.json(table);
  } catch (error) { return next(error); }
});
