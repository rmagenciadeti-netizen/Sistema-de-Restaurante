import { Router } from 'express';
import { ChargeStatus, OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { CASH_ROLES, requireRoles } from '../lib/permissions';
import { paymentProviders } from '../lib/providers';

// Webhooks are unauthenticated by session; the provider adapter authenticates them by signature over the raw body.
export const paymentWebhookRoutes = Router();
paymentWebhookRoutes.post('/:provider', async (req, res, next) => {
  try {
    const provider = paymentProviders.get(req.params.provider);
    if (!provider) return res.status(404).json({ message: 'Unknown provider' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let event;
    try { event = provider.parseWebhook(req.headers, raw); } catch { event = null; }
    if (!event) return res.status(400).json({ message: 'Invalid webhook' });
    const result = await serializable(prisma, async tx => {
      const charge = await tx.paymentCharge.findUnique({ where: { provider_externalRef: { provider: provider.name, externalRef: event.externalRef } } });
      if (!charge) return 'unknown' as const;
      if (charge.status !== ChargeStatus.PENDING) return 'duplicate' as const;
      if (event.status !== 'PAID') {
        await tx.paymentCharge.update({ where: { id: charge.id }, data: { status: event.status as ChargeStatus } });
        return 'updated' as const;
      }
      // Money was actually received, so it is recorded even if the order balance changed meanwhile; the excess is flagged for review.
      const paid = await tx.payment.aggregate({ where: { tenantId: charge.tenantId, orderId: charge.orderId, status: PaymentStatus.CONFIRMED }, _sum: { amount: true } });
      const order = await tx.order.findUnique({ where: { id: charge.orderId }, select: { total: true } });
      const exceeds = (paid._sum.amount ?? new Prisma.Decimal(0)).add(charge.amount).gt(order?.total ?? 0);
      const payment = await tx.payment.create({ data: { tenantId: charge.tenantId, unitId: charge.unitId, orderId: charge.orderId, method: charge.method, amount: charge.amount, reference: `${provider.name}:${event.externalRef}` } });
      await tx.paymentCharge.update({ where: { id: charge.id }, data: { status: ChargeStatus.PAID, paidAt: new Date(), paymentId: payment.id, error: exceeds ? 'EXCEEDS_ORDER_BALANCE' : null } });
      await tx.auditLog.create({ data: { tenantId: charge.tenantId, action: 'PAYMENT_CHARGE_PAID', entityType: 'PaymentCharge', entityId: charge.id, metadata: { provider: provider.name, exceeds } } });
      return 'paid' as const;
    });
    return res.status(200).json({ result });
  } catch (error) { return next(error); }
});

export const paymentRoutes = Router();
paymentRoutes.use(requireAuth, requireTenant, requireRoles(...CASH_ROLES));
const chargeSchema = z.object({ orderId: z.string().uuid(), provider: z.string().min(1).max(60), method: z.enum([PaymentMethod.PIX, PaymentMethod.CREDIT_CARD, PaymentMethod.DEBIT_CARD]) });

paymentRoutes.get('/providers', (_req, res) => res.json({ items: paymentProviders.names() }));
paymentRoutes.get('/charges', async (req, res, next) => {
  try {
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : undefined;
    const items = await prisma.paymentCharge.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), ...(orderId ? { orderId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});
paymentRoutes.post('/charges', async (req, res, next) => {
  try {
    const parsed = chargeSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const provider = paymentProviders.get(parsed.data.provider);
    if (!provider) return res.status(501).json({ message: 'Payment provider is not configured' });
    const { tenantId, unitId } = req.auth!;
    // The charge covers the whole remaining balance and reserves it so concurrent charges cannot exceed the order total.
    const reserved = await serializable(prisma, async tx => {
      const order = await tx.order.findFirst({ where: { id: parsed.data.orderId, tenantId: tenantId!, ...(unitId ? { unitId } : {}) } });
      if (!order) return { status: 404, message: 'Order not found' } as const;
      if (order.status === OrderStatus.CANCELLED) return { status: 409, message: 'Cannot charge a cancelled order' } as const;
      const [paid, pending] = await Promise.all([
        tx.payment.aggregate({ where: { tenantId: tenantId!, orderId: order.id, status: PaymentStatus.CONFIRMED }, _sum: { amount: true } }),
        tx.paymentCharge.aggregate({ where: { tenantId: tenantId!, orderId: order.id, status: ChargeStatus.PENDING }, _sum: { amount: true } }),
      ]);
      const remaining = order.total.sub(paid._sum.amount ?? 0).sub(pending._sum.amount ?? 0);
      if (!remaining.gt(0)) return { status: 409, message: 'Order has no remaining balance to charge' } as const;
      const charge = await tx.paymentCharge.create({ data: { tenantId: tenantId!, unitId: order.unitId, orderId: order.id, provider: provider.name, method: parsed.data.method, amount: remaining } });
      return { status: 201, charge, code: order.code } as const;
    });
    if (reserved.status !== 201) return res.status(reserved.status).json({ message: reserved.message });
    try {
      const created = await provider.createCharge({ chargeId: reserved.charge.id, method: parsed.data.method, amount: reserved.charge.amount.toFixed(2), description: `Pedido ${reserved.code}` });
      const charge = await prisma.paymentCharge.update({ where: { id: reserved.charge.id }, data: { externalRef: created.externalRef, qrPayload: created.qrPayload } });
      return res.status(201).json(charge);
    } catch {
      await prisma.paymentCharge.update({ where: { id: reserved.charge.id }, data: { status: ChargeStatus.FAILED, error: 'PROVIDER_ERROR' } });
      return res.status(502).json({ message: 'Payment provider rejected the charge' });
    }
  } catch (error) { return next(error); }
});
paymentRoutes.post('/charges/:id/cancel', async (req, res, next) => {
  try {
    const updated = await prisma.paymentCharge.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: ChargeStatus.PENDING }, data: { status: ChargeStatus.EXPIRED } });
    return updated.count === 1 ? res.status(204).end() : res.status(409).json({ message: 'Only pending charges can be cancelled' });
  } catch (error) { return next(error); }
});
