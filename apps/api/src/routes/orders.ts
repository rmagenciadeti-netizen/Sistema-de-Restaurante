import { Router } from 'express';
import { OrderChannel, OrderStatus, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { applyStatusSideEffects } from '../lib/order-effects';
import { consumeOrderInventory, canTransitionOrder, OrderInventoryError } from '../lib/order-inventory';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { createOrder, OrderEngineError } from '../lib/order-engine';
import { decideSchedule, isHeldOrder, releaseDueOrders, releaseOrder } from '../lib/scheduling';
import { loadSettings } from '../lib/settings';
import { ALL_TENANT_ROLES, requireRoles, PRODUCTION_ROLES, SALES_ROLES } from '../lib/permissions';

export const orderRoutes = Router();
orderRoutes.use(requireAuth, requireTenant, requireRoles(...ALL_TENANT_ROLES));
const createSchema = z.object({
  unitId: z.string().uuid().optional(),
  channel: z.nativeEnum(OrderChannel).default(OrderChannel.POS),
  customerName: z.string().max(160).optional(),
  customerPhone: z.string().max(30).optional(),
  marketingConsent: z.boolean().optional(),
  tableId: z.string().uuid().optional(),
  tableLabel: z.string().max(30).optional(),
  couponCode: z.string().max(40).optional(),
  deliveryZoneId: z.string().uuid().optional(),
  applyServiceFee: z.boolean().optional(),
  scheduledFor: z.string().datetime().optional(),
  couvertPeople: z.number().int().positive().max(500).optional(),
  adjustment: z.object({ mode: z.enum(['DISCOUNT', 'SURCHARGE']), type: z.enum(['FIXED', 'PERCENT']), value: z.number().positive().max(9_999_999) }).optional(),
  adjustmentReleaseId: z.string().uuid().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(999), weightKg: z.number().positive().max(999.999).optional(), notes: z.string().max(500).optional(), modifiers: z.array(z.object({ optionId: z.string().uuid(), quantity: z.number().int().positive().max(20).optional() })).max(30).optional() })).min(1).max(100),
});
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().max(80).optional(), channel: z.nativeEnum(OrderChannel).optional(), status: z.nativeEnum(OrderStatus).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  scope: z.enum(['all', 'active', 'scheduled', 'held']).default('all'),
  type: z.enum(['delivery', 'pickup']).optional(),
  table: z.enum(['1']).optional(),
});
const ACTIVE_STATUSES: OrderStatus[] = [OrderStatus.OPEN, OrderStatus.PREPARING, OrderStatus.READY];
orderRoutes.get('/', async (req, res, next) => {
  try {
    const parsed = listQuery.safeParse(req.query); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { page, pageSize, q, channel, status, from, to, scope, type, table } = parsed.data;
    await releaseDueOrders(prisma, { tenantId: req.auth!.tenantId! });
    const digits = q && /^\d+$/.test(q) ? Number(q) : null;
    const scheduleView = scope === 'scheduled' || scope === 'held';
    const range = from || to ? { gte: from ? new Date(from) : undefined, lte: to ? new Date(to) : undefined } : undefined;
    const and: Prisma.OrderWhereInput[] = [];
    if (type === 'delivery') and.push({ channel: OrderChannel.DELIVERY });
    if (type === 'pickup') and.push({ channel: { not: OrderChannel.DELIVERY } });
    if (table) and.push({ OR: [{ channel: OrderChannel.TABLE }, { tableId: { not: null } }, { tableLabel: { not: null } }] });
    // Scheduled orders still waiting for their release time are not production work yet.
    if (scope === 'active') and.push({ NOT: { scheduledFor: { not: null }, releasedAt: null } });
    if (q) and.push({ OR: [{ code: { contains: q, mode: 'insensitive' } }, { customerName: { contains: q, mode: 'insensitive' } }, { tableLabel: { contains: q, mode: 'insensitive' } }, ...(digits !== null && digits < 2_000_000_000 ? [{ number: digits }] : [])] });
    const where: Prisma.OrderWhereInput = {
      tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}),
      ...(channel ? { channel } : {}), ...(status ? { status } : {}),
      ...(range ? (scheduleView ? { scheduledFor: { not: null, ...range } } : { createdAt: range }) : {}),
      ...(scope === 'active' ? { status: status && ACTIVE_STATUSES.includes(status) ? status : { in: ACTIVE_STATUSES } } : {}),
      ...(scope === 'scheduled' && !range ? { scheduledFor: { not: null } } : {}),
      ...(scope === 'held' ? { scheduledFor: range ? { not: null, ...range } : { not: null }, releasedAt: null, status: OrderStatus.OPEN } : {}),
      ...(and.length ? { AND: and } : {}),
    };
    const include = { items: { include: { product: true, modifiers: true } }, customer: { select: { id: true, name: true, phone: true } }, payments: { where: { status: PaymentStatus.CONFIRMED }, select: { id: true, amount: true, method: true } }, deliveryJob: { select: { id: true, status: true, courierName: true, dispatchedAt: true } } } satisfies Prisma.OrderInclude;
    const [items, total] = await Promise.all([prisma.order.findMany({ where, include, orderBy: scheduleView ? { scheduledFor: 'asc' } : { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.order.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
orderRoutes.post('/', requireRoles(...SALES_ROLES), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (parsed.data.customerPhone && !parsed.data.customerName) return res.status(400).json({ message: 'customerName is required with customerPhone' });
    const { customerName, customerPhone, marketingConsent, scheduledFor, adjustmentReleaseId, ...rest } = parsed.data;
    // Staff outside management need a fresh administrator-password release (POST /releases, action DISCOUNT) to grant a manual discount.
    if (rest.adjustment?.mode === 'DISCOUNT' && req.auth!.role !== UserRole.ADMIN && req.auth!.role !== UserRole.MANAGER) {
      const release = adjustmentReleaseId ? await prisma.passwordRelease.findFirst({ where: { id: adjustmentReleaseId, tenantId, action: 'DISCOUNT', requestedByUserId: req.auth!.userId, createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) } } }) : null;
      if (!release) return res.status(403).json({ message: 'DISCOUNT_RELEASE_REQUIRED' });
    }
    const order = await serializable(prisma, tx => createOrder(tx, {
      ...rest, scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined, tenantId, unitId, actorUserId: req.auth!.userId,
      customer: customerName ? { name: customerName, phone: customerPhone, marketingConsent } : undefined,
    }));
    return res.status(201).json(order);
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason });
    return next(error);
  }
});
orderRoutes.patch('/:id/status', requireRoles(...PRODUCTION_ROLES), async (req, res, next) => {
  try {
    const status = z.nativeEnum(OrderStatus).safeParse(req.body?.status); if (!status.success) return res.status(400).json({ message: 'Invalid order status' });
    const { tenantId, unitId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const order = await tx.order.findFirst({
        where: { id: req.params.id, tenantId: tenantId!, ...(unitId ? { unitId } : {}) },
        include: {
          customer: true,
          items: {
            include: {
              modifiers: true,
              product: {
                include: {
                  recipe: {
                    include: { ingredients: { include: { ingredient: true } } },
                  },
                },
              },
            },
          },
        },
      });
      if (!order) return { kind: 'error', message: 'Order not found', status: 404 } as const;
      if (!canTransitionOrder(order.status, status.data)) return { kind: 'error', message: 'Invalid order status transition', status: 409 } as const;
      if (order.status === status.data) return { kind: 'ok', order } as const;
      if (status.data === OrderStatus.CANCELLED && await tx.payment.count({ where: { tenantId: order.tenantId, orderId: order.id, status: 'CONFIRMED' } }) > 0) return { kind: 'error', message: 'Refund confirmed payments before cancelling this order', status: 409 } as const;

      if (status.data === OrderStatus.PREPARING && isHeldOrder(order)) return { kind: 'error', message: 'Scheduled order has not been released yet', status: 409 } as const;
      if (status.data === OrderStatus.PREPARING) await consumeOrderInventory(tx, order, userId);
      const updated = await tx.order.update({ where: { id: order.id }, data: { status: status.data } });
      await applyStatusSideEffects(tx, order, status.data, userId);
      await tx.auditLog.create({ data: { tenantId: order.tenantId, actorUserId: userId, action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityId: order.id, metadata: { status: status.data } } });
      return { kind: 'ok', order: updated } as const;
    });
    if (result.kind === 'error') return res.status(result.status).json({ message: result.message });
    return res.json(result.order);
  } catch (error) {
    if (error instanceof OrderInventoryError) {
      const message = error.reason === 'INSUFFICIENT_STOCK' ? 'Insufficient stock to start preparing this order' : 'Order recipe contains invalid or out-of-scope ingredients';
      return res.status(409).json({ message });
    }
    return next(error);
  }
});

