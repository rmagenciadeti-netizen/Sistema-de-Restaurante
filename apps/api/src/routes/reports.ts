import { Router } from 'express';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { z } from 'zod';
import { loadSettings } from '../lib/settings';
import { finalizeReport, reportToCsv } from '../lib/report-helpers';
import { EXPORT_FORMATS, reportToPdf, reportToXlsx } from '../lib/report-export';

export const reportsRoutes = Router();
reportsRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));
reportsRoutes.get('/overview', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const scope = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const [orders, orderTotals, paymentMethods, expenses, popularItems] = await Promise.all([
      prisma.order.count({ where: { ...scope, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } } }),
      prisma.order.aggregate({ where: { ...scope, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } }, _sum: { subtotal: true, serviceFee: true, deliveryFee: true, discount: true, total: true } }),
      prisma.payment.groupBy({ by: ['method'], where: { ...scope, paidAt: { gte: from, lte: to }, status: 'CONFIRMED' }, _sum: { amount: true }, _count: true }),
      prisma.financialEntry.aggregate({ where: { ...scope, type: 'EXPENSE', status: 'PAID', settledAt: { gte: from, lte: to } }, _sum: { amount: true } }),
      prisma.orderItem.groupBy({ by: ['productId'], where: { order: { ...scope, createdAt: { gte: from, lte: to }, status: { not: 'CANCELLED' } } }, _sum: { quantity: true, total: true }, orderBy: { _sum: { quantity: 'desc' } }, take: 10 }),
    ]);
    const productIds = popularItems.map(x => x.productId); const products = await prisma.product.findMany({ where: { id: { in: productIds }, tenantId: req.auth!.tenantId! }, select: { id: true, name: true } }); const names = new Map(products.map(p => [p.id, p.name]));
    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, orders, totals: orderTotals._sum, paidExpenses: expenses._sum.amount ?? 0, paymentsByMethod: paymentMethods, bestSellers: popularItems.map(x => ({ productId: x.productId, name: names.get(x.productId) ?? 'Produto removido', quantity: x._sum.quantity?.toNumber() ?? null, sales: x._sum.total })) });
  } catch (error) { return next(error); }
});
// Completed sales and service fee per attendant, the base for tip/commission distribution rules defined by the restaurant.
reportsRoutes.get('/waiters', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const scope = { tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const rows = await prisma.order.groupBy({ by: ['createdByUserId'], where: { ...scope, status: 'COMPLETED', createdAt: { gte: from, lte: to } }, _sum: { subtotal: true, serviceFee: true, total: true }, _count: true });
    const users = await prisma.user.findMany({ where: { id: { in: rows.flatMap(row => row.createdByUserId ? [row.createdByUserId] : []) }, tenantId: req.auth!.tenantId! }, select: { id: true, name: true } });
    const names = new Map(users.map(user => [user.id, user.name]));
    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items: rows.map(row => ({ userId: row.createdByUserId, name: row.createdByUserId ? names.get(row.createdByUserId) ?? 'Usuário removido' : 'Autoatendimento / sem atendente', orders: row._count, sales: row._sum.subtotal, serviceFee: row._sum.serviceFee, total: row._sum.total })) });
  } catch (error) { return next(error); }
});

