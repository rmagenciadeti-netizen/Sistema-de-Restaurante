import { Router } from 'express';
import { FiscalKind, FiscalStatus, OrderStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { fiscalProviders } from '../lib/providers';

export const fiscalRoutes = Router();
fiscalRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});

fiscalRoutes.get('/providers', (_req, res) => res.json({ items: fiscalProviders.names() }));
fiscalRoutes.get('/documents', async (req, res, next) => {
  try { const items = await prisma.fiscalDocument.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req) }, include: { order: { select: { code: true, total: true } } }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
fiscalRoutes.post('/orders/:orderId/emit', async (req, res, next) => {
  try {
    const parsed = z.object({ provider: z.string().min(1).max(60), kind: z.nativeEnum(FiscalKind).default(FiscalKind.NFCE) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const provider = fiscalProviders.get(parsed.data.provider);
    if (!provider) return res.status(501).json({ message: 'Fiscal provider is not configured' });
    const tenantId = req.auth!.tenantId!;
    const order = await prisma.order.findFirst({ where: { id: req.params.orderId, tenantId, ...unitScope(req) }, include: { items: { where: { parentItemId: null }, include: { product: { select: { name: true } } } }, customer: { select: { name: true, document: true } } } });
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.status !== OrderStatus.COMPLETED) return res.status(409).json({ message: 'Only completed orders can be invoiced' });
    const existing = await prisma.fiscalDocument.findUnique({ where: { orderId_kind: { orderId: order.id, kind: parsed.data.kind } } });
    // A PENDING row older than the timeout belongs to a crashed attempt and may be retried.
    const stale = new Date(Date.now() - 10 * 60 * 1000);
    const retryable = (doc: { status: FiscalStatus; updatedAt: Date }) => doc.status === FiscalStatus.REJECTED || (doc.status === FiscalStatus.PENDING && doc.updatedAt < stale);
    if (existing && !retryable(existing)) return res.status(409).json({ message: 'A fiscal document already exists for this order' });
    // The unique (orderId, kind) row doubles as an emission lock: PENDING blocks concurrent attempts.
    const document = existing
      ? (await prisma.fiscalDocument.updateMany({ where: { id: existing.id, OR: [{ status: FiscalStatus.REJECTED }, { status: FiscalStatus.PENDING, updatedAt: { lt: stale } }] }, data: { status: FiscalStatus.PENDING, provider: provider.name, error: null } })).count === 1 ? existing : null
      : await prisma.fiscalDocument.create({ data: { tenantId, unitId: order.unitId, orderId: order.id, provider: provider.name, kind: parsed.data.kind } }).catch(() => null);
    if (!document) return res.status(409).json({ message: 'Emission already in progress' });
    try {
      const result = await provider.emit({ orderId: order.id, code: order.code, total: order.total.toFixed(2), issuedAt: new Date(), customer: { name: order.customer?.name ?? order.customerName, document: order.customer?.document ?? null }, items: order.items.map(item => ({ name: item.product.name, quantity: item.quantity, unitPrice: item.unitPrice.toFixed(2), total: item.total.toFixed(2) })) }, parsed.data.kind);
      const saved = await prisma.fiscalDocument.update({ where: { id: document.id }, data: { status: result.status === 'AUTHORIZED' ? FiscalStatus.AUTHORIZED : FiscalStatus.REJECTED, number: result.number, accessKey: result.accessKey, documentUrl: result.documentUrl, error: result.error } });
      await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'FISCAL_EMITTED', entityType: 'FiscalDocument', entityId: saved.id, metadata: { status: saved.status } } });
      return res.status(saved.status === FiscalStatus.AUTHORIZED ? 201 : 422).json(saved);
    } catch {
      await prisma.fiscalDocument.update({ where: { id: document.id }, data: { status: FiscalStatus.REJECTED, error: 'PROVIDER_ERROR' } });
      return res.status(502).json({ message: 'Fiscal provider failed; the document was left rejected and can be retried' });
    }
  } catch (error) { return next(error); }
});
fiscalRoutes.post('/documents/:id/cancel', async (req, res, next) => {
  try {
    const parsed = z.object({ reason: z.string().min(15).max(255) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'A cancellation reason of at least 15 characters is required' });
    const document = await prisma.fiscalDocument.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...unitScope(req), status: FiscalStatus.AUTHORIZED } });
    if (!document) return res.status(404).json({ message: 'Authorized document not found' });
    const provider = fiscalProviders.get(document.provider);
    if (!provider) return res.status(501).json({ message: 'Fiscal provider is not configured' });
    const result = await provider.cancel({ number: document.number, accessKey: document.accessKey }, parsed.data.reason).catch(() => ({ cancelled: false, error: 'PROVIDER_ERROR' }));
    if (!result.cancelled) return res.status(422).json({ message: result.error ?? 'Provider refused the cancellation' });
    const saved = await prisma.fiscalDocument.update({ where: { id: document.id }, data: { status: FiscalStatus.CANCELLED } });
    await prisma.auditLog.create({ data: { tenantId: document.tenantId, actorUserId: req.auth!.userId, action: 'FISCAL_CANCELLED', entityType: 'FiscalDocument', entityId: document.id } });
    return res.json(saved);
  } catch (error) { return next(error); }
});
