import { Router } from 'express';
import { PaymentMethod, PaymentStatus, CashSessionStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const cashRoutes = Router();
cashRoutes.use(requireAuth, requireTenant);
cashRoutes.post('/sessions', async (req, res, next) => {
  try { const input = z.object({ openingAmount: z.number().nonnegative(), unitId: z.string().uuid().optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() }); const unitId = input.data.unitId ?? req.auth!.unitId; if (input.data.unitId && req.auth!.unitId && input.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' }); if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: req.auth!.tenantId! } })) return res.status(400).json({ message: 'Invalid unit' }); const existing = await prisma.cashSession.findFirst({ where: { tenantId: req.auth!.tenantId!, unitId: unitId ?? null, status: CashSessionStatus.OPEN } }); if (existing) return res.status(409).json({ message: 'There is already an open cash session for this unit' }); const session = await prisma.cashSession.create({ data: { tenantId: req.auth!.tenantId!, unitId, openedByUserId: req.auth!.userId, openingAmount: input.data.openingAmount } }); return res.status(201).json(session); }
  catch (error) { return next(error); }
});
cashRoutes.get('/sessions', async (req, res, next) => {
  try { const items = await prisma.cashSession.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { payments: true }, orderBy: { openedAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
cashRoutes.post('/sessions/:id/close', async (req, res, next) => {
  try { const input = z.object({ closingAmount: z.number().nonnegative() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() }); const session = await prisma.cashSession.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: 'OPEN' }, include: { payments: { where: { status: PaymentStatus.CONFIRMED, method: PaymentMethod.CASH } } } }); if (!session) return res.status(404).json({ message: 'Open cash session not found' }); const expected = session.openingAmount.add(session.payments.reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0))); const closed = await prisma.cashSession.update({ where: { id: session.id }, data: { status: 'CLOSED', closingAmount: input.data.closingAmount, expectedAmount: expected, closedByUserId: req.auth!.userId, closedAt: new Date() } }); await prisma.auditLog.create({ data: { tenantId: session.tenantId, actorUserId: req.auth!.userId, action: 'CASH_SESSION_CLOSED', entityType: 'CashSession', entityId: session.id, metadata: { expected: expected.toString(), closing: input.data.closingAmount } } }); return res.json(closed); }
  catch (error) { return next(error); }
});
cashRoutes.post('/payments', async (req, res, next) => {
  try {
    const input = z.object({ orderId: z.string().uuid(), method: z.nativeEnum(PaymentMethod), amount: z.number().positive(), cashSessionId: z.string().uuid().optional(), reference: z.string().max(200).optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const tenantId = req.auth!.tenantId!; const order = await prisma.order.findFirst({ where: { id: input.data.orderId, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } }); if (!order) return res.status(404).json({ message: 'Order not found' });
    if (input.data.cashSessionId && !await prisma.cashSession.findFirst({ where: { id: input.data.cashSessionId, tenantId, status: 'OPEN', ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } })) return res.status(400).json({ message: 'Invalid or closed cash session' });
    const payment = await prisma.payment.create({ data: { tenantId, unitId: order.unitId, orderId: order.id, cashSessionId: input.data.cashSessionId, method: input.data.method, amount: input.data.amount, reference: input.data.reference } });
    const paid = await prisma.payment.aggregate({ where: { orderId: order.id, status: 'CONFIRMED' }, _sum: { amount: true } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'PAYMENT_RECORDED', entityType: 'Payment', entityId: payment.id } });
    return res.status(201).json({ payment, amountPaid: paid._sum.amount ?? 0, orderTotal: order.total });
  } catch (error) { return next(error); }
});
cashRoutes.get('/payments', async (req, res, next) => {
  try { const items = await prisma.payment.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { order: { select: { code: true } } }, orderBy: { paidAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
