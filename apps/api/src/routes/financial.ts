import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';

export const financialRoutes = Router();
financialRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
financialRoutes.get('/summary', async (req, res, next) => {
  try { const tenantId = req.auth!.tenantId!; const unitId = req.auth!.unitId; const base = { tenantId, ...(unitId ? { unitId } : {}), status: FinancialEntryStatus.PAID }; const [income, expenses, openReceivables, openPayables, payments] = await Promise.all([prisma.financialEntry.aggregate({ where: { ...base, type: FinancialEntryType.INCOME }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { ...base, type: FinancialEntryType.EXPENSE }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { tenantId, ...(unitId ? { unitId } : {}), type: FinancialEntryType.INCOME, status: FinancialEntryStatus.OPEN }, _sum: { amount: true } }), prisma.financialEntry.aggregate({ where: { tenantId, ...(unitId ? { unitId } : {}), type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.OPEN }, _sum: { amount: true } }), prisma.payment.aggregate({ where: { tenantId, ...(unitId ? { unitId } : {}), status: 'CONFIRMED' }, _sum: { amount: true }, _count: true })]); const revenue = income._sum.amount ?? new Prisma.Decimal(0); const expense = expenses._sum.amount ?? new Prisma.Decimal(0); return res.json({ revenue, expenses: expense, net: revenue.sub(expense), openReceivables: openReceivables._sum.amount ?? 0, openPayables: openPayables._sum.amount ?? 0, recordedPayments: payments._sum.amount ?? 0, paymentCount: payments._count }); }
  catch (error) { return next(error); }
});
financialRoutes.get('/entries', async (req, res, next) => {
  try {
    const query = z.object({
      page: z.coerce.number().int().min(1).max(100000).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(100),
      type: z.nativeEnum(FinancialEntryType).optional(),
      status: z.nativeEnum(FinancialEntryStatus).optional(),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters or pagination' });
    const { page, pageSize, type, status } = query.data;
    const where = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), ...(type ? { type } : {}), ...(status ? { status } : {}) };
    const [items, total] = await Promise.all([
      prisma.financialEntry.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      prisma.financialEntry.count({ where }),
    ]);
    return res.json({ items, total, page, pageSize });
  }
  catch (error) { return next(error); }
});
financialRoutes.post('/entries', async (req, res, next) => {
  try {
    const input = z.object({ description: z.string().trim().min(2).max(200), type: z.nativeEnum(FinancialEntryType), category: z.string().trim().max(100).optional(), amount: z.number().positive().max(9999999999.99).multipleOf(0.01), unitId: z.string().uuid().optional(), dueAt: z.string().datetime().optional(), status: z.nativeEnum(FinancialEntryStatus).default('OPEN') }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const { tenantId, userId } = req.auth!; const unitId = input.data.unitId ?? req.auth!.unitId;
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId: tenantId! } })) return res.status(400).json({ message: 'Unit does not belong to this tenant' });
    const category = input.data.category ? (await prisma.financialCategory.findFirst({ where: { tenantId: tenantId!, type: input.data.type, name: { equals: input.data.category, mode: 'insensitive' } }, select: { name: true } }))?.name ?? input.data.category : undefined;
    const item = await prisma.$transaction(async tx => {
      const created = await tx.financialEntry.create({ data: { ...input.data, category, tenantId: tenantId!, unitId, dueAt: input.data.dueAt ? new Date(input.data.dueAt) : undefined, settledAt: input.data.status === 'PAID' ? new Date() : undefined } });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'FINANCIAL_ENTRY_CREATED', entityType: 'FinancialEntry', entityId: created.id, metadata: { status: created.status, type: created.type } } });
      return created;
    });
    return res.status(201).json(item);
  }
  catch (error) { return next(error); }
});

financialRoutes.post('/entries/:id/settle', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const scope = { id: req.params.id, tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const result = await serializable(prisma, async tx => {
      const entry = await tx.financialEntry.findFirst({ where: scope });
      if (!entry) return { status: 404, message: 'Financial entry not found' } as const;
      if (entry.status !== FinancialEntryStatus.OPEN) return { status: 409, message: 'Only open entries can be settled' } as const;
      const updated = await tx.financialEntry.update({ where: { id: entry.id }, data: { status: FinancialEntryStatus.PAID, settledAt: new Date() } });
      await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'FINANCIAL_ENTRY_SETTLED', entityType: 'FinancialEntry', entityId: entry.id } });
      return { status: 200, entry: updated } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json(result.entry);
  } catch (error) { return next(error); }
});
