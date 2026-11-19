import { Router } from 'express';
import { OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { requireRoles, SALES_ROLES } from '../lib/permissions';

// Staff side of the QR table menu: calls from the tables ("chamar garçom", "pedir a conta") and QR orders waiting for acceptance.
export const tableRequestRoutes = Router();
tableRequestRoutes.use(requireAuth, requireTenant, requireRoles(...SALES_ROLES));
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});

tableRequestRoutes.get('/', async (req, res, next) => {
  try {
    const rows = await prisma.tableRequest.findMany({ where: { tenantId: req.auth!.tenantId!, status: 'OPEN', ...unitScope(req) }, orderBy: { createdAt: 'asc' }, take: 100, include: { table: { select: { label: true } } } });
    const now = Date.now();
    return res.json({ items: rows.map(row => ({ id: row.id, type: row.type, table: row.table.label, tableId: row.tableId, note: row.note, createdAt: row.createdAt, waitingMinutes: Math.floor((now - row.createdAt.getTime()) / 60_000) })) });
  } catch (error) { return next(error); }
});

tableRequestRoutes.post('/:id/done', async (req, res, next) => {
  try {
    const updated = await prisma.tableRequest.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, status: 'OPEN', ...unitScope(req) }, data: { status: 'DONE', handledAt: new Date(), handledById: req.auth!.userId } });
    return updated.count === 1 ? res.status(204).end() : res.status(409).json({ message: 'Request not found or already handled' });
  } catch (error) { return next(error); }
});

// QR orders held for confirmation. Accepting uses POST /orders/:id/release (sends the order to the kitchen); refusing is a cancellation.
tableRequestRoutes.get('/pending-orders', async (req, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { tenantId: req.auth!.tenantId!, ...unitScope(req), holdReason: 'QR_CONFIRMATION', releasedAt: null, status: OrderStatus.OPEN },
      orderBy: { createdAt: 'asc' }, take: 50,
      select: { id: true, code: true, tableLabel: true, customerName: true, total: true, createdAt: true, items: { where: { parentItemId: null }, select: { quantity: true, notes: true, product: { select: { name: true } } } } },
    });
    return res.json({ items: orders.map(order => ({ ...order, items: order.items.map(item => ({ name: item.product.name, quantity: item.quantity, notes: item.notes })) })) });
  } catch (error) { return next(error); }
});
tableRequestRoutes.post('/pending-orders/:id/refuse', async (req, res, next) => {
  try {
    const reason = z.object({ reason: z.string().trim().max(200).optional() }).safeParse(req.body ?? {});
    const result = await prisma.$transaction(async tx => {
      const claimed = await tx.order.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req), holdReason: 'QR_CONFIRMATION', releasedAt: null, status: OrderStatus.OPEN }, data: { status: OrderStatus.CANCELLED } });
      if (claimed.count !== 1) return false;
      await tx.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'QR_ORDER_REFUSED', entityType: 'Order', entityId: req.params.id, metadata: { reason: reason.success ? reason.data.reason ?? null : null } } });
      return true;
    });
    return result ? res.status(204).end() : res.status(409).json({ message: 'Order not found or already handled' });
  } catch (error) { return next(error); }
});
