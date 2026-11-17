import { Router } from 'express';
import { CampaignAudience, CampaignStatus, CatalogStatus, DiscountType, ModuleBilling, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { invalidateBlockedModules } from '../lib/licensing';
import { isFeatureLinked } from '../lib/module-catalog';
import { addonRecurringCents, fromCents, monthlyRecurringCents, PERIOD_MONTHS } from '../lib/commercial';
import { requireAuth, requireMaster } from '../middleware/auth';

export const commercialRoutes = Router();
commercialRoutes.use(requireAuth, requireMaster);

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const audit = (req: { auth?: { userId: string } }, action: string, entityType: string, entityId: string | null, metadata: unknown, tenantId: string | null = null) =>
  prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, tenantId, action, entityType, entityId, metadata: json(metadata) } });
const dec = (value: number | null | undefined) => (value === null || value === undefined ? null : new Prisma.Decimal(value));
const money = z.number().min(0).max(10000000);
const date = z.string().datetime();
const optionalDate = date.nullable().optional();

// ---------- Module catalog ----------
const moduleSchema = z.object({
  key: z.string().regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/).max(60),
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  category: z.string().min(2).max(60).default('Geral'),
  icon: z.string().max(8).nullable().optional(),
  billing: z.nativeEnum(ModuleBilling).default('MONTHLY'),
  monthlyPrice: money.default(0), annualPrice: money.default(0), oneTimePrice: money.default(0),
  promoPrice: money.nullable().optional(), promoStartsAt: optionalDate, promoEndsAt: optionalDate,
  standalone: z.boolean().default(true),
  dependsOn: z.array(z.string().max(60)).max(20).default([]),
  status: z.nativeEnum(CatalogStatus).default('ACTIVE'),
  reason: z.string().max(300).optional(),
});

async function presentModules() {
  const [items, planLinks, tenantLinks] = await Promise.all([
    prisma.saaSModule.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }] }),
    prisma.planModule.findMany({ select: { moduleKey: true, optional: true, plan: { select: { id: true, name: true } } } }),
    prisma.tenantModule.groupBy({ by: ['moduleKey'], _count: { _all: true } }),
  ]);
  return items.map(item => ({
    ...item,
    featureLinked: isFeatureLinked(item.key),
    plans: planLinks.filter(link => link.moduleKey === item.key).map(link => ({ id: link.plan.id, name: link.plan.name, optional: link.optional })),
    tenants: tenantLinks.find(link => link.moduleKey === item.key)?._count._all ?? 0,
  }));
}

function moduleFields(input: z.infer<typeof moduleSchema>) {
  const { reason: _reason, ...fields } = input;
  return {
    ...fields, description: fields.description ?? null, icon: fields.icon ?? null,
    monthlyPrice: new Prisma.Decimal(fields.monthlyPrice), annualPrice: new Prisma.Decimal(fields.annualPrice), oneTimePrice: new Prisma.Decimal(fields.oneTimePrice),
    promoPrice: dec(fields.promoPrice), promoStartsAt: fields.promoStartsAt ? new Date(fields.promoStartsAt) : null, promoEndsAt: fields.promoEndsAt ? new Date(fields.promoEndsAt) : null,
    dependsOn: [...new Set(fields.dependsOn.filter(key => key !== fields.key))],
  };
}

async function dependencyProblem(keys: string[]) {
  if (keys.length === 0) return null;
  const found = await prisma.saaSModule.findMany({ where: { key: { in: keys } }, select: { key: true } });
  const missing = keys.filter(key => !found.some(item => item.key === key));
  return missing.length ? `Dependência inexistente no catálogo: ${missing.join(', ')}` : null;
}

commercialRoutes.get('/modules', async (_req, res, next) => {
  try { const items = await presentModules(); return res.json({ items, total: items.length }); } catch (error) { return next(error); }
});

