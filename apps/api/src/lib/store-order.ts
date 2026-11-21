import { OrderChannel, Prisma, PrismaClient } from '@prisma/client';
import { serializable } from './serializable';
import { createOrder, OrderEngineError, type NewOrderInput } from './order-engine';
import { loadSettings } from './settings';
import { isStoreOpen } from './scheduling';

// A rule of the virtual store refused the order. `code` is the public message the store has always returned.
export class StoreOrderError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export type StoreOrderInput = {
  tenantId: string; unitId: string;
  fulfillment: 'DELIVERY' | 'TAKEAWAY';
  customer: { name: string; phone: string };
  address?: string; deliveryZoneId?: string; couponCode?: string; scheduledFor?: Date; notes?: string;
  paymentMethodId?: string; changeFor?: number; adultConfirmed?: boolean;
  items: NewOrderInput['items'];
  // Origin of the order (audit and delivery panel), idempotency key and whether the generic "order received" message is sent.
  origin?: { provider: string; label?: string; clientRequestId?: string; notifyCustomer?: boolean };
};

// The one place where a customer-made (not staff-made) delivery/takeaway order is validated and created: the public store and the WhatsApp attendant both use it,
// so opening hours, delivery rules, minimums, payment methods and stock are decided identically for every self-service channel.
export async function placeStoreOrder(db: PrismaClient, input: StoreOrderInput) {
  const { tenantId, unitId } = input;
  const now = new Date();
  const settings = await loadSettings(db, tenantId);
  if (settings.store.minorControl && input.adultConfirmed !== true) throw new StoreOrderError(400, 'AGE_CONFIRMATION_REQUIRED');
  const channel = input.fulfillment === 'DELIVERY' ? OrderChannel.DELIVERY : OrderChannel.TAKEAWAY;
  if ((channel === OrderChannel.DELIVERY && !settings.fulfillment.allowDelivery) || (channel === OrderChannel.TAKEAWAY && !settings.fulfillment.allowPickup)) throw new StoreOrderError(400, 'FULFILLMENT_NOT_ALLOWED');
  if (!input.scheduledFor && !settings.store.allowBuyWhenClosed && !isStoreOpen(settings.hours, now)) throw new StoreOrderError(409, 'STORE_CLOSED');
  if (channel === OrderChannel.DELIVERY && !input.address) throw new StoreOrderError(400, 'ADDRESS_REQUIRED');
  if (channel === OrderChannel.TAKEAWAY && input.deliveryZoneId) throw new StoreOrderError(400, 'DELIVERY_ZONE_ONLY_FOR_DELIVERY');
  // Venue-only products and components are not on the online menu, so they cannot be ordered through it either.
  if (await db.product.count({ where: { tenantId, id: { in: input.items.map(item => item.productId) }, OR: [{ localOnly: true }, { isComponent: true }] } }) > 0) throw new StoreOrderError(400, 'PRODUCTS_UNAVAILABLE');

  let deliveryFeeOverride: Prisma.Decimal | undefined;
  if (channel === OrderChannel.DELIVERY && !input.deliveryZoneId) {
    const { deliveryFeeMode, singleFee } = settings.fulfillment;
    if (deliveryFeeMode === 'SINGLE' || deliveryFeeMode === 'UNMAPPED') deliveryFeeOverride = new Prisma.Decimal(singleFee);
    else if (await db.deliveryZone.count({ where: { tenantId, active: true, OR: [{ unitId }, { unitId: null }] } }) > 0) throw new StoreOrderError(400, 'DELIVERY_ZONE_REQUIRED');
  }
  const method = input.paymentMethodId ? await db.paymentMethodConfig.findFirst({ where: { id: input.paymentMethodId, tenantId, active: true, showStore: true }, select: { name: true, equivalent: true } }) : null;
  if (input.paymentMethodId && !method) throw new StoreOrderError(400, 'PAYMENT_METHOD_UNAVAILABLE');

  // Free text has no field on Order, so the customer's remark travels on the first item (visible to the kitchen).
  const items = input.items.map((item, index) => (index === 0 && input.notes ? { ...item, notes: [item.notes, `Obs.: ${input.notes}`].filter(Boolean).join(' | ').slice(0, 500) } : item));
  const { minDelivery, freeDeliveryMin } = settings.fulfillment;
  const origin = input.origin ?? { provider: 'LOJA_VIRTUAL' };
  return serializable(db, async tx => {
    const created = await createOrder(tx, {
      tenantId, unitId, channel, items, couponCode: input.couponCode, deliveryZoneId: input.deliveryZoneId, deliveryFeeOverride,
      customer: { name: input.customer.name, phone: input.customer.phone, untrusted: true }, scheduledFor: input.scheduledFor,
      ...(origin.clientRequestId ? { clientRequestId: origin.clientRequestId } : {}), ...(origin.notifyCustomer === false ? { notifyCustomer: false } : {}),
    });
    let { total, deliveryFee } = created;
    if (channel === OrderChannel.DELIVERY) {
      const goods = created.subtotal.sub(created.discount);
      if (minDelivery > 0 && goods.lt(minDelivery)) throw new OrderEngineError('BELOW_DELIVERY_MINIMUM');
      if (freeDeliveryMin > 0 && deliveryFee.gt(0) && goods.gte(freeDeliveryMin)) {
        total = total.sub(deliveryFee); deliveryFee = new Prisma.Decimal(0);
        await tx.order.update({ where: { id: created.id }, data: { deliveryFee, total } });
      }
      await tx.deliveryJob.create({ data: { tenantId, unitId, orderId: created.id, address: input.address, provider: origin.provider } });
    }
    await tx.auditLog.create({
      data: {
        tenantId, action: 'STORE_ORDER_DETAILS', entityType: 'Order', entityId: created.id,
        metadata: { fulfillment: input.fulfillment, address: input.address ?? null, notes: input.notes ?? null, payment: method ? { name: method.name, equivalent: method.equivalent, changeFor: input.changeFor ?? null } : null, autoAccept: settings.store.autoAccept, adultConfirmed: settings.store.minorControl ? input.adultConfirmed === true : null, ...(origin.label ? { origin: origin.label } : {}) },
      },
    });
    return { ...created, total, deliveryFee, autoAccept: settings.store.autoAccept };
  });
}
