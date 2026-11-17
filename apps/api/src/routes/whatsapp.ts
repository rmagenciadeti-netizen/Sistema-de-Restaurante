import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';

export const whatsappRoutes = Router();
whatsappRoutes.use(requireAuth, requireTenant);
// This endpoint creates an auditable outbox item. A configured official provider and worker are required to send messages.
whatsappRoutes.post('/outbox', async (req, res, next) => {
  try { const input = z.object({ toPhone: z.string().min(8).max(30), template: z.string().min(1).max(100), orderId: z.string().uuid().optional(), payload: z.record(z.unknown()).optional() }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() }); const tenantId = req.auth!.tenantId!; if (input.data.orderId && !await prisma.order.findFirst({ where: { id: input.data.orderId, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) } })) return res.status(404).json({ message: 'Order not found' });
    // express.json has already restricted nested payload values to JSON.
    const payload = input.data.payload as Prisma.InputJsonObject | undefined;
    const message = await prisma.whatsappMessage.create({ data: { ...input.data, payload, tenantId, status: 'QUEUED' } }); return res.status(202).json({ message, delivery: 'QUEUED_NOT_SENT', note: 'Configure um provedor oficial e worker para realizar o envio.' }); }
  catch (error) { return next(error); }
});
whatsappRoutes.get('/outbox', async (req, res, next) => {
  try { const items = await prisma.whatsappMessage.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