commercialRoutes.post('/modules', async (req, res, next) => {
  try {
    const parsed = moduleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const data = moduleFields(parsed.data);
    const problem = await dependencyProblem(data.dependsOn);
    if (problem) return res.status(400).json({ message: problem });
    const item = await prisma.saaSModule.create({ data });
    await audit(req, 'SAAS_MODULE_CREATED', 'SaaSModule', item.id, { key: item.key, linked: isFeatureLinked(item.key), reason: parsed.data.reason ?? null });
    return res.status(201).json({ ...item, featureLinked: isFeatureLinked(item.key) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um módulo com esta chave' });
    return next(error);
  }
});

commercialRoutes.put('/modules/:id', async (req, res, next) => {
  try {
    const parsed = moduleSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.saaSModule.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Module not found' });
    if (parsed.data.key !== current.key) return res.status(400).json({ message: 'A chave técnica do módulo não pode ser alterada' });
    const data = moduleFields(parsed.data);
    const problem = await dependencyProblem(data.dependsOn);
    if (problem) return res.status(400).json({ message: problem });
    const { key: _key, ...update } = data;
    const item = await prisma.saaSModule.update({ where: { id: current.id }, data: update });
    await audit(req, 'SAAS_MODULE_UPDATED', 'SaaSModule', item.id, {
      key: item.key, reason: parsed.data.reason ?? null,
      before: { monthlyPrice: current.monthlyPrice, annualPrice: current.annualPrice, oneTimePrice: current.oneTimePrice, promoPrice: current.promoPrice, billing: current.billing, status: current.status },
      after: { monthlyPrice: item.monthlyPrice, annualPrice: item.annualPrice, oneTimePrice: item.oneTimePrice, promoPrice: item.promoPrice, billing: item.billing, status: item.status },
    });
    invalidateBlockedModules();
    return res.json({ ...item, featureLinked: isFeatureLinked(item.key) });
  } catch (error) { return next(error); }
});

// BLOCK/UNBLOCK change access for every tenant at once (enforced by requireAuth); ACTIVATE/DEACTIVATE/ARCHIVE only affect new contracts.
commercialRoutes.patch('/modules/:id/state', async (req, res, next) => {
  try {
    const input = z.object({ action: z.enum(['BLOCK', 'UNBLOCK', 'ACTIVATE', 'DEACTIVATE', 'ARCHIVE']), reason: z.string().min(3).max(300) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Informe a ação e o motivo (mínimo de 3 caracteres)' });
    const current = await prisma.saaSModule.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Module not found' });
    const patch = { BLOCK: { blocked: true }, UNBLOCK: { blocked: false }, ACTIVATE: { status: CatalogStatus.ACTIVE }, DEACTIVATE: { status: CatalogStatus.INACTIVE }, ARCHIVE: { status: CatalogStatus.ARCHIVED } }[input.data.action];
    const item = await prisma.saaSModule.update({ where: { id: current.id }, data: patch });
    await audit(req, `SAAS_MODULE_${input.data.action}`, 'SaaSModule', item.id, { key: item.key, reason: input.data.reason, before: { blocked: current.blocked, status: current.status }, after: { blocked: item.blocked, status: item.status } });
    invalidateBlockedModules();
    return res.json({ ...item, featureLinked: isFeatureLinked(item.key) });
  } catch (error) { return next(error); }
});

// ---------- Campaigns ----------
const campaignSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  discountType: z.nativeEnum(DiscountType),
  discountValue: money,
  planIds: z.array(z.string().uuid()).max(50).default([]),
  moduleKeys: z.array(z.string().max(60)).max(50).default([]),
  startsAt: date, endsAt: date,
  maxUses: z.number().int().min(1).nullable().optional(),
  perTenantLimit: z.number().int().min(1).nullable().optional(),
  audience: z.nativeEnum(CampaignAudience).default('BOTH'),
  cycles: z.number().int().min(1).max(60).default(1),
  conditions: z.string().max(1000).nullable().optional(),
}).refine(value => new Date(value.endsAt) > new Date(value.startsAt), { message: 'O término deve ser posterior ao início', path: ['endsAt'] })
  .refine(value => value.discountType !== 'PERCENT' || value.discountValue <= 100, { message: 'Percentual máximo é 100', path: ['discountValue'] });

export function campaignPhase(status: CampaignStatus, startsAt: Date, endsAt: Date, now = new Date()) {
  if (status !== 'ACTIVE') return status;
  if (now < startsAt) return 'SCHEDULED';
  return now > endsAt ? 'ENDED' : 'ACTIVE';
}
const campaignData = (input: z.infer<typeof campaignSchema>) => ({
  ...input, description: input.description ?? null, conditions: input.conditions ?? null, maxUses: input.maxUses ?? null, perTenantLimit: input.perTenantLimit ?? null,
  discountValue: new Prisma.Decimal(input.discountValue), startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt),
});

commercialRoutes.get('/campaigns', async (_req, res, next) => {
  try {
    const [items, uses] = await Promise.all([
      prisma.saaSCampaign.findMany({ orderBy: { startsAt: 'desc' } }),
      prisma.saaSCouponRedemption.groupBy({ by: ['campaignId'], where: { campaignId: { not: null } }, _count: { _all: true }, _sum: { amount: true } }),
    ]);
    return res.json({ items: items.map(item => ({ ...item, phase: campaignPhase(item.status, item.startsAt, item.endsAt), uses: uses.find(use => use.campaignId === item.id)?._count._all ?? 0, discountGiven: uses.find(use => use.campaignId === item.id)?._sum.amount ?? 0 })) });
  } catch (error) { return next(error); }
});
commercialRoutes.post('/campaigns', async (req, res, next) => {
  try {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const item = await prisma.saaSCampaign.create({ data: campaignData(parsed.data) });
    await audit(req, 'SAAS_CAMPAIGN_CREATED', 'SaaSCampaign', item.id, { name: item.name, discountType: item.discountType, discountValue: item.discountValue });
    return res.status(201).json(item);
  } catch (error) { return next(error); }
});
commercialRoutes.put('/campaigns/:id', async (req, res, next) => {
  try {
    const parsed = campaignSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.saaSCampaign.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Campaign not found' });
    const item = await prisma.saaSCampaign.update({ where: { id: current.id }, data: campaignData(parsed.data) });
    await audit(req, 'SAAS_CAMPAIGN_UPDATED', 'SaaSCampaign', item.id, { before: { discountValue: current.discountValue, startsAt: current.startsAt, endsAt: current.endsAt }, after: { discountValue: item.discountValue, startsAt: item.startsAt, endsAt: item.endsAt } });
    return res.json(item);
  } catch (error) { return next(error); }
});
commercialRoutes.patch('/campaigns/:id/status', async (req, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(CampaignStatus), reason: z.string().max(300).optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed' });
    const current = await prisma.saaSCampaign.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Campaign not found' });
    const item = await prisma.saaSCampaign.update({ where: { id: current.id }, data: { status: input.data.status } });
    await audit(req, input.data.status === 'CANCELLED' ? 'SAAS_CAMPAIGN_CLOSED' : 'SAAS_CAMPAIGN_STATUS_CHANGED', 'SaaSCampaign', item.id, { before: current.status, after: item.status, reason: input.data.reason ?? null });
    return res.json(item);
  } catch (error) { return next(error); }
});