orderRoutes.post('/:id/release', requireRoles(...SALES_ROLES), async (req, res, next) => {
  try {
    const { tenantId, unitId, userId } = req.auth!;
    const released = await serializable(prisma, async tx => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, tenantId: tenantId!, ...(unitId ? { unitId } : {}) }, select: { id: true } });
      if (!order) return 'missing' as const;
      return (await releaseOrder(tx, order.id, tenantId!, userId)) ? 'released' as const : 'not-held' as const;
    });
    if (released === 'missing') return res.status(404).json({ message: 'Order not found' });
    if (released === 'not-held') return res.status(409).json({ message: 'Order is not waiting for release' });
    return res.json({ released: true });
  } catch (error) { return next(error); }
});
// Moves a held scheduled order to another time; `scheduledFor: null` sends it to production right away.
orderRoutes.patch('/:id/schedule', requireRoles(...SALES_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ scheduledFor: z.string().datetime().nullable() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { tenantId, unitId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const order = await tx.order.findFirst({ where: { id: req.params.id, tenantId: tenantId!, ...(unitId ? { unitId } : {}) }, include: { items: { include: { product: { select: { prepTimeMinutes: true } } } } } });
      if (!order) return { status: 404, message: 'Order not found' } as const;
      if (!isHeldOrder(order) || order.status !== OrderStatus.OPEN) return { status: 409, message: 'Only held scheduled orders can be rescheduled' } as const;
      if (parsed.data.scheduledFor === null) { await releaseOrder(tx, order.id, tenantId!, userId); return { status: 200 } as const; }
      const settings = await loadSettings(tx, tenantId!);
      const prepMinutes = Math.max(0, ...order.items.map(item => item.product.prepTimeMinutes ?? 0));
      const decision = decideSchedule(new Date(parsed.data.scheduledFor), settings.scheduling, settings.hours.timezone, new Date(), prepMinutes);
      if (!decision.ok) return { status: 400, message: decision.reason } as const;
      await tx.order.update({ where: { id: order.id }, data: { scheduledFor: new Date(parsed.data.scheduledFor), releaseAt: decision.releaseAt } });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'ORDER_RESCHEDULED', entityType: 'Order', entityId: order.id, metadata: { scheduledFor: parsed.data.scheduledFor } } });
      if (decision.releaseNow) await releaseOrder(tx, order.id, tenantId!, userId);
      return { status: 200 } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json({ rescheduled: true });
  } catch (error) { return next(error); }
});
