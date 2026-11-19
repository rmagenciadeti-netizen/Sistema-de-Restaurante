import { OrderStatus, Prisma, PrintJobStatus } from '@prisma/client';
import { reverseOrderInventory, reverseOrderProductStock } from './order-inventory';
import { earnForOrder, reverseForOrder } from './loyalty';
import { loadSettings } from './settings';
import { brl, enqueueAutoMessage, orderLabel } from './whatsapp-auto';

type OrderForEffects = {
  id: string;
  tenantId: string;
  code: string;
  number?: number | null;
  total: Prisma.Decimal;
  customerId: string | null;
  couponId?: string | null;
  customer?: { phone: string; name: string } | null;
};

// Cross-module reactions to order status changes, executed in the same transaction as the status update.
export async function applyStatusSideEffects(tx: Prisma.TransactionClient, order: OrderForEffects, status: OrderStatus, actorUserId?: string) {
  const notice = { [OrderStatus.PREPARING]: 'order_preparing', [OrderStatus.READY]: 'order_ready', [OrderStatus.COMPLETED]: 'order_completed', [OrderStatus.CANCELLED]: 'order_cancelled' }[status as string];
  if (notice && order.customer) {
    // Payload keeps the Cloud API template keys (orderCode, customerName) next to the variables of the editable texts.
    await enqueueAutoMessage(tx, { tenantId: order.tenantId, key: notice, phone: order.customer.phone, orderId: order.id, vars: { orderCode: order.code, customerName: order.customer.name, nome: order.customer.name.split(' ')[0], pedido: orderLabel(order), total: brl(order.total) } });
  }
  if (status === OrderStatus.COMPLETED && order.customerId) {
    const config = (await loadSettings(tx, order.tenantId)).loyalty;
    await earnForOrder(tx, { id: order.id, tenantId: order.tenantId, customerId: order.customerId, total: order.total }, config);
  }
  if (status === OrderStatus.CANCELLED) {
    if (order.customerId) await reverseForOrder(tx, { id: order.id, tenantId: order.tenantId, customerId: order.customerId });
    if (actorUserId) {
      await reverseOrderInventory(tx, order, actorUserId);
      await reverseOrderProductStock(tx, order, actorUserId);
    }
    if (order.couponId) await tx.coupon.updateMany({ where: { id: order.couponId, tenantId: order.tenantId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
    await tx.printJob.updateMany({ where: { orderId: order.id, tenantId: order.tenantId, status: PrintJobStatus.PENDING }, data: { status: PrintJobStatus.CANCELLED } });
    await tx.financialEntry.updateMany({ where: { orderId: order.id, tenantId: order.tenantId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
  }
}