// ---------- Coupons ----------
const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/, 'Use de 3 a 40 letras, números, - ou _'),
  name: z.string().min(2).max(120),
  description: z.string().max(500).nullable().optional(),
  discountType: z.nativeEnum(DiscountType),
  discountValue: money,
  planIds: z.array(z.string().uuid()).max(50).default([]),
  moduleKeys: z.array(z.string().max(60)).max(50).default([]),
  startsAt: optionalDate, validUntil: optionalDate,
  maxUses: z.number().int().min(1).nullable().optional(),
  perTenantLimit: z.number().int().min(1).nullable().optional(),
  audience: z.nativeEnum(CampaignAudience).default('BOTH'),
  cycles: z.number().int().min(1).max(60).default(1),
  minAmount: money.nullable().optional(),
  status: z.nativeEnum(CatalogStatus).default('ACTIVE'),
}).refine(value => value.discountType !== 'PERCENT' || value.discountValue <= 100, { message: 'Percentual máximo é 100', path: ['discountValue'] })
  .refine(value => !value.startsAt || !value.validUntil || new Date(value.validUntil) > new Date(value.startsAt), { message: 'A validade deve ser posterior ao início', path: ['validUntil'] });
const couponData = (input: z.infer<typeof couponSchema>) => ({
  ...input, description: input.description ?? null, maxUses: input.maxUses ?? null, perTenantLimit: input.perTenantLimit ?? null,
  discountValue: new Prisma.Decimal(input.discountValue), minAmount: dec(input.minAmount),
  startsAt: input.startsAt ? new Date(input.startsAt) : null, validUntil: input.validUntil ? new Date(input.validUntil) : null,
});

