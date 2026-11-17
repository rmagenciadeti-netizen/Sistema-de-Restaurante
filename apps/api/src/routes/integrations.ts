import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { OrderChannel, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { createOrder, OrderEngineError } from '../lib/order-engine';
import { moneySchema } from '../lib/money';
import { emailProviders, fiscalProviders, paymentProviders } from '../lib/providers';

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

// ---- Management of integration keys (marketplaces such as iFood, Rappi, own site) ----
export const integrationRoutes = Router();
integrationRoutes.use(requireAuth, requireTenant, requireRoles(...MANAGEMENT_ROLES));
// Which concrete adapters this deployment registered (see providers.config.ts). Credentials never leave the server.
integrationRoutes.get('/providers', (_req, res) => res.json({ payment: paymentProviders.names(), fiscal: fiscalProviders.names(), email: emailProviders.names() }));
integrationRoutes.get('/', async (req, res, next) => {
  try { const items = await prisma.integration.findMany({ where: { tenantId: req.auth!.tenantId! }, select: { id: true, provider: true, name: true, unitId: true, active: true, lastUsedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
integrationRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = z.object({ provider: z.string().regex(/^[a-z0-9-]{2,30}$/), name: z.string().min(2).max(100), unitId: z.string().uuid() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    if (req.auth!.unitId && parsed.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (!await prisma.unit.findFirst({ where: { id: parsed.data.unitId, tenantId } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const key = `rmint_${randomBytes(32).toString('base64url')}`;
    const created = await prisma.integration.create({ data: { ...parsed.data, tenantId, keyHash: hashKey(key) }, select: { id: true, provider: true, name: true, unitId: true, active: true } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'INTEGRATION_CREATED', entityType: 'Integration', entityId: created.id } });
    return res.status(201).json({ ...created, key, note: 'Guarde a chave agora; ela não será exibida novamente.' });
  } catch (error) { return next(error); }
});
integrationRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ active: z.boolean() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed' });
    const updated = await prisma.integration.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, data: { active: parsed.data.active } });
    return updated.count === 1 ? res.json({ id: req.params.id, active: parsed.data.active }) : res.status(404).json({ message: 'Integration not found' });
  } catch (error) { return next(error); }
});

// ---- Inbound orders from a marketplace, authenticated by integration key ----
export const inboundRoutes = Router();
const inboundSchema = z.object({
  externalId: z.string().min(1).max(100),
  customer: z.object({ name: z.string().min(1).max(160), phone: z.string().max(30).optional() }),
  address: z.string().max(500).optional(),
  deliveryFee: moneySchema.optional(),
  items: z.array(z.object({ code: z.string().min(1).max(50), quantity: z.number().int().positive().max(999), notes: z.string().max(500).optional() })).min(1).max(100),
});

inboundRoutes.post('/:source/orders', async (req, res, next) => {
  try {
    const key = req.headers.authorization?.match(/^Bearer\s+(rmint_[\w-]+)$/)?.[1];
    if (!key) return res.status(401).json({ message: 'Integration key required' });
    const integration = await prisma.integration.findUnique({ where: { keyHash: hashKey(key) }, include: { tenant: { select: { status: true } } } });
    if (!integration || !integration.active || integration.provider !== req.params.source || !['ACTIVE', 'TRIAL'].includes(integration.tenant.status) || !integration.unitId) return res.status(401).json({ message: 'Invalid integration key' });
    const parsed = inboundSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { tenantId, unitId } = integration;
    await prisma.integration.update({ where: { id: integration.id }, data: { lastUsedAt: new Date() } });

    const duplicate = await prisma.externalOrder.findUnique({ where: { tenantId_source_externalId: { tenantId, source: integration.provider, externalId: parsed.data.externalId } } });
    if (duplicate) return res.status(200).json({ orderId: duplicate.orderId, duplicate: true });

    // Marketplace items are mapped to our catalog by Product.code; our own prices apply.
    const codes = [...new Set(parsed.data.items.map(item => item.code))];
    const products = await prisma.product.findMany({ where: { tenantId, active: true, code: { in: codes }, OR: [{ unitId }, { unitId: null }] }, select: { id: true, code: true } });
    const byCode = new Map(products.map(product => [product.code, product.id]));
    const unknown = codes.filter(code => !byCode.has(code));
    if (unknown.length > 0) return res.status(422).json({ message: 'Unknown product codes', codes: unknown });

    try {
      const order = await serializable(prisma, async tx => {
        const created = await createOrder(tx, {
          tenantId, unitId, channel: OrderChannel.DELIVERY, notifyCustomer: false,
          customer: { name: parsed.data.customer.name, phone: parsed.data.customer.phone, untrusted: true },
          deliveryFeeOverride: new Prisma.Decimal(parsed.data.deliveryFee ?? 0),
          items: parsed.data.items.map(item => ({ productId: byCode.get(item.code)!, quantity: item.quantity, notes: item.notes })),
        });
        await tx.externalOrder.create({ data: { tenantId, source: integration.provider, externalId: parsed.data.externalId, orderId: created.id, payload: req.body as Prisma.InputJsonObject } });
        await tx.deliveryJob.create({ data: { tenantId, unitId, orderId: created.id, address: parsed.data.address, provider: integration.provider, externalRef: parsed.data.externalId } });
        return created;
      });
      return res.status(201).json({ orderId: order.id, code: order.code, total: order.total });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await prisma.externalOrder.findUnique({ where: { tenantId_source_externalId: { tenantId, source: integration.provider, externalId: parsed.data.externalId } } });
        if (raced) return res.status(200).json({ orderId: raced.orderId, duplicate: true });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof OrderEngineError) return res.status(error.httpStatus === 400 ? 422 : error.httpStatus).json({ message: error.reason });
    return next(error);
  }
});
