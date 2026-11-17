import { DiscountType, OrderChannel, OrderStatus, Prisma } from '@prisma/client';
import { randomInt } from 'node:crypto';
import { enqueueProductionPrints } from './print-queue';
import { ORDER_INCLUDE } from './order-engine-shared';
import { decideSchedule } from './scheduling';
import { loadSettings, nextOrderNumber } from './settings';
import { effectiveUnitPrice } from './promotions';
import { brl, enqueueAutoMessage, orderLabel, scheduledSuffix } from './whatsapp-auto';

export class OrderEngineError extends Error {
  constructor(readonly reason: string, readonly httpStatus = 400) { super(reason); }
}

export type NewOrderInput = {
  tenantId: string;
  unitId: string | null;
  actorUserId?: string | null;
  channel: OrderChannel;
  items: Array<{ productId: string; quantity: number; weightKg?: number; notes?: string; modifiers?: Array<{ optionId: string; quantity?: number }> }>;
  // untrusted (anonymous QR-code) callers can create customers but never modify an existing customer record.
  customer?: { name: string; phone?: string; marketingConsent?: boolean; untrusted?: boolean };
  tableId?: string;
  tableLabel?: string;
  couponCode?: string;
  deliveryZoneId?: string;
  applyServiceFee?: boolean;
  // Only for trusted server-side integrations (marketplace orders) whose delivery fee is set by the platform.
  deliveryFeeOverride?: Prisma.Decimal;
  // Future date/time: the order is accepted now but only reaches production at `releaseAt` (see scheduling.ts).
  scheduledFor?: Date;
  // Number of guests charged with the artistic cover of the active event (table orders only).
  couvertPeople?: number;
  // Marketplace/anonymous-table orders come with third-party contacts, so they must not trigger WhatsApp notices.
  notifyCustomer?: boolean;
  // Counter adjustment on top of the coupon: a discount lowers and a surcharge raises the amount owed (stored as a negative discount).
  adjustment?: { mode: 'DISCOUNT' | 'SURCHARGE'; type: 'FIXED' | 'PERCENT'; value: number };
};

export function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

const round2 = (value: Prisma.Decimal) => value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export function computeDiscount(coupon: { type: DiscountType; value: Prisma.Decimal }, base: Prisma.Decimal): Prisma.Decimal {
  const raw = coupon.type === DiscountType.PERCENT ? base.mul(coupon.value).div(100) : coupon.value;
  const discount = round2(raw);
  return discount.gt(base) ? base : discount;
}

export function newOrderCode(): string {
  return `P-${Date.now().toString(36).toUpperCase()}${randomInt(36 * 36).toString(36).toUpperCase().padStart(2, '0')}`;
}

export { ORDER_INCLUDE };

