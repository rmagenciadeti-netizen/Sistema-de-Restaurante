import { OrderStatus, Prisma, PrintJobStatus } from '@prisma/client';
import { reverseOrderInventory } from './order-inventory';

type OrderForEffects = {
  id: string;
  tenantId: string;
  code: string;
  total: Prisma.Decimal;
  customerId: string | null;
  couponId?: string | null;
  customer?: { phone: string; name: string } | null;
};

// Cross-module reactions to order status changes, executed in the same transaction as the status update.
export async function applyStatusSideEffects(tx: Prisma.TransactionClient, order: OrderForEffects, status: OrderStatus, actorUserId?: string) {
  if (status === OrderStatus.READY && order.customer) {
    await tx.whatsappMessage.create({ data: { tenantId: order.tenantId, orderId: order.id, toPhone: order.customer.phone, template: 'order_ready', payload: { orderCode: order.code, customerName: order.customer.name } } });
  }
  if (status === OrderStatus.COMPLETED && order.customerId) {
    const points = order.total.floor().toNumber();
    if (points > 0) await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: points } } });
  }
  if (status === OrderStatus.CANCELLED) {
    if (actorUserId) await reverseOrderInventory(tx, order, actorUserId);
    if (order.couponId) await tx.coupon.updateMany({ where: { id: order.couponId, tenantId: order.tenantId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
    await tx.printJob.updateMany({ where: { orderId: order.id, tenantId: order.tenantId, status: PrintJobStatus.PENDING }, data: { status: PrintJobStatus.CANCELLED } });
  }
}