// Splits the service fee collected per attendant using the unit's waiter share; the remainder is the pool the restaurant distributes by its own rules.
reportsRoutes.get('/service-fee-distribution', async (req, res, next) => {
  try {
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : new Date();
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const tenantId = req.auth!.tenantId!;
    const scope = { tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}) };
    const rows = await prisma.order.groupBy({ by: ['createdByUserId', 'unitId'], where: { ...scope, status: 'COMPLETED', createdAt: { gte: from, lte: to } }, _sum: { subtotal: true, serviceFee: true } });
    const [units, users] = await Promise.all([
      prisma.unit.findMany({ where: { tenantId }, select: { id: true, waiterSharePercent: true } }),
      prisma.user.findMany({ where: { tenantId, id: { in: rows.flatMap(row => row.createdByUserId ? [row.createdByUserId] : []) } }, select: { id: true, name: true, commissionPercent: true } }),
    ]);
    const share = new Map(units.map(unit => [unit.id, unit.waiterSharePercent])); const people = new Map(users.map(user => [user.id, user]));
    const byUser = new Map<string, { userId: string | null; name: string; serviceFeeCollected: Prisma.Decimal; waiterAmount: Prisma.Decimal; poolAmount: Prisma.Decimal; commission: Prisma.Decimal }>();
    for (const row of rows) {
      const key = row.createdByUserId ?? 'none'; const person = row.createdByUserId ? people.get(row.createdByUserId) : undefined;
      const fee = row._sum.serviceFee ?? new Prisma.Decimal(0); const percent = row.unitId ? share.get(row.unitId) ?? new Prisma.Decimal(100) : new Prisma.Decimal(100);
      const waiterAmount = row.createdByUserId ? fee.mul(percent).div(100).toDecimalPlaces(2) : new Prisma.Decimal(0);
      const entry = byUser.get(key) ?? { userId: row.createdByUserId, name: person?.name ?? 'Autoatendimento / sem atendente', serviceFeeCollected: new Prisma.Decimal(0), waiterAmount: new Prisma.Decimal(0), poolAmount: new Prisma.Decimal(0), commission: new Prisma.Decimal(0) };
      entry.serviceFeeCollected = entry.serviceFeeCollected.add(fee); entry.waiterAmount = entry.waiterAmount.add(waiterAmount); entry.poolAmount = entry.poolAmount.add(fee.sub(waiterAmount));
      entry.commission = entry.commission.add((row._sum.subtotal ?? new Prisma.Decimal(0)).mul(person?.commissionPercent ?? 0).div(100).toDecimalPlaces(2));
      byUser.set(key, entry);
    }
    const items = [...byUser.values()];
    const sum = (pick: (item: (typeof items)[number]) => Prisma.Decimal) => items.reduce((total, item) => total.add(pick(item)), new Prisma.Decimal(0));
    return res.json({ period: { from: from.toISOString(), to: to.toISOString() }, items, totals: { serviceFeeCollected: sum(item => item.serviceFeeCollected), waiterAmount: sum(item => item.waiterAmount), poolAmount: sum(item => item.poolAmount), commission: sum(item => item.commission) } });
  } catch (error) { return next(error); }
});


// Renders a table the screen already composed (e.g. service-fee distribution) as Excel/PDF/CSV, so every export uses the same writers and company header.
const renderSchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']),
  title: z.string().trim().min(1).max(80),
  period: z.object({ from: z.string().max(40), to: z.string().max(40) }),
  columns: z.array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), type: z.enum(['text', 'money', 'number', 'percent', 'datetime']) })).min(1).max(30),
  rows: z.array(z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()]))).max(5000),
  totals: z.record(z.string(), z.union([z.string().max(500), z.number(), z.null()])).optional(),
});
reportsRoutes.post('/render', async (req, res, next) => {
  try {
    const parsed = renderSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Invalid report table' });
    const from = new Date(parsed.data.period.from); const to = new Date(parsed.data.period.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return res.status(400).json({ message: 'Invalid date range' });
    const settings = await loadSettings(prisma, req.auth!.tenantId!);
    const company = settings.company;
    const headerLines = settings.printing.companyHeaderOnReports ? [company.tradeName || company.legalName, company.document].filter(Boolean) : [];
    const report = finalizeReport('render', { from, to }, { columns: parsed.data.columns, rows: parsed.data.rows, ...(parsed.data.totals ? { totals: parsed.data.totals } : {}) });
    const tz = settings.hours.timezone;
    res.setHeader('Content-Type', EXPORT_FORMATS[parsed.data.format]);
    res.setHeader('Content-Disposition', `attachment; filename="relatorio.${parsed.data.format}"`);
    if (parsed.data.format === 'csv') return res.send(reportToCsv(report, tz));
    const options = { timeZone: tz, title: parsed.data.title, headerLines };
    return res.send(parsed.data.format === 'xlsx' ? reportToXlsx(report, options) : reportToPdf(report, options));
  } catch (error) { return next(error); }
});
