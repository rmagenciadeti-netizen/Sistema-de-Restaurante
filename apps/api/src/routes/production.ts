import { Router } from 'express';
import { z } from 'zod';
import { OrderItemStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { releaseDueOrders } from '../lib/scheduling';
import { firstStageOf, kdsStagesSection, stageOfItem, type KdsPhase } from '../lib/kds-stages';
import { loadSettings, saveSettingsSection } from '../lib/settings';
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
// Custom KDS stages: the restaurant's own production flow, each one mapped to a real item phase so order rules are unchanged.
productionRoutes.get('/stages', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try { return res.json((await loadSettings(prisma, req.auth!.tenantId!)).kdsStages); } catch (error) { return next(error); }
});
productionRoutes.put('/stages', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = kdsStagesSection.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const saved = await prisma.$transaction(async tx => {
      const result = await saveSettingsSection(tx, req.auth!.tenantId!, 'kdsStages', parsed.data);
      await tx.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'KDS_STAGES_UPDATED', entityType: 'TenantSettings', entityId: req.auth!.tenantId!, metadata: { stages: result.stages.map(stage => `${stage.key}:${stage.phase}`) } } });
      return result;
    });
    return res.json(saved);
  } catch (error) { return next(error); }
});
productionRoutes.get('/kds', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const sectorId = typeof req.query.sectorId === 'string' ? req.query.sectorId : undefined;
    await releaseDueOrders(prisma, { tenantId: req.auth!.tenantId! });
    const items = await prisma.orderItem.findMany({ where: { ...(sectorId ? { sectorId } : {}), status: { in: [OrderItemStatus.PENDING, OrderItemStatus.PREPARING, OrderItemStatus.READY] }, product: { isCombo: false }, order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: ['OPEN', 'PREPARING', 'READY'] }, OR: [{ scheduledFor: null }, { releasedAt: { not: null } }] } }, include: { product: { include: { sector: true } }, modifiers: true, parentItem: { select: { product: { select: { name: true } } } }, order: { select: { id: true, code: true, channel: true, tableLabel: true, customerName: true, createdAt: true, priority: true, createdBy: { select: { name: true } } } } }, orderBy: [{ order: { priority: 'desc' } }, { createdAt: 'asc' }], take: 200 });
    const { stages } = (await loadSettings(prisma, req.auth!.tenantId!)).kdsStages;
    return res.json({ items: items.map(item => ({ ...item, stage: stageOfItem(stages, item) })), total: items.length, stages, generatedAt: new Date() });
  } catch (error) { return next(error); }
});
productionRoutes.post('/orders/:id/priority', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ priority: z.boolean() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const updated = await prisma.order.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: { in: ['OPEN', 'PREPARING', 'READY'] } }, data: { priority: parsed.data.priority } });
    if (updated.count !== 1) return res.status(404).json({ message: 'Order not found' });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'KDS_ORDER_PRIORITY', entityType: 'Order', entityId: req.params.id, metadata: { priority: parsed.data.priority } } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});