// Single entry point used by POS, waiter, QR-code table menu and every other sales channel.
export async function createOrder(tx: Prisma.TransactionClient, input: NewOrderInput) {
  const { tenantId, unitId } = input;
  const ids = [...new Set(input.items.map(item => item.productId))];
  const products = await tx.product.findMany({
    where: { id: { in: ids }, tenantId, active: true, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) },
    include: { modifierGroups: { include: { group: { include: { options: true } } } }, comboComponents: { include: { product: true } } },
  });
  if (products.length !== ids.length) throw new OrderEngineError('PRODUCTS_UNAVAILABLE');
  const byId = new Map(products.map(product => [product.id, product]));
  const now = new Date();
  const promotionRows = await tx.promotion.findMany({
    where: { tenantId, active: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gte: now } }], products: { some: { productId: { in: ids } } } },
    include: { products: { select: { productId: true } } },
  });
  const promotions = promotionRows.map(row => ({ type: row.type, value: row.value, startsAt: row.startsAt, endsAt: row.endsAt, active: row.active, productIds: row.products.map(link => link.productId) }));
  const lines = input.items.map(line => {
    const product = byId.get(line.productId)!;
    // Weighed products are sold by the kilo: price is per kg and the line must carry the weighed amount.
    if (product.soldByWeight) {
      if (product.isCombo || !line.weightKg || !(line.weightKg > 0) || line.weightKg > 999.999) throw new OrderEngineError('WEIGHT_REQUIRED');
    } else if (line.weightKg !== undefined) throw new OrderEngineError('WEIGHT_NOT_ALLOWED');
    const weightKg = line.weightKg === undefined ? null : new Prisma.Decimal(line.weightKg).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
    if (weightKg && !weightKg.gt(0)) throw new OrderEngineError('WEIGHT_REQUIRED');
    const unitPrice = effectiveUnitPrice(product.id, product.price, promotions, now);
    const groups = product.modifierGroups.map(link => link.group).filter(group => group.active);
    const chosen = new Map<string, number>();
    const selected = (line.modifiers ?? []).map(entry => {
      const group = groups.find(candidate => candidate.options.some(option => option.id === entry.optionId && option.active));
      if (!group) throw new OrderEngineError('MODIFIER_UNAVAILABLE');
      const quantity = entry.quantity ?? 1;
      chosen.set(group.id, (chosen.get(group.id) ?? 0) + quantity);
      return { option: group.options.find(option => option.id === entry.optionId)!, quantity };
    });
    for (const group of groups) {
      const count = chosen.get(group.id) ?? 0;
      if (count < group.minSelect || count > group.maxSelect) throw new OrderEngineError('MODIFIER_SELECTION_INVALID');
    }
    if (product.isCombo) {
      if (product.comboComponents.length === 0 || product.comboComponents.some(component => !component.product.active || component.product.tenantId !== tenantId)) throw new OrderEngineError('COMBO_UNAVAILABLE');
    }
    const modifiersPerUnit = selected.reduce((sum, entry) => sum.add(entry.option.price.mul(entry.quantity)), new Prisma.Decimal(0));
    const baseTotal = weightKg ? round2(unitPrice.mul(weightKg)) : unitPrice;
    return { ...line, product, selected, weightKg, unitPrice, total: baseTotal.add(modifiersPerUnit).mul(line.quantity) };
  });
  const subtotal = lines.reduce((sum, line) => sum.add(line.total), new Prisma.Decimal(0));

  let tableLabel = input.tableLabel ?? null;
  let tableId: string | null = null;
  if (input.tableId) {
    const table = await tx.restaurantTable.findFirst({ where: { id: input.tableId, tenantId, active: true, ...(unitId ? { unitId } : {}) } });
    if (!table) throw new OrderEngineError('TABLE_UNAVAILABLE');
    tableId = table.id;
    tableLabel = table.label;
  }

  let customerId: string | null = null;
  let customerPhone: string | null = null;
  let customerName = input.customer?.name ?? null;
  if (input.customer?.phone) {
    const phone = normalizePhone(input.customer.phone);
    if (!phone) throw new OrderEngineError('INVALID_PHONE');
    const customer = await tx.customer.upsert({
      where: { tenantId_phone: { tenantId, phone } },
      create: { tenantId, phone, name: input.customer.name, marketingConsent: input.customer.marketingConsent ?? false },
      update: input.customer.untrusted ? {} : { name: input.customer.name, ...(input.customer.marketingConsent !== undefined ? { marketingConsent: input.customer.marketingConsent } : {}) },
    });
    customerId = customer.id;
    customerName = customer.name;
    customerPhone = phone;
  }

  let discount = new Prisma.Decimal(0);
  let couponId: string | null = null;
  if (input.couponCode) {
    const now = new Date();
    const coupon = await tx.coupon.findFirst({ where: { tenantId, code: input.couponCode.trim().toUpperCase(), active: true } });
    const valid = coupon
      && (!coupon.validFrom || coupon.validFrom <= now)
      && (!coupon.validUntil || coupon.validUntil >= now)
      && (!coupon.minOrder || subtotal.gte(coupon.minOrder))
      && (coupon.maxUses === null || coupon.usedCount < coupon.maxUses);
    if (!coupon || !valid) throw new OrderEngineError('COUPON_UNAVAILABLE');
    const claimed = await tx.coupon.updateMany({ where: { id: coupon.id, usedCount: coupon.usedCount }, data: { usedCount: { increment: 1 } } });
    if (claimed.count !== 1) throw new OrderEngineError('COUPON_UNAVAILABLE', 409);
    couponId = coupon.id;
    discount = computeDiscount(coupon, subtotal);
  }

  let adjustmentDiscount = new Prisma.Decimal(0);
  if (input.adjustment) {
    const base = subtotal.sub(discount);
    const raw = input.adjustment.type === 'PERCENT' ? base.mul(input.adjustment.value).div(100) : new Prisma.Decimal(input.adjustment.value);
    const amount = round2(raw);
    if (input.adjustment.mode === 'DISCOUNT') {
      if (amount.gt(base)) throw new OrderEngineError('DISCOUNT_EXCEEDS_TOTAL');
      adjustmentDiscount = amount;
    } else adjustmentDiscount = amount.neg();
    discount = discount.add(adjustmentDiscount);
  }

  let serviceFee = new Prisma.Decimal(0);
  if (unitId && (input.channel === OrderChannel.TABLE || tableId) && input.applyServiceFee !== false) {
    const unit = await tx.unit.findFirst({ where: { id: unitId, tenantId }, select: { serviceFeePercent: true } });
    if (!unit) throw new OrderEngineError('UNIT_UNAVAILABLE');
    serviceFee = round2(subtotal.sub(discount).add(adjustmentDiscount.lt(0) ? adjustmentDiscount.neg() : 0).mul(unit.serviceFeePercent).div(100));
  }

  let deliveryFee = new Prisma.Decimal(0);
  let deliveryZoneId: string | null = null;
  if (input.deliveryZoneId) {
    if (input.channel !== OrderChannel.DELIVERY) throw new OrderEngineError('DELIVERY_ZONE_ONLY_FOR_DELIVERY');
    const zone = await tx.deliveryZone.findFirst({ where: { id: input.deliveryZoneId, tenantId, active: true, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) } });
    if (!zone) throw new OrderEngineError('DELIVERY_ZONE_UNAVAILABLE');
    if (zone.minOrder && subtotal.sub(discount).lt(zone.minOrder)) throw new OrderEngineError('BELOW_DELIVERY_MINIMUM');
    deliveryFee = zone.fee;
    deliveryZoneId = zone.id;
  }

  if (input.deliveryFeeOverride) {
    if (input.channel !== OrderChannel.DELIVERY) throw new OrderEngineError('DELIVERY_ZONE_ONLY_FOR_DELIVERY');
    deliveryFee = input.deliveryFeeOverride;
  }

  let couvertFee = new Prisma.Decimal(0);
  if (input.couvertPeople) {
    if (input.channel !== OrderChannel.TABLE && !tableId) throw new OrderEngineError('COUVERT_ONLY_FOR_TABLE');
    const event = await tx.coverEvent.findFirst({ where: { tenantId, active: true, startsAt: { lte: now }, endsAt: { gte: now }, ...(unitId ? { OR: [{ unitId }, { unitId: null }] } : {}) }, orderBy: { startsAt: 'desc' } });
    if (!event) throw new OrderEngineError('COUVERT_UNAVAILABLE');
    couvertFee = round2(event.amount.mul(input.couvertPeople));
  }

  let scheduling: { scheduledFor: Date; releaseAt: Date; releasedAt: Date | null } | null = null;
  if (input.scheduledFor) {
    if (input.channel === OrderChannel.TABLE || tableId) throw new OrderEngineError('SCHEDULE_NOT_FOR_TABLE');
    const settings = await loadSettings(tx, tenantId);
    const prepMinutes = Math.max(0, ...lines.map(line => line.product.prepTimeMinutes ?? 0));
    const decision = decideSchedule(input.scheduledFor, settings.scheduling, settings.hours.timezone, now, prepMinutes);
    if (!decision.ok) throw new OrderEngineError(decision.reason);
    scheduling = { scheduledFor: input.scheduledFor, releaseAt: decision.releaseAt, releasedAt: decision.releaseNow ? now : null };
  }

  const total = subtotal.sub(discount).add(serviceFee).add(deliveryFee).add(couvertFee);
  const created = await tx.order.create({
    data: {
      tenantId, unitId, code: newOrderCode(), number: await nextOrderNumber(tx, tenantId, now), channel: input.channel, status: OrderStatus.OPEN, createdByUserId: input.actorUserId ?? null,
      customerName, customerId, tableId, tableLabel, couponId, deliveryZoneId,
      subtotal, discount, serviceFee, deliveryFee, couvertFee, total, ...(scheduling ?? {}),
    },
  });
  for (const line of lines) {
    const item = await tx.orderItem.create({
      data: {
        orderId: created.id, productId: line.product.id, quantity: line.quantity, weightKg: line.weightKg, unitPrice: line.unitPrice, total: line.total, notes: line.notes,
        // A combo line is a billing wrapper; production happens on its component items.
        sectorId: line.product.isCombo ? null : line.product.sectorId,
        modifiers: { create: line.selected.map(entry => ({ optionId: entry.option.id, name: entry.option.name, price: entry.option.price, quantity: entry.quantity, sectorId: entry.option.sectorId, ingredientId: entry.option.ingredientId, ingredientQuantity: entry.option.ingredientQuantity })) },
      },
    });
    if (line.product.comboComponents.length > 0) {
      await tx.orderItem.createMany({ data: line.product.comboComponents.map(component => ({ orderId: created.id, parentItemId: item.id, productId: component.productId, quantity: component.quantity * line.quantity, unitPrice: 0, total: 0, sectorId: component.product.sectorId })) });
    }
  }
  const order = await tx.order.findUniqueOrThrow({ where: { id: created.id }, include: ORDER_INCLUDE });
  // Orders waiting for their scheduled release must not reach the kitchen yet.
  if (!scheduling || scheduling.releasedAt) await enqueueProductionPrints(tx, order, { onlyAutoPrint: true });
  await tx.auditLog.create({ data: { tenantId, actorUserId: input.actorUserId ?? null, action: 'ORDER_CREATED', entityType: 'Order', entityId: order.id, metadata: { channel: input.channel, scheduledFor: scheduling?.scheduledFor.toISOString() ?? null } } });
  if (input.notifyCustomer !== false && customerPhone) {
    const settings = await loadSettings(tx, tenantId);
    await enqueueAutoMessage(tx, { tenantId, key: 'order_received', phone: customerPhone, orderId: order.id, vars: { orderCode: order.code, customerName: customerName ?? '', nome: (customerName ?? 'cliente').split(' ')[0], pedido: orderLabel(order), total: brl(order.total), agendado: scheduledSuffix(scheduling?.scheduledFor, settings.hours.timezone) } });
  }
  return order;
}