commercialRoutes.get('/coupons', async (_req, res, next) => {
  try {
    const [items, uses] = await Promise.all([
      prisma.saaSCoupon.findMany({ orderBy: { createdAt: 'desc' } }),
      prisma.saaSCouponRedemption.groupBy({ by: ['couponId'], where: { couponId: { not: null } }, _count: { _all: true }, _sum: { amount: true } }),
    ]);
    return res.json({ items: items.map(item => ({ ...item, uses: uses.find(use => use.couponId === item.id)?._count._all ?? 0, discountGiven: uses.find(use => use.couponId === item.id)?._sum.amount ?? 0 })) });
  } catch (error) { return next(error); }
});
commercialRoutes.post('/coupons', async (req, res, next) => {
  try {
    const parsed = couponSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const item = await prisma.saaSCoupon.create({ data: couponData(parsed.data) });
    await audit(req, 'SAAS_COUPON_CREATED', 'SaaSCoupon', item.id, { code: item.code, discountType: item.discountType, discountValue: item.discountValue });
    return res.status(201).json(item);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um cupom com este código' });
    return next(error);
  }
});
commercialRoutes.put('/coupons/:id', async (req, res, next) => {
  try {
    const parsed = couponSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.saaSCoupon.findUnique({ where: { id: req.params.id } });
    if (!current) return res.status(404).json({ message: 'Coupon not found' });
    const { code: _code, ...update } = couponData(parsed.data);
    const item = await prisma.saaSCoupon.update({ where: { id: current.id }, data: update });
    await audit(req, 'SAAS_COUPON_UPDATED', 'SaaSCoupon', item.id, { code: item.code, before: { discountValue: current.discountValue, validUntil: current.validUntil, status: current.status }, after: { discountValue: item.discountValue, validUntil: item.validUntil, status: item.status } });
    return res.json(item);
  } catch (error) { return next(error); }
});
commercialRoutes.get('/coupons/:id/redemptions', async (req, res, next) => {
  try {
    const items = await prisma.saaSCouponRedemption.findMany({
      where: { couponId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, amount: true, createdAt: true, tenant: { select: { id: true, name: true } }, invoice: { select: { id: true, seq: true, reference: true, status: true } } },
    });
    return res.json({ items });
  } catch (error) { return next(error); }
});

// ---------- History ----------
commercialRoutes.get('/history', async (req, res, next) => {
  try {
    const query = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(30), tenantId: z.string().uuid().optional(), prefix: z.string().max(30).optional() }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters' });
    const { page, pageSize, tenantId, prefix } = query.data;
    const where: Prisma.AuditLogWhereInput = {
      OR: [{ action: { startsWith: 'SAAS_' } }, { action: { startsWith: 'SUBSCRIPTION_' } }, { action: { startsWith: 'LICENSE_' } }, { action: { startsWith: 'TENANT_' } }, { action: { startsWith: 'ADDON_' } }],
      ...(tenantId ? { tenantId } : {}), ...(prefix ? { action: { startsWith: prefix } } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize, select: { id: true, action: true, entityType: true, entityId: true, metadata: true, createdAt: true, tenant: { select: { id: true, name: true } }, actor: { select: { id: true, name: true } } } }),
      prisma.auditLog.count({ where }),
    ]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});

