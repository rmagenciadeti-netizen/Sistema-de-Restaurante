import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';

export const financialRoutes = Router();
financialRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
financialRoutes.get('/summary', async (req, res, next) => {
  try { const tenantId = req.auth!.tenantId!; const unitId = req.auth!.unitId; const base = { tenantId, ...(unitId ? { unitId } : {}), status: FinancialEntryStatus.PAID }; const [income, expenses, openReceivables, openPayables, payments] = await Promise.all([prisma.financialEntry.aggregate({ where: { ...base, type: FinancialEntryType.INCOME }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { ...base, type: FinancialEntryType.EXPENSE }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { tenantId, ...(unitId ? { unitId } : {}), type: FinancialEntryType.INCOME, status: FinancialEntryStatus.OPEN }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { tenantId, ...(unitId ? { unitId } : {}), type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.OPEN }, _sum: { amount: true } }), prisma.payment.aggregate({ where: { tenantId, ...(unitId ? { unitId } : {}), status: 'CONFIRMED' }, _sum: { amount: true }, _count: true })]); const revenue = income._sum.amount ?? new Prisma.Decimal(0); const expense = expenses._sum.amount ?? new Prisma.Decimal(0); return res.json({ revenue, expenses: expense, net: revenue.sub(expense), openReceivables: openReceivables._sum.amount ?? 0, openPayables: openPayables._sum.amount ?? 0, recordedPayments: payments._sum.amount ?? 0, paymentCount: payments._count }); }
  catch (error) { return next(error); }
});
financialRoutes.get('/entries', async (req, res, next) => {
  try { const items = await prisma.financialEntry.findMany({ where: { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) }, orderBy: { createdAt: 'desc' }, take: 100 }); return res.json({ items, total: items.length }); }
  catch (error) { return next(error); }
});
financialRoutes.post('/entries', async (req, res, next) => {
  try { const input = z.object({ description: z.string().min(2).max(200), type: z.nativeEnum(FinancialEntryType), category: z.string().max(100).optional(), amount: z.number().positive(), dueAt: z.string().datetime().optional(), status: z.nativeEnum(FinancialEntryStatus).default('OPEN') }).safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() }); const item = await prisma.financialEntry.create({ data: { ...input.data, tenantId: req.auth!.tenantId!, unitId: req.auth!.unitId, dueAt: input.data.dueAt ? new Date(input.data.dueAt) : undefined, settledAt: input.data.status === 'PAID' ? new Date() : undefined } }); return res.status(201).json(item); }
  catch (error) { return next(error); }
});
