import { Router } from 'express';
import { Prisma, UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { calculateCommissions } from '../lib/commissions';

// Staff commissions (section 15). Rules are managed by ADMIN/MANAGER; the statement needs the Financial permission.
export const commissionRoutes = Router();
commissionRoutes.use(requireAuth, requireTenant);

const money = z.number().min(0).max(100_000_000);
const ruleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['SALE_PERCENT', 'PRODUCT_PERCENT', 'GOAL_BONUS']),
  userId: z.string().uuid().nullable().optional(),
  role: z.nativeEnum(UserRole).refine(role => role !== UserRole.MASTER_ADMIN).nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  goalAmount: money.nullable().optional(),
  bonusAmount: money.nullable().optional(),
  active: z.boolean().default(true),
}).superRefine((rule, context) => {
  if (rule.kind !== 'GOAL_BONUS' && rule.percent == null) context.addIssue({ code: 'custom', path: ['percent'], message: 'Informe o percentual' });
  if (rule.kind === 'PRODUCT_PERCENT' && !rule.productId) context.addIssue({ code: 'custom', path: ['productId'], message: 'Informe o produto' });
  if (rule.kind === 'GOAL_BONUS' && (rule.goalAmount == null || rule.goalAmount <= 0 || rule.bonusAmount == null)) context.addIssue({ code: 'custom', path: ['goalAmount'], message: 'Informe a meta e o valor do bônus' });
});

const present = (rule: { percent: Prisma.Decimal | null; goalAmount: Prisma.Decimal | null; bonusAmount: Prisma.Decimal | null } & Record<string, unknown>) => ({ ...rule, percent: rule.percent === null ? null : Number(rule.percent), goalAmount: rule.goalAmount === null ? null : Number(rule.goalAmount), bonusAmount: rule.bonusAmount === null ? null : Number(rule.bonusAmount) });

// The person and the product named by a rule must belong to the caller's company.
async function scopeProblem(tenantId: string, rule: z.infer<typeof ruleSchema>) {
  if (rule.userId && !(await prisma.user.findFirst({ where: { id: rule.userId, tenantId }, select: { id: true } }))) return 'Colaborador não encontrado';
  if (rule.productId && !(await prisma.product.findFirst({ where: { id: rule.productId, tenantId }, select: { id: true } }))) return 'Produto não encontrado';
  return null;
}
const data = (rule: z.infer<typeof ruleSchema>) => ({
  name: rule.name, kind: rule.kind, userId: rule.userId ?? null, role: rule.role ?? null, productId: rule.kind === 'PRODUCT_PERCENT' ? rule.productId ?? null : null,
  percent: rule.kind === 'GOAL_BONUS' || rule.percent == null ? null : new Prisma.Decimal(rule.percent),
  goalAmount: rule.kind === 'GOAL_BONUS' && rule.goalAmount != null ? new Prisma.Decimal(rule.goalAmount) : null,
  bonusAmount: rule.kind === 'GOAL_BONUS' && rule.bonusAmount != null ? new Prisma.Decimal(rule.bonusAmount) : null,
  active: rule.active,
});

commissionRoutes.get('/rules', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const rows = await prisma.commissionRule.findMany({ where: { tenantId: req.auth!.tenantId! }, orderBy: { createdAt: 'asc' } });
    return res.json({ items: rows.map(present) });
  } catch (error) { return next(error); }
});

commissionRoutes.post('/rules', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const problem = await scopeProblem(req.auth!.tenantId!, parsed.data);
    if (problem) return res.status(400).json({ message: problem });
    const created = await prisma.commissionRule.create({ data: { tenantId: req.auth!.tenantId!, ...data(parsed.data) } });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'COMMISSION_RULE_CREATED', entityType: 'CommissionRule', entityId: created.id, metadata: { name: created.name, kind: created.kind } } });
    return res.status(201).json(present(created));
  } catch (error) { return next(error); }
});

commissionRoutes.put('/rules/:id', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const problem = await scopeProblem(req.auth!.tenantId!, parsed.data);
    if (problem) return res.status(400).json({ message: problem });
    const updated = await prisma.commissionRule.updateMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, data: data(parsed.data) });
    if (updated.count !== 1) return res.status(404).json({ message: 'Rule not found' });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'COMMISSION_RULE_UPDATED', entityType: 'CommissionRule', entityId: req.params.id, metadata: { name: parsed.data.name } } });
    return res.json(present(await prisma.commissionRule.findUniqueOrThrow({ where: { id: req.params.id } })));
  } catch (error) { return next(error); }
});

commissionRoutes.delete('/rules/:id', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const removed = await prisma.commissionRule.deleteMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } });
    if (removed.count !== 1) return res.status(404).json({ message: 'Rule not found' });
    await prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action: 'COMMISSION_RULE_DELETED', entityType: 'CommissionRule', entityId: req.params.id } });
    return res.status(204).end();
  } catch (error) { return next(error); }
});

