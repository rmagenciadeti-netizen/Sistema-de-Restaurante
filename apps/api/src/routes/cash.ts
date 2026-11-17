import { Router } from 'express';
import { PaymentMethod, PaymentStatus, CashSessionStatus, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { MAX_MONEY, moneySchema, positiveMoneySchema } from '../lib/money';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';

export const cashRoutes = Router();
cashRoutes.use(requireAuth, requireTenant);

cashRoutes.post('/sessions', async (req, res, next) => {
  try {
    const input = z.object({ openingAmount: moneySchema, unitId: z.string().uuid().optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const { tenantId, userId } = req.auth!;
    const unitId = input.data.unitId ?? req.auth!.unitId;
    if (input.data.unitId && req.auth!.unitId && input.data.unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    const result = await serializable(prisma, async tx => {
      if (unitId && !await tx.unit.findFirst({ where: { id: unitId, tenantId: tenantId! } })) return { error: 'Invalid unit', status: 400 } as const;
      const existing = await tx.cashSession.findFirst({ where: { tenantId: tenantId!, unitId, status: CashSessionStatus.OPEN } });
      if (existing) return { error: 'There is already an open cash session for this unit', status: 409 } as const;
      const session = await tx.cashSession.create({ data: { tenantId: tenantId!, unitId, openedByUserId: userId, openingAmount: input.data.openingAmount } });
      return { session } as const;
    });
    if (result.error !== undefined) return res.status(result.status).json({ message: result.error });
    return res.status(201).json(result.session);
  } catch (error) { return next(error); }
});

cashRoutes.get('/sessions', async (req, res, next) => {
  try { const items = await prisma.cashSession.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { payments: true }, orderBy: { openedAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});

cashRoutes.post('/sessions/:id/close', async (req, res, next) => {
  try {
    const input = z.object({ closingAmount: moneySchema }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const { tenantId, unitId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const session = await tx.cashSession.findFirst({
        where: { id: req.params.id, tenantId: tenantId!, ...(unitId ? { unitId } : {}), status: CashSessionStatus.OPEN },
      });
      if (!session) return { error: 'Open cash session not found', status: 404 } as const;
      const payments = await tx.payment.aggregate({
        where: { tenantId: tenantId!, cashSessionId: session.id, status: PaymentStatus.CONFIRMED, method: PaymentMethod.CASH },
        _sum: { amount: true },
      });
      const expected = session.openingAmount.add(payments._sum.amount ?? new Prisma.Decimal(0));
      if (expected.gt(MAX_MONEY)) return { error: 'Expected amount exceeds the supported maximum', status: 409 } as const;
      const closed = await tx.cashSession.update({
        where: { id: session.id },
        data: { status: CashSessionStatus.CLOSED, closingAmount: input.data.closingAmount, expectedAmount: expected, closedByUserId: userId, closedAt: new Date() },
      });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'CASH_SESSION_CLOSED', entityType: 'CashSession', entityId: session.id, metadata: { expected: expected.toString(), closing: input.data.closingAmount } } });
      return { closed } as const;
    });
    if (result.error !== undefined) return res.status(result.status).json({ message: result.error });
    return res.json(result.closed);
  } catch (error) { return next(error); }
});

cashRoutes.post('/payments', async (req, res, next) => {
  try {
    const input = z.object({ orderId: z.string().uuid(), method: z.nativeEnum(PaymentMethod), amount: positiveMoneySchema, cashSessionId: z.string().uuid().optional(), reference: z.string().max(200).optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const { tenantId, unitId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const order = await tx.order.findFirst({ where: { id: input.data.orderId, tenantId: tenantId!, ...(unitId ? { unitId } : {}) } });
      if (!order) return { error: 'Order not found', status: 404 } as const;
      if (order.status === OrderStatus.CANCELLED) return { error: 'Cannot pay a cancelled order', status: 409 } as const;
      if (input.data.cashSessionId && !await tx.cashSession.findFirst({ where: { id: input.data.cashSessionId, tenantId: tenantId!, unitId: order.unitId, status: CashSessionStatus.OPEN } })) return { error: 'Invalid or closed cash session', status: 400 } as const;
      const paid = await tx.payment.aggregate({ where: { tenantId: tenantId!, orderId: order.id, status: PaymentStatus.CONFIRMED }, _sum: { amount: true } });
      const amountPaid = (paid._sum.amount ?? new Prisma.Decimal(0)).add(input.data.amount);
      if (amountPaid.gt(order.total)) return { error: 'Payment exceeds the remaining order balance', status: 409 } as const;
      const payment = await tx.payment.create({ data: { tenantId: tenantId!, unitId: order.unitId, orderId: order.id, cashSessionId: input.data.cashSessionId, method: input.data.method, amount: input.data.amount, reference: input.data.reference } });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'PAYMENT_RECORDED', entityType: 'Payment', entityId: payment.id } });
      return { payment, amountPaid, orderTotal: order.total } as const;
    });
    if (result.error !== undefined) return res.status(result.status).json({ message: result.error });
    return res.status(201).json(result);
  } catch (error) { return next(error); }
});

cashRoutes.get('/payments', async (req, res, next) => {
  try { const items = await prisma.payment.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, include: { order: { select: { code: true } } }, orderBy: { paidAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