// Production history: how long each sector really takes (wait to start, preparation) and how often it exceeds its expected time.
productionRoutes.get('/history', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(Date.now() - 7 * 86_400_000);
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const sectorId = typeof req.query.sectorId === 'string' ? req.query.sectorId : undefined;
    const items = await prisma.orderItem.findMany({
      where: { readyAt: { gte: from, lte: to }, ...(sectorId ? { sectorId } : {}), order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } },
      orderBy: { readyAt: 'desc' }, take: 2000,
      select: { id: true, quantity: true, createdAt: true, startedAt: true, readyAt: true, deliveredAt: true, product: { select: { name: true } }, sector: { select: { id: true, name: true, avgPrepMinutes: true } }, order: { select: { code: true, channel: true, tableLabel: true } } },
    });
    const minutes = (start: Date | null, end: Date | null) => (start && end ? Math.max(0, Math.round(((end.getTime() - start.getTime()) / 60_000) * 10) / 10) : null);
    const rows = items.map(item => ({ id: item.id, product: item.product.name, quantity: item.quantity, sector: item.sector?.name ?? 'Sem setor', expected: item.sector?.avgPrepMinutes ?? null, order: item.order.code, table: item.order.tableLabel, channel: item.order.channel, waitMinutes: minutes(item.createdAt, item.startedAt), prepMinutes: minutes(item.startedAt ?? item.createdAt, item.readyAt), totalMinutes: minutes(item.createdAt, item.readyAt), readyAt: item.readyAt, deliveredAt: item.deliveredAt }));
    const bySector = new Map<string, { sector: string; items: number; prepTotal: number; waitTotal: number; late: number; expected: number | null }>();
    for (const row of rows) {
      const entry = bySector.get(row.sector) ?? { sector: row.sector, items: 0, prepTotal: 0, waitTotal: 0, late: 0, expected: row.expected };
      entry.items += 1; entry.prepTotal += row.prepMinutes ?? 0; entry.waitTotal += row.waitMinutes ?? 0;
      if (row.expected !== null && (row.totalMinutes ?? 0) > row.expected) entry.late += 1;
      bySector.set(row.sector, entry);
    }
    return res.json({ period: { from, to }, truncated: items.length >= 2000, sectors: [...bySector.values()].map(entry => ({ sector: entry.sector, items: entry.items, expectedMinutes: entry.expected, averagePrepMinutes: Math.round((entry.prepTotal / entry.items) * 10) / 10, averageWaitMinutes: Math.round((entry.waitTotal / entry.items) * 10) / 10, late: entry.late, latePercent: entry.expected === null ? null : Math.round((entry.late / entry.items) * 1000) / 10 })), items: rows.slice(0, 200) });
  } catch (error) { return next(error); }
});
productionRoutes.patch('/items/:id/status', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    // Either a real item status or one of the restaurant's custom stages (which resolves to its phase); never both.
    const body = z.object({ status: z.nativeEnum(OrderItemStatus).optional(), stage: z.string().max(30).optional() }).refine(value => (value.status === undefined) !== (value.stage === undefined)).safeParse(req.body);
    if (!body.success) return res.status(400).json({ message: 'Invalid production status' });
    const { stages } = (await loadSettings(prisma, req.auth!.tenantId!)).kdsStages;
    const chosen = body.data.stage !== undefined ? stages.find(stage => stage.key === body.data.stage) : undefined;
    if (body.data.stage !== undefined && !chosen) return res.status(400).json({ message: 'Unknown KDS stage' });
    const parsed = { data: (chosen ? chosen.phase : body.data.status) as OrderItemStatus };
    const stageKey = (chosen ?? firstStageOf(stages, parsed.data as KdsPhase)).key;
    const item = await prisma.orderItem.findFirst({ where: { id: req.params.id, order: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } } });
    if (!item) return res.status(404).json({ message: 'Production item not found' });
    const updated = await prisma.$transaction(async tx => {
      const now = new Date();
      const timeline = parsed.data === OrderItemStatus.PREPARING ? { startedAt: item.startedAt ?? now, readyAt: null, deliveredAt: null }
        : parsed.data === OrderItemStatus.READY ? { startedAt: item.startedAt ?? now, readyAt: item.readyAt ?? now, deliveredAt: null }
        : parsed.data === OrderItemStatus.DELIVERED ? { startedAt: item.startedAt ?? now, readyAt: item.readyAt ?? now, deliveredAt: now }
        : parsed.data === OrderItemStatus.PENDING ? { startedAt: null, readyAt: null, deliveredAt: null } : {};
      const saved = await tx.orderItem.update({ where: { id: item.id }, data: { status: parsed.data, kdsStage: stageKey, ...timeline } });
      await tx.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'KDS_ITEM_STATUS_CHANGED', entityType: 'OrderItem', entityId: item.id, metadata: { status: parsed.data, stage: stageKey } } });
      // The whole order is "pronto" when every active item of it is ready or already delivered: that is the notification the waiter acts on.
      let orderReady = false;
      if (parsed.data === OrderItemStatus.READY) {
        const pending = await tx.orderItem.count({ where: { orderId: item.orderId, status: { in: [OrderItemStatus.PENDING, OrderItemStatus.PREPARING] }, product: { isCombo: false } } });
        orderReady = pending === 0;
        if (orderReady) await tx.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'KDS_ORDER_READY', entityType: 'Order', entityId: item.orderId } });
      }
      return { ...saved, orderReady };
    });
    return res.json(updated);
  } catch (error) { return next(error); }
});
