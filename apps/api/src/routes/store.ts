import { Router } from 'express';
import { OrderChannel, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { OrderEngineError } from '../lib/order-engine';
import { placeStoreOrder, StoreOrderError } from '../lib/store-order';
import { loadSettings } from '../lib/settings';
import { positiveQuantitySchema } from '../lib/money';
import { isStoreOpen } from '../lib/scheduling';
import { hiddenCategoryIds } from '../lib/menu-visibility';
import { effectiveUnitPrice } from '../lib/promotions';

// Public virtual store (menu link). Mounted without authentication under /public/store; the tenant slug for the admin screen comes from GET /auth/me.
export const storeRoutes = Router();

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function resolveStore(slug: string, requestedUnitId?: string) {
  if (slug.length > 100 || !SLUG.test(slug)) return null;
  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, name: true, slug: true, status: true } });
  if (!tenant || !['ACTIVE', 'TRIAL'].includes(tenant.status)) return null;
  const unit = await prisma.unit.findFirst({ where: { tenantId: tenant.id, status: 'ACTIVE', ...(requestedUnitId ? { id: requestedUnitId } : {}) }, orderBy: { createdAt: 'asc' }, select: { id: true, name: true } });
  return unit ? { tenant, unit } : null;
}

storeRoutes.get('/:slug', async (req, res, next) => {
  try {
    const store = await resolveStore(req.params.slug);
    if (!store) return res.status(404).json({ message: 'Store not found' });
    const { tenant, unit } = store;
    const now = new Date();
    const unitScope = { OR: [{ unitId: unit.id }, { unitId: null }] };
    const [settings, hidden, products, promotionRows, zones, methods, profileImages] = await Promise.all([
      loadSettings(prisma, tenant.id),
      hiddenCategoryIds(prisma, tenant.id, now),
      prisma.product.findMany({
        where: { tenantId: tenant.id, active: true, localOnly: false, isComponent: false, ...unitScope },
        select: {
          id: true, name: true, description: true, price: true, isCombo: true, soldByWeight: true, allowFractionalQuantity: true, packagingEnabled: true, packagingPrice: true, favorite: true, allowNotes: true, image: { select: { updatedAt: true } }, category: { select: { id: true, name: true } },
          comboComponents: { select: { quantity: true, product: { select: { name: true } } } },
          modifierGroups: { select: { group: { select: { id: true, name: true, minSelect: true, maxSelect: true, active: true, options: { where: { active: true }, select: { id: true, name: true, price: true }, orderBy: { name: 'asc' } } } } } },
        },
        orderBy: { name: 'asc' }, take: 1000,
      }),
      prisma.promotion.findMany({
        where: { tenantId: tenant.id, active: true, startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        include: { products: { select: { productId: true } } },
      }),
      prisma.deliveryZone.findMany({ where: { tenantId: tenant.id, active: true, ...unitScope }, select: { id: true, name: true, fee: true, minOrder: true, estimatedMinutes: true, neighborhoods: true }, orderBy: { name: 'asc' } }),
      prisma.paymentMethodConfig.findMany({ where: { tenantId: tenant.id, active: true, showStore: true }, select: { id: true, name: true, equivalent: true, allowChange: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      prisma.storeImage.findMany({ where: { tenantId: tenant.id }, select: { kind: true, updatedAt: true } }),
    ]);
    const promotions = promotionRows.map(row => ({ type: row.type, value: row.value, startsAt: row.startsAt, endsAt: row.endsAt, active: row.active, productIds: row.products.map(link => link.productId) }));
    const categories = new Map<string, { id: string | null; name: string; products: unknown[] }>();
    for (const { category, modifierGroups, image, ...rest } of products) {
      if (category && hidden.has(category.id)) continue;
      const price = effectiveUnitPrice(rest.id, rest.price, promotions, now);
      const product = {
        ...rest, imageVersion: image ? image.updatedAt.getTime() : null, promoPrice: price.lt(rest.price) ? price : null,
        modifierGroups: modifierGroups.map(link => link.group).filter(group => group.active && group.options.length > 0).map(({ active: _active, ...group }) => group),
      };
      const key = category?.id ?? 'none';
      if (!categories.has(key)) categories.set(key, { id: category?.id ?? null, name: category?.name ?? 'Outros', products: [] });
      categories.get(key)!.products.push(product);
    }
    const { fulfillment, scheduling, store: storeSettings, hours } = settings;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      restaurant: { name: tenant.name, slug: tenant.slug, logoVersion: profileImages.find(image => image.kind === 'LOGO')?.updatedAt.getTime() ?? null, coverVersion: profileImages.find(image => image.kind === 'COVER')?.updatedAt.getTime() ?? null },
      open: isStoreOpen(hours, now),
      hours: { timezone: hours.timezone, mode: hours.mode, weekly: hours.weekly },
      fulfillment: {
        allowPickup: fulfillment.allowPickup, allowDelivery: fulfillment.allowDelivery, allowDineIn: fulfillment.allowDineIn, estimatedTime: fulfillment.estimatedTime, pickupMinutes: fulfillment.pickupMinutes, deliveryMinutes: fulfillment.deliveryMinutes,
        deliveryFeeMode: fulfillment.deliveryFeeMode, singleFee: fulfillment.singleFee, minDelivery: fulfillment.minDelivery, freeDeliveryMin: fulfillment.freeDeliveryMin,
      },
      scheduling: { enabled: scheduling.enabled, maxDaysAhead: scheduling.maxDaysAhead, leadTime: scheduling.leadTime, blockedFrom: scheduling.blockedFrom, blockedTo: scheduling.blockedTo, slots: scheduling.slots },
      allowBuyWhenClosed: storeSettings.allowBuyWhenClosed, autoAccept: storeSettings.autoAccept, brandColor: storeSettings.brandColor, metaPixelId: storeSettings.metaPixelId || null,
      storeMode: storeSettings.mode, minorControl: storeSettings.minorControl,
      categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
      deliveryZones: zones, paymentMethods: methods,
    });
  } catch (error) { return next(error); }
});

const orderSchema = z.object({
  fulfillment: z.enum(['DELIVERY', 'TAKEAWAY']),
  customer: z.object({ name: z.string().trim().min(1).max(160), phone: z.string().trim().min(8).max(30) }),
  address: z.string().trim().max(300).optional(),
  deliveryZoneId: z.string().uuid().optional(),
  couponCode: z.string().trim().min(1).max(40).optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
  notes: z.string().trim().max(300).optional(),
  paymentMethodId: z.string().uuid().optional(),
  changeFor: z.number().positive().max(99999).optional(),
  adultConfirmed: z.boolean().optional(),
  unitId: z.string().uuid().optional(),
  items: z.array(z.object({
    productId: z.string().uuid(), quantity: positiveQuantitySchema(20), weightKg: z.number().positive().max(999.999).optional(), withPackaging: z.boolean().optional(), notes: z.string().trim().max(200).optional(),
    modifiers: z.array(z.object({ optionId: z.string().uuid(), quantity: z.number().int().positive().max(20).optional() })).max(20).optional(),
  })).min(1).max(30),
});

storeRoutes.get('/:slug/image/:kind', async (req, res, next) => {
  try {
    const store = await resolveStore(req.params.slug); if (!store) return res.status(404).end();
    if (req.params.kind !== 'LOGO' && req.params.kind !== 'COVER') return res.status(404).end();
    const image = await prisma.storeImage.findUnique({ where: { tenantId_kind: { tenantId: store.tenant.id, kind: req.params.kind } } }); if (!image) return res.status(404).end();
    res.setHeader('Content-Type', image.contentType); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(Buffer.from(image.data));
  } catch (error) { return next(error); }
});

// Product photos are public by design (they are on the menu); only active products of a live store are served.
storeRoutes.get('/:slug/products/:productId/image', async (req, res, next) => {
  try {
    const store = await resolveStore(req.params.slug); if (!store) return res.status(404).end();
    if (!/^[0-9a-f-]{36}$/.test(req.params.productId)) return res.status(404).end();
    const image = await prisma.productImage.findFirst({ where: { productId: req.params.productId, product: { tenantId: store.tenant.id, active: true } } });
    if (!image) return res.status(404).end();
    res.setHeader('Content-Type', image.contentType); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(Buffer.from(image.data));
  } catch (error) { return next(error); }
});

storeRoutes.post('/:slug/orders', async (req, res, next) => {
  try {
    const parsed = orderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const input = parsed.data;
    const store = await resolveStore(req.params.slug, input.unitId);
    if (!store) return res.status(404).json({ message: 'Store not found' });
    const order = await placeStoreOrder(prisma, {
      tenantId: store.tenant.id, unitId: store.unit.id, fulfillment: input.fulfillment, customer: input.customer, address: input.address, deliveryZoneId: input.deliveryZoneId, couponCode: input.couponCode,
      scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined, notes: input.notes, paymentMethodId: input.paymentMethodId, changeFor: input.changeFor, adultConfirmed: input.adultConfirmed, items: input.items,
    });
    return res.status(201).json({ code: order.code, number: order.number, total: order.total, deliveryFee: order.deliveryFee, scheduledFor: order.scheduledFor, autoAccept: order.autoAccept });
  } catch (error) {
    if (error instanceof StoreOrderError) return res.status(error.status).json({ message: error.code });
    if (error instanceof OrderEngineError) return res.status(error.httpStatus).json({ message: error.reason === 'FRACTIONAL_QUANTITY_NOT_ALLOWED' ? 'Este produto não permite quantidade fracionada.' : error.reason === 'PACKAGING_NOT_ALLOWED' ? 'Este produto não permite embalagem.' : error.reason });
    return next(error);
  }
});