async function computeStatement(tenantId: string, unitId: string | null, from: Date, to: Date) {
  const unit = unitId ? { unitId } : {};
  const [users, rules, items] = await Promise.all([
    prisma.user.findMany({ where: { tenantId, role: { not: UserRole.MASTER_ADMIN } }, select: { id: true, name: true, role: true, commissionPercent: true }, orderBy: { name: 'asc' } }),
    prisma.commissionRule.findMany({ where: { tenantId, active: true } }),
    prisma.orderItem.findMany({
      where: { parentItemId: null, status: { not: 'CANCELLED' }, order: { tenantId, ...unit, status: 'COMPLETED', createdAt: { gte: from, lte: to }, createdByUserId: { not: null } } },
      select: { productId: true, total: true, order: { select: { createdByUserId: true } } }, take: 200_000,
    }),
  ]);
  const lines = calculateCommissions(
    users.map(user => ({ ...user, commissionPercent: Number(user.commissionPercent) })),
    rules.map(rule => ({ ...rule, percent: rule.percent === null ? null : Number(rule.percent), goalAmount: rule.goalAmount === null ? null : Number(rule.goalAmount), bonusAmount: rule.bonusAmount === null ? null : Number(rule.bonusAmount) })),
    items.map(item => ({ userId: item.order.createdByUserId!, productId: item.productId, total: Number(item.total) })),
  ).filter(line => line.sales > 0 || line.goalBonus > 0);
  return { lines, totals: { sales: lines.reduce((sum, line) => sum + line.sales, 0), commission: Math.round(lines.reduce((sum, line) => sum + line.total, 0) * 100) / 100 } };
}
const periodSchema = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });
const periodOf = (query: z.infer<typeof periodSchema>) => ({ from: query.from ?? new Date(new Date().getFullYear(), new Date().getMonth(), 1), to: query.to ?? new Date() });

// Statement: only completed orders in the period and items that were not cancelled, so cancellations never generate commission.
commissionRoutes.get('/statement', requireRoles(...FINANCE_ROLES), async (req, res, next) => {
  try {
    const query = periodSchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid date range' });
    const { from, to } = periodOf(query.data);
    if (from > to) return res.status(400).json({ message: 'Invalid date range' });
    const result = await computeStatement(req.auth!.tenantId!, req.auth!.unitId, from, to);
    return res.json({ period: { from, to }, note: 'Considera apenas pedidos concluídos e itens não cancelados no período.', items: result.lines, totals: result.totals });
  } catch (error) { return next(error); }
});

// Closings cover the whole company, so people bound to a single unit cannot use them.
const companyWide = (req: { auth?: { unitId: string | null } }, res: { status: (code: number) => { json: (body: unknown) => unknown } }, next: () => void) => (req.auth!.unitId ? res.status(403).json({ message: 'Fechamento disponível apenas para quem não está vinculado a uma unidade' }) : next());

// Closing freezes the statement for payment. A later cancellation or refund never rewrites it: the live recalculation shows the difference as an adjustment.
commissionRoutes.post('/closings', requireRoles(...FINANCE_ROLES), companyWide, async (req, res, next) => {
  try {
    const query = z.object({ from: z.coerce.date(), to: z.coerce.date() }).safeParse(req.body);
    if (!query.success || query.data.from > query.data.to) return res.status(400).json({ message: 'Invalid date range' });
    const tenantId = req.auth!.tenantId!;
    const overlap = await prisma.commissionClosing.findFirst({ where: { tenantId, periodFrom: { lte: query.data.to }, periodTo: { gte: query.data.from } }, select: { id: true } });
    if (overlap) return res.status(409).json({ message: 'Já existe um fechamento que cobre parte deste período' });
    const result = await computeStatement(tenantId, null, query.data.from, query.data.to);
    const closing = await prisma.commissionClosing.create({ data: { tenantId, periodFrom: query.data.from, periodTo: query.data.to, lines: result.lines, total: result.totals.commission, closedById: req.auth!.userId } });
    await prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'COMMISSION_CLOSED', entityType: 'CommissionClosing', entityId: closing.id, metadata: { total: result.totals.commission } } });
    return res.status(201).json({ id: closing.id, total: result.totals.commission, lines: result.lines });
  } catch (error) { return next(error); }
});

commissionRoutes.get('/closings', requireRoles(...FINANCE_ROLES), companyWide, async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const rows = await prisma.commissionClosing.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 24 });
    const items = await Promise.all(rows.map(async row => {
      const live = await computeStatement(tenantId, null, row.periodFrom, row.periodTo);
      const closed = Number(row.total);
      return { id: row.id, periodFrom: row.periodFrom, periodTo: row.periodTo, createdAt: row.createdAt, closedTotal: closed, currentTotal: live.totals.commission, adjustment: Math.round((live.totals.commission - closed) * 100) / 100, lines: row.lines };
    }));
    return res.json({ items });
  } catch (error) { return next(error); }
});