// ---------- Commercial dashboard ----------
commercialRoutes.get('/overview', async (req, res, next) => {
  try {
    const query = z.object({ from: date.optional(), to: date.optional(), planId: z.string().uuid().optional() }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ message: 'Invalid filters' });
    const now = new Date();
    const from = query.data.from ? new Date(query.data.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = query.data.to ? new Date(query.data.to) : now;
    const planFilter = query.data.planId ? { planId: query.data.planId } : {};
    const sixMonthsAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));

    const [tenantStatus, licenses, addonGrants, catalog, plans, invoices, evolutionInvoices, overdueTenants, campaigns, coupons, redemptions, planModules] = await Promise.all([
      prisma.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.tenantLicense.findMany({ where: planFilter, select: { tenantId: true, status: true, validUntil: true, graceDays: true, planId: true, contractedPrice: true, billingPeriod: true, discountPercent: true, createdAt: true, updatedAt: true } }),
      prisma.tenantModule.findMany({ where: { source: 'ADDON', blocked: false, free: false }, select: { tenantId: true, moduleKey: true, unitPrice: true, discountPercent: true, startsAt: true, endsAt: true } }),
      prisma.saaSModule.findMany(),
      prisma.saaSPlan.findMany({ select: { id: true, name: true, status: true } }),
      prisma.saaSInvoice.findMany({ where: { ...planFilter, OR: [{ createdAt: { gte: from, lte: to } }, { paidAt: { gte: from, lte: to } }] }, select: { status: true, total: true, discount: true, dueDate: true, paidAt: true, createdAt: true, planId: true, items: true } }),
      prisma.saaSInvoice.findMany({ where: { status: 'PAID', paidAt: { gte: sixMonthsAgo } }, select: { total: true, paidAt: true } }),
      prisma.saaSInvoice.findMany({ where: { status: 'OPEN', dueDate: { lt: now } }, distinct: ['tenantId'], select: { tenantId: true } }),
      prisma.saaSCampaign.findMany({ select: { status: true, startsAt: true, endsAt: true } }),
      prisma.saaSCoupon.count({ where: { status: 'ACTIVE' } }),
      prisma.saaSCouponRedemption.groupBy({ by: ['couponId', 'campaignId'], _count: { _all: true }, _sum: { amount: true } }),
      prisma.planModule.findMany({ select: { planId: true, moduleKey: true, optional: true, priceOverride: true } }),
    ]);

    const active = licenses.filter(item => item.status === 'ACTIVE');
    const lapsed = (item: (typeof licenses)[number]) => item.validUntil !== null && item.validUntil.getTime() + item.graceDays * 86_400_000 < now.getTime();
    const planCents = new Map<string, number>();
    let mrrCents = 0;
    const activeTenantIds = new Set(active.map(item => item.tenantId));
    for (const license of active) {
      const cents = monthlyRecurringCents(license.contractedPrice, license.billingPeriod, license.discountPercent);
      mrrCents += cents;
      if (license.planId) planCents.set(license.planId, (planCents.get(license.planId) ?? 0) + cents);
    }
    const moduleRevenueCents = new Map<string, number>();
    for (const grant of addonGrants) {
      if (!activeTenantIds.has(grant.tenantId)) continue;
      const catalogModule = catalog.find(item => item.key === grant.moduleKey);
      const license = active.find(item => item.tenantId === grant.tenantId);
      if (!catalogModule || !license) continue;
      const planLinks = planModules.filter(item => item.planId === license.planId && item.moduleKey === grant.moduleKey);
      if (planLinks.some(item => !item.optional)) continue;
      const override = planLinks.find(item => item.optional)?.priceOverride;
      const cents = addonRecurringCents({ ...grant, unitPrice: grant.unitPrice ?? override }, catalogModule, license.billingPeriod ?? 'MONTHLY', now) / PERIOD_MONTHS[license.billingPeriod ?? 'MONTHLY'];
      mrrCents += cents;
      moduleRevenueCents.set(grant.moduleKey, (moduleRevenueCents.get(grant.moduleKey) ?? 0) + cents);
    }

    const sum = (rows: { total: Prisma.Decimal }[]) => rows.reduce((acc, row) => acc + Number(row.total), 0);
    const inRange = (value: Date | null) => value !== null && value >= from && value <= to;
    const issued = invoices.filter(item => item.status !== 'CANCELLED' && inRange(item.createdAt));
    const received = invoices.filter(item => item.status === 'PAID' && inRange(item.paidAt));
    const open = invoices.filter(item => item.status === 'OPEN');
    const overdue = open.filter(item => item.dueDate < now);

    const evolution = Array.from({ length: 6 }, (_, index) => {
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + index, 1));
      const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      return { month: start.toISOString().slice(0, 7), received: sum(evolutionInvoices.filter(item => item.paidAt && item.paidAt >= start && item.paidAt < end)) };
    });

    const moduleCounts = await prisma.tenantModule.groupBy({ by: ['moduleKey'], where: { blocked: false }, _count: { _all: true } });
    const status = (key: string) => tenantStatus.find(item => item.status === key)?._count._all ?? 0;
    return res.json({
      range: { from, to },
      clients: { total: tenantStatus.reduce((acc, item) => acc + item._count._all, 0), active: status('ACTIVE'), trial: status('TRIAL'), suspended: status('SUSPENDED') + status('BLOCKED'), delinquent: overdueTenants.length },
      subscriptions: { active: active.filter(item => !lapsed(item)).length, expired: licenses.filter(item => item.status === 'ACTIVE' && lapsed(item)).length, suspended: licenses.filter(item => item.status === 'SUSPENDED').length, pending: licenses.filter(item => item.status === 'PENDING').length, cancelled: licenses.filter(item => ['CANCELLED', 'REVOKED'].includes(item.status) && inRange(item.updatedAt)).length, created: licenses.filter(item => inRange(item.createdAt)).length },
      revenue: { mrr: fromCents(mrrCents), arr: fromCents(mrrCents * 12), issued: sum(issued), received: sum(received), open: sum(open), overdue: sum(overdue), discounts: issued.reduce((acc, item) => acc + Number(item.discount), 0) },
      catalog: { plans: plans.length, modules: catalog.length, activeCampaigns: campaigns.filter(item => campaignPhase(item.status, item.startsAt, item.endsAt) === 'ACTIVE').length, activeCoupons: coupons, couponUses: redemptions.filter(item => item.couponId).reduce((acc, item) => acc + item._count._all, 0), campaignUses: redemptions.filter(item => item.campaignId).reduce((acc, item) => acc + item._count._all, 0) },
      byPlan: plans.map(plan => ({ id: plan.id, name: plan.name, subscriptions: active.filter(item => item.planId === plan.id).length, mrr: fromCents(planCents.get(plan.id) ?? 0), received: sum(received.filter(item => item.planId === plan.id)) })).sort((a, b) => b.subscriptions - a.subscriptions),
      byModule: catalog.map(item => ({ key: item.key, name: item.name, tenants: moduleCounts.find(count => count.moduleKey === item.key)?._count._all ?? 0, addonMrr: fromCents(moduleRevenueCents.get(item.key) ?? 0) })).sort((a, b) => b.tenants - a.tenants),
      evolution,
    });
  } catch (error) { return next(error); }
});

commercialRoutes.get('/reports/changes', async (_req, res, next) => {
  try {
    const items = await prisma.auditLog.findMany({ where: { action: 'SUBSCRIPTION_PLAN_CHANGED' }, orderBy: { createdAt: 'desc' }, take: 200, select: { id: true, createdAt: true, metadata: true, tenant: { select: { id: true, name: true } }, actor: { select: { name: true } } } });
    return res.json({ items });
  } catch (error) { return next(error); }
});
