import { Router } from 'express';
import { FinancialEntryStatus, FinancialEntryType, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMaster, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES } from '../lib/permissions';

export const dashboardRoutes = Router();
dashboardRoutes.get('/master', requireAuth, requireMaster, async (_req, res, next) => {
  try {
    const [totalCompanies, activeCompanies, trialCompanies, suspendedCompanies, users, orders, products] = await Promise.all([
      prisma.tenant.count(), prisma.tenant.count({ where: { status: 'ACTIVE' } }), prisma.tenant.count({ where: { status: 'TRIAL' } }),
      prisma.tenant.count({ where: { status: { in: ['SUSPENDED', 'BLOCKED'] } } }), prisma.user.count(), prisma.order.count(), prisma.product.count(),
    ]);
    return res.json({ totalCompanies, activeCompanies, trialCompanies, suspendedCompanies, users, orders, products, note: 'Financial and infrastructure metrics require configured billing and monitoring integrations.' });
  } catch (error) { return next(error); }
});
dashboardRoutes.get('/restaurant', requireAuth, requireTenant, async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const unitId = req.auth!.unitId;
    const scope = { tenantId, ...(unitId ? { unitId } : {}) };
    const now = new Date();
    const today = new Date(now); today.setUTCHours(0, 0, 0, 0);
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const trendStart = new Date(today); trendStart.setUTCDate(trendStart.getUTCDate() - 6);
    const completed = { status: OrderStatus.COMPLETED };
    const notCancelled = { status: { not: OrderStatus.CANCELLED } };
    const open = { status: { in: [OrderStatus.OPEN, OrderStatus.PREPARING, OrderStatus.READY] } };
    const canViewFinancials = FINANCE_ROLES.includes(req.auth!.role);
    const [products, employees, orders, openOrders, dailyOrderCount, dailySales, monthlyOrderCount, monthlySales, activeTables, occupiedTables, salesTrend, openReceivables, openPayables, monthlyExpenses] = await Promise.all([
      prisma.product.count({ where: { ...scope, active: true } }),
      prisma.employee.count({ where: { ...scope, status: 'ACTIVE' } }),
      prisma.order.count({ where: scope }),
      prisma.order.count({ where: { ...scope, ...open } }),
      prisma.order.count({ where: { ...scope, ...notCancelled, createdAt: { gte: today, lte: now } } }),
      prisma.order.aggregate({ where: { ...scope, ...completed, createdAt: { gte: today, lte: now } }, _sum: { total: true }, _count: true }),
      prisma.order.count({ where: { ...scope, ...notCancelled, createdAt: { gte: month, lte: now } } }),
      prisma.order.aggregate({ where: { ...scope, ...completed, createdAt: { gte: month, lte: now } }, _sum: { total: true }, _count: true }),
      prisma.restaurantTable.count({ where: { tenantId, ...(unitId ? { unitId } : {}), active: true } }),
      prisma.order.findMany({ where: { ...scope, ...open, tableId: { not: null } }, distinct: ['tableId'], select: { tableId: true } }),
      prisma.$queryRaw<Array<{ day: Date; total: Prisma.Decimal }>>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, COALESCE(SUM(total), 0)::numeric AS total
        FROM "Order"
        WHERE "tenantId" = ${tenantId}
          AND (${unitId}::text IS NULL OR "unitId" = ${unitId}::text)
          AND status = ${OrderStatus.COMPLETED}::"OrderStatus"
          AND "createdAt" >= ${trendStart} AND "createdAt" <= ${now}
        GROUP BY date_trunc('day', "createdAt")
        ORDER BY day
      `),
      canViewFinancials ? prisma.financialEntry.aggregate({ where: { ...scope, type: FinancialEntryType.INCOME, status: FinancialEntryStatus.OPEN }, _sum: { amount: true } }) : Promise.resolve(null),
      canViewFinancials ? prisma.financialEntry.aggregate({ where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.OPEN }, _sum: { amount: true } }) : Promise.resolve(null),
      canViewFinancials ? prisma.financialEntry.aggregate({ where: { ...scope, type: FinancialEntryType.EXPENSE, status: FinancialEntryStatus.PAID, settledAt: { gte: month, lte: now } }, _sum: { amount: true } }) : Promise.resolve(null),
    ]);
    const dailyTotal = dailySales._sum.total ?? new Prisma.Decimal(0);
    const monthlyTotal = monthlySales._sum.total ?? new Prisma.Decimal(0);
    const monthlyExpenseTotal = monthlyExpenses?._sum.amount ?? new Prisma.Decimal(0);
    const trendByDay = new Map(salesTrend.map(point => [point.day.toISOString().slice(0, 10), point.total]));
    const completeTrend = Array.from({ length: 7 }, (_, index) => {
      const day = new Date(trendStart); day.setUTCDate(day.getUTCDate() + index);
      const key = day.toISOString().slice(0, 10);
      return { day: key, total: trendByDay.get(key) ?? new Prisma.Decimal(0) };
    });
    return res.json({
      products, employees, orders, openOrders,
      daily: { orders: dailyOrderCount, completedOrders: dailySales._count, sales: dailyTotal, averageTicket: dailySales._count ? dailyTotal.div(dailySales._count).toDecimalPlaces(2) : new Prisma.Decimal(0) },
      monthly: { orders: monthlyOrderCount, completedOrders: monthlySales._count, sales: monthlyTotal },
      tables: { active: activeTables, occupied: occupiedTables.length, available: Math.max(0, activeTables - occupiedTables.length) },
      financial: canViewFinancials ? {
        openReceivables: openReceivables?._sum.amount ?? new Prisma.Decimal(0),
        openPayables: openPayables?._sum.amount ?? new Prisma.Decimal(0),
        monthlyExpenses: monthlyExpenseTotal,
        estimatedOperatingBalance: monthlyTotal.sub(monthlyExpenseTotal),
      } : null,
      salesTrend: completeTrend,
      period: { day: today.toISOString(), month: month.toISOString(), through: now.toISOString() },
    });
  } catch (error) { return next(error); }
});
