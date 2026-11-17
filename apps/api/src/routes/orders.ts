import { Router } from 'express';
import { FinancialEntryType, FiscalKind, FiscalStatus, OrderChannel, OrderStatus, PaymentMethod, PaymentStatus, Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { applyStatusSideEffects } from '../lib/order-effects';
import { canTransitionOrder, consumeOrderInventory, OrderInventoryError } from '../lib/order-inventory';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { createOrder, OrderEngineError } from '../lib/order-engine';
import { editOrder } from '../lib/order-edit';
import { decideSchedule, isHeldOrder, releaseDueOrders, releaseOrder } from '../lib/scheduling';
import { loadSettings } from '../lib/settings';
import { positiveQuantitySchema } from '../lib/money';
import { ALL_TENANT_ROLES, CASH_ROLES, MANAGEMENT_ROLES, requireRoles, PRODUCTION_ROLES, SALES_ROLES } from '../lib/permissions';

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
  sellerId: z.string().uuid().optional(),
  orderReleaseId: z.string().uuid().optional(),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: positiveQuantitySchema(999), weightKg: z.number().positive().max(999.999).optional(), unitPrice: z.number().min(0).max(9_999_999_999.99).refine(value => new Prisma.Decimal(value).decimalPlaces() <= 2, 'Use no máximo duas casas decimais').optional(), withPackaging: z.boolean().optional(), notes: z.string().max(500).optional(), modifiers: z.array(z.object({ optionId: z.string().uuid(), quantity: z.number().int().positive().max(20).optional() })).max(30).optional() })).min(1).max(100),
});
const editSchema = z.object({
  customerName: z.string().max(160).nullable().optional(),
  customerPhone: z.string().max(30).nullable().optional(),
  tableLabel: z.string().max(30).nullable().optional(),
  address: z.string().max(500).nullable().optional(),
  deliveryZoneId: z.string().uuid().nullable().optional(),
  deliveryFee: z.number().min(0).max(9_999_999).optional(),
  discount: z.number().min(0).max(9_999_999).optional(),
  serviceFee: z.number().min(0).max(9_999_999).optional(),
  items: createSchema.shape.items.optional(),
  payments: z.array(z.object({ id: z.string().uuid(), method: z.nativeEnum(PaymentMethod) })).max(20).optional(),
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to update' });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().max(80).optional(), channel: z.nativeEnum(OrderChannel).optional(), status: z.nativeEnum(OrderStatus).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  scope: z.enum(['all', 'active', 'scheduled', 'held']).default('all'),
  type: z.enum(['delivery', 'pickup']).optional(),
  table: z.enum(['1']).optional(),
});
const orderListInclude = { items: { include: { product: true, modifiers: true } }, customer: { select: { id: true, name: true, phone: true } }, financialEntry: { select: { id: true, debtorName: true, amount: true, paidAmount: true, dueAt: true, status: true } }, payments: { where: { status: PaymentStatus.CONFIRMED }, select: { id: true, amount: true, method: true } }, deliveryJob: { select: { id: true, status: true, courierId: true, courierName: true, courierPhone: true, address: true, dispatchedAt: true } }, deliveryZone: { select: { id: true, name: true } }, fiscalDocuments: { where: { kind: FiscalKind.NFCE, status: { in: [FiscalStatus.PENDING, FiscalStatus.AUTHORIZED] } }, select: { id: true, status: true, series: true, number: true, documentUrl: true } } } satisfies Prisma.OrderInclude;
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
    const [items, total] = await Promise.all([prisma.order.findMany({ where, include: orderListInclude, orderBy: scheduleView ? { scheduledFor: 'asc' } : { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.order.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
// Staff that can be chosen as seller in the PDV (option "Solicitar vendedor"); name and role only.
orderRoutes.get('/sellers', requireRoles(...SALES_ROLES), async (req, res, next) => {
  try {
    const unitId = req.auth!.unitId;
    const items = await prisma.user.findMany({ where: { tenantId: req.auth!.tenantId!, status: 'ACTIVE', role: { in: SALES_ROLES }, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' }, take: 200 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
orderRoutes.post('/', requireRoles(...SALES_ROLES), async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (parsed.data.unitId && req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    if (parsed.data.customerPhone && !parsed.data.customerName) return res.status(400).json({ message: 'customerName is required with customerPhone' });
    const { customerName, customerPhone, marketingConsent, scheduledFor, adjustmentReleaseId, sellerId, orderReleaseId, ...rest } = parsed.data;
    // The seller (PDV option "Solicitar vendedor") receives the sale in reports and prints; it must be an active staff member of this tenant (and unit, when scoped).
    if (sellerId && !await prisma.user.findFirst({ where: { id: sellerId, tenantId, status: 'ACTIVE', role: { in: SALES_ROLES }, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) }, select: { id: true } })) return res.status(400).json({ message: 'SELLER_INVALID' });
    // Staff outside management need a fresh administrator-password release (POST /releases, action DISCOUNT) to grant a manual discount.
    if (rest.adjustment?.mode === 'DISCOUNT' && req.auth!.role !== UserRole.ADMIN && req.auth!.role !== UserRole.MANAGER) {
      const release = adjustmentReleaseId ? await prisma.passwordRelease.findFirst({ where: { id: adjustmentReleaseId, tenantId, action: 'DISCOUNT', requestedByUserId: req.auth!.userId, createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) } } }) : null;
      if (!release) return res.status(403).json({ message: 'DISCOUNT_RELEASE_REQUIRED' });
    }
    const order = await serializable(prisma, async tx => {
      const settings = await loadSettings(tx, tenantId);
      const needsRelease = settings.pdv.requireAdminPasswordOnline
        && (rest.channel === OrderChannel.TABLE || Boolean(rest.tableId || rest.tableLabel))
        && !MANAGEMENT_ROLES.includes(req.auth!.role);
      const release = needsRelease && orderReleaseId ? await tx.passwordRelease.findFirst({
        where: { id: orderReleaseId, tenantId, action: 'OTHER', orderId: null, requestedByUserId: req.auth!.userId, reason: 'PDV_TABLE_ORDER', createdAt: { gte: new Date(Date.now() - 15 * 60 * 1000) } },
        select: { id: true },
      }) : null;
      if (needsRelease && !release) throw new OrderEngineError('ORDER_RELEASE_REQUIRED', 403);
      const created = await createOrder(tx, {
        ...rest, initialStatus: rest.channel === OrderChannel.POS ? settings.pdv.defaultOrderStatus : undefined,
        scheduledFor: scheduledFor ? new Date(scheduledFor) : undefined, tenantId, unitId, actorUserId: sellerId ?? req.auth!.userId,
        notifyCustomer: settings.pdv.whatsappNotify,
        customer: customerName ? { name: customerName, phone: customerPhone, marketingConsent } : undefined,
      });
      if (release) {
        const claimed = await tx.passwordRelease.updateMany({ where: { id: release.id, orderId: null }, data: { orderId: created.id } });
        if (claimed.count !== 1) throw new OrderEngineError('ORDER_RELEASE_INVALID', 409);
      }
      return created;
    });
    return res.status(201).json(order);
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason === 'FREE_PRICE_NOT_ALLOWED' ? 'Este produto não permite preço livre neste canal.' : error.reason === 'FREE_PRICE_INVALID' ? 'O preço livre informado é inválido.' : error.reason === 'FRACTIONAL_QUANTITY_NOT_ALLOWED' ? 'Este produto não permite quantidade fracionada.' : error.reason === 'PACKAGING_NOT_ALLOWED' ? 'Este produto não permite embalagem.' : error.reason });
    if (error instanceof OrderInventoryError) return res.status(409).json({ message: error.reason === 'INSUFFICIENT_STOCK' ? 'Insufficient stock for this order' : error.reason === 'INVALID_PRODUCT_STOCK' ? 'Product stock is invalid or outside this unit' : 'Order recipe contains invalid or out-of-scope ingredients' });
    return next(error);
  }
});
orderRoutes.post('/:id/promissory', requireRoles(...CASH_ROLES), async (req, res, next) => {
  try {
    const parsed = z.object({ dueAt: z.string().datetime({ offset: true }), debtorName: z.string().trim().min(2).max(160).optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Informe o vencimento e um nome válido para a promissória.' });
    const { tenantId, unitId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const settings = await loadSettings(tx, tenantId!);
      const order = await tx.order.findFirst({
        where: { id: req.params.id, tenantId: tenantId!, ...(unitId ? { unitId } : {}) },
        include: { customer: { select: { id: true, name: true } }, payments: { where: { status: PaymentStatus.CONFIRMED }, select: { amount: true } } },
      });
      if (!order) return { status: 404 as const, message: 'Pedido não encontrado.' };
      if (order.status === OrderStatus.CANCELLED) return { status: 409 as const, message: 'Não é possível gerar promissória para pedido cancelado.' };
      if (await tx.financialEntry.findUnique({ where: { orderId: order.id }, select: { id: true } })) return { status: 409 as const, message: 'Este pedido já possui uma promissória.' };
      const paid = order.payments.reduce((sum, payment) => sum.add(payment.amount), new Prisma.Decimal(0));
      const amount = order.total.sub(paid).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (!amount.gt(0)) return { status: 409 as const, message: 'O pedido não possui saldo em aberto.' };
      const debtorName = parsed.data.debtorName ?? order.customer?.name ?? order.customerName?.trim();
      if (!debtorName) return { status: 400 as const, message: 'Informe o nome do responsável pela dívida.' };
      const entry = await tx.financialEntry.create({
        data: {
          tenantId: tenantId!, unitId: order.unitId, orderId: order.id, customerId: order.customerId, debtorName,
          description: `Promissória do pedido ${order.number ? `#${order.number}` : order.code}`, type: FinancialEntryType.INCOME,
          category: 'Vendas a prazo', amount, dueAt: new Date(parsed.data.dueAt), reference: order.code,
        },
      });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'ORDER_PROMISSORY_CREATED', entityType: 'FinancialEntry', entityId: entry.id, metadata: { orderId: order.id, amount: amount.toFixed(2), dueAt: entry.dueAt?.toISOString() } } });
      return { status: 201 as const, entry, order: { id: order.id, code: order.code, number: order.number }, autoPrintPromissory: settings.printing.autoPrintPromissory, promissoryPaper: settings.printing.promissoryPaper };
    });
    if (result.status !== 201) return res.status(result.status).json({ message: result.message });
    return res.status(201).json({ ...result.entry, order: result.order, autoPrintPromissory: result.autoPrintPromissory, promissoryPaper: result.promissoryPaper });
  } catch (error) { return next(error); }
});
// Full edit of an order in progress (items, address, fees, discount, customer, payment method); see lib/order-edit.ts.
orderRoutes.patch('/:id', requireRoles(...MANAGEMENT_ROLES, UserRole.CASHIER), async (req, res, next) => {
  try {
    const parsed = editSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { tenantId, unitId, userId, role } = req.auth!;
    await serializable(prisma, tx => editOrder(tx, { orderId: req.params.id, tenantId: tenantId!, unitId, actorUserId: userId, role }, parsed.data));
    return res.json(await prisma.order.findUniqueOrThrow({ where: { id: req.params.id }, include: orderListInclude }));
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason === 'FREE_PRICE_NOT_ALLOWED' ? 'Este produto não permite preço livre neste canal.' : error.reason === 'FREE_PRICE_INVALID' ? 'O preço livre informado é inválido.' : error.reason === 'FRACTIONAL_QUANTITY_NOT_ALLOWED' ? 'Este produto não permite quantidade fracionada.' : error.reason === 'PACKAGING_NOT_ALLOWED' ? 'Este produto não permite embalagem.' : error.reason });
    if (error instanceof OrderInventoryError) return res.status(409).json({ message: error.reason === 'INSUFFICIENT_STOCK' ? 'Insufficient stock for this order' : error.reason === 'INVALID_PRODUCT_STOCK' ? 'Product stock is invalid or outside this unit' : 'Order recipe contains invalid or out-of-scope ingredients' });
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
      const message = error.reason === 'INSUFFICIENT_STOCK' ? 'Insufficient stock for this order' : error.reason === 'INVALID_PRODUCT_STOCK' ? 'Product stock is invalid or outside this unit' : 'Order recipe contains invalid or out-of-scope ingredients';
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
