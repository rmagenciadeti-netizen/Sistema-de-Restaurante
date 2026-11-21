import { OrderChannel, OrderItemStatus, OrderStatus, PaymentMethod, PaymentStatus, Prisma, PrintJobKind, PrintJobStatus, UserRole } from '@prisma/client';
import { insertOrderLines, normalizePhone, OrderEngineError, priceOrderLines, type NewOrderInput } from './order-engine';
import { consumeOrderInventory, consumeOrderProductStock, reverseOrderInventory, reverseOrderProductStock } from './order-inventory';
import { enqueueProductionPrints } from './print-queue';
import { ORDER_INCLUDE } from './order-engine-shared';
import { isHeldOrder } from './scheduling';

export type OrderEditInput = {
  customerName?: string | null;
  customerPhone?: string | null;
  tableLabel?: string | null;
  address?: string | null;
  deliveryZoneId?: string | null;
  deliveryFee?: number;
  discount?: number;
  serviceFee?: number;
  items?: NewOrderInput['items'];
  payments?: Array<{ id: string; method: PaymentMethod }>;
};

const round2 = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const ITEM_STATUS_AFTER_EDIT: Partial<Record<OrderStatus, OrderItemStatus>> = { [OrderStatus.READY]: OrderItemStatus.READY };

// Full manual control over an order that is still in progress: customer, address, delivery fee, items, discounts and the
// payment method of registered payments. Totals are recomputed here so the order, the KDS, the stock and the cash book stay consistent.
// `actorUserId` null = a system actor (the WhatsApp attendant); it never changes discounts, which need a manager.
export async function editOrder(tx: Prisma.TransactionClient, scope: { orderId: string; tenantId: string; unitId: string | null; actorUserId: string | null; role?: UserRole }, input: OrderEditInput) {
  const { orderId, tenantId, unitId, actorUserId, role } = scope;
  const order = await tx.order.findFirst({
    where: { id: orderId, tenantId, ...(unitId ? { unitId } : {}) },
    include: {
      deliveryJob: true,
      payments: { where: { status: PaymentStatus.CONFIRMED } },
    },
  });
  if (!order) throw new OrderEngineError('ORDER_NOT_FOUND', 404);
  if (order.status === OrderStatus.CANCELLED || order.status === OrderStatus.COMPLETED) throw new OrderEngineError('ORDER_CLOSED', 409);
  const changed: string[] = [];
  const now = new Date();

  const data: Prisma.OrderUncheckedUpdateInput = {};
  if (input.customerName !== undefined) { data.customerName = input.customerName?.trim() || null; changed.push('customerName'); }
  if (input.tableLabel !== undefined) { data.tableLabel = input.tableLabel?.trim() || null; changed.push('tableLabel'); }
  if (input.customerPhone !== undefined) {
    const phone = input.customerPhone ? normalizePhone(input.customerPhone) : null;
    if (input.customerPhone && !phone) throw new OrderEngineError('INVALID_PHONE');
    if (phone) {
      const name = (input.customerName?.trim() || order.customerName || '').trim();
      if (!name) throw new OrderEngineError('CUSTOMER_NAME_REQUIRED');
      const customer = await tx.customer.upsert({ where: { tenantId_phone: { tenantId, phone } }, create: { tenantId, phone, name }, update: {} });
      data.customerId = customer.id; data.customerName = customer.name;
    } else data.customerId = null;
    changed.push('customerPhone');
  }

  let subtotal = order.subtotal;
  const itemsChanged = input.items !== undefined;
  const priced = itemsChanged ? await priceOrderLines(tx, { tenantId, unitId: order.unitId, channel: order.channel }, input.items!, now) : null;
  if (priced) { subtotal = priced.subtotal; changed.push('items'); }

  let discount = order.discount;
  if (input.discount !== undefined) {
    if (!new Prisma.Decimal(input.discount).equals(order.discount) && role !== UserRole.ADMIN && role !== UserRole.MANAGER) throw new OrderEngineError('DISCOUNT_RELEASE_REQUIRED', 403);
    discount = new Prisma.Decimal(input.discount); changed.push('discount');
  }
  if (discount.gt(subtotal)) throw new OrderEngineError('DISCOUNT_EXCEEDS_TOTAL');

  let serviceFee = order.serviceFee;
  if (input.serviceFee !== undefined) { serviceFee = new Prisma.Decimal(input.serviceFee); changed.push('serviceFee'); }
  else if (priced && serviceFee.gt(0) && order.unitId) {
    const unit = await tx.unit.findFirst({ where: { id: order.unitId, tenantId }, select: { serviceFeePercent: true } });
    if (unit) serviceFee = round2(subtotal.sub(discount).mul(unit.serviceFeePercent).div(100));
  }

  let deliveryFee = order.deliveryFee;
  if (input.deliveryZoneId !== undefined || input.deliveryFee !== undefined || input.address !== undefined) {
    if (order.channel !== OrderChannel.DELIVERY) throw new OrderEngineError('DELIVERY_ONLY');
  }
  if (input.deliveryZoneId !== undefined) {
    if (input.deliveryZoneId === null) { data.deliveryZoneId = null; deliveryFee = new Prisma.Decimal(0); }
    else {
      const zone = await tx.deliveryZone.findFirst({ where: { id: input.deliveryZoneId, tenantId, active: true, ...(order.unitId ? { OR: [{ unitId: order.unitId }, { unitId: null }] } : {}) } });
      if (!zone) throw new OrderEngineError('DELIVERY_ZONE_UNAVAILABLE');
      if (zone.minOrder && subtotal.sub(discount).lt(zone.minOrder)) throw new OrderEngineError('BELOW_DELIVERY_MINIMUM');
      data.deliveryZoneId = zone.id; deliveryFee = zone.fee;
    }
    changed.push('deliveryZone');
  }
  if (input.deliveryFee !== undefined) { deliveryFee = new Prisma.Decimal(input.deliveryFee); changed.push('deliveryFee'); }

  const total = subtotal.sub(discount).add(serviceFee).add(deliveryFee).add(order.couvertFee);
  if (total.lt(0)) throw new OrderEngineError('DISCOUNT_EXCEEDS_TOTAL');
  const paid = order.payments.reduce((sum, payment) => sum.add(payment.amount), new Prisma.Decimal(0));
  if (paid.gt(total)) throw new OrderEngineError('PAYMENTS_EXCEED_TOTAL', 409);
  Object.assign(data, { subtotal, discount, serviceFee, deliveryFee, total });

  for (const change of input.payments ?? []) {
    const payment = order.payments.find(candidate => candidate.id === change.id);
    if (!payment) throw new OrderEngineError('PAYMENT_NOT_FOUND', 404);
    if (payment.method !== change.method) {
      await tx.payment.update({ where: { id: payment.id }, data: { method: change.method } });
      await tx.auditLog.create({ data: { tenantId, actorUserId, action: 'PAYMENT_METHOD_CHANGED', entityType: 'Payment', entityId: payment.id, metadata: { orderId, from: payment.method, to: change.method } } });
      changed.push('payments');
    }
  }

  if (input.address !== undefined) {
    const address = input.address?.trim() || null;
    if (order.deliveryJob) await tx.deliveryJob.update({ where: { id: order.deliveryJob.id }, data: { address } });
    else await tx.deliveryJob.create({ data: { tenantId, unitId: order.unitId, orderId, address } });
    changed.push('address');
  }

  await tx.order.update({ where: { id: orderId }, data });
  const promissory = await tx.financialEntry.findUnique({ where: { orderId } });
  if (promissory && promissory.status !== 'CANCELLED') {
    const paidBeforePromissory = order.payments.filter(payment => payment.paidAt < promissory.createdAt).reduce((sum, payment) => sum.add(payment.amount), new Prisma.Decimal(0));
    const paidAfterPromissory = order.payments.filter(payment => payment.paidAt >= promissory.createdAt).reduce((sum, payment) => sum.add(payment.amount), new Prisma.Decimal(0));
    const amount = Prisma.Decimal.max(total.sub(paidBeforePromissory), new Prisma.Decimal(0));
    const paidAmount = Prisma.Decimal.min(paidAfterPromissory, amount);
    const settled = paidAmount.gte(amount);
    await tx.financialEntry.update({ where: { id: promissory.id }, data: { amount, paidAmount, status: settled ? 'PAID' : 'OPEN', settledAt: settled ? promissory.settledAt ?? new Date() : null } });
  }

  if (priced) {
    // Restore prior reservations and recipe consumption before replacing order items.
    const consumed = order.status === OrderStatus.PREPARING || order.status === OrderStatus.READY;
    await reverseOrderProductStock(tx, order, actorUserId);
    if (consumed) await reverseOrderInventory(tx, order, actorUserId);
    await tx.orderItem.deleteMany({ where: { orderId } });
    await insertOrderLines(tx, orderId, priced.lines);
    const afterStatus = ITEM_STATUS_AFTER_EDIT[order.status];
    if (afterStatus) await tx.orderItem.updateMany({ where: { orderId }, data: { status: afterStatus } });
    const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: { include: { modifiers: true, product: { include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } } } } } } });
    await consumeOrderProductStock(tx, fresh, actorUserId);
    if (consumed) await consumeOrderInventory(tx, fresh, actorUserId);
    if (!isHeldOrder(order)) {
      await tx.printJob.updateMany({ where: { orderId, tenantId, kind: PrintJobKind.PRODUCTION, status: PrintJobStatus.PENDING }, data: { status: PrintJobStatus.CANCELLED } });
      const printable = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
      await enqueueProductionPrints(tx, printable, { onlyAutoPrint: true });
    }
  }

  await tx.auditLog.create({ data: { tenantId, actorUserId, action: 'ORDER_EDITED', entityType: 'Order', entityId: orderId, metadata: { fields: [...new Set(changed)], total: total.toFixed(2), freePriceItems: input.items?.filter(item => item.unitPrice !== undefined).map(item => ({ productId: item.productId, unitPrice: item.unitPrice })) ?? [] } } });
}
