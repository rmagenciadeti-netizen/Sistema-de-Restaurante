import { Router } from 'express';
import { BillingPeriod, CatalogStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { moduleSetProblem } from '../lib/module-catalog';
import { requireAuth, requireMaster } from '../middleware/auth';

export const planRoutes = Router();
planRoutes.use(requireAuth, requireMaster);

const money = z.number().min(0).max(10000000);
const priceSchema = z.object({ period: z.nativeEnum(BillingPeriod), amount: money });
const optionalSchema = z.object({ key: z.string().min(1).max(80), priceOverride: money.nullable().optional() });
const planSchema = z.object({
  key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  name: z.string().min(2).max(120),
  description: z.string().max(1000).nullable().optional(),
  headline: z.string().max(200).nullable().optional(),
  benefits: z.array(z.string().min(1).max(160)).max(30).default([]),
  highlight: z.string().max(40).nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999).default(0),
  status: z.nativeEnum(CatalogStatus).optional(),
  active: z.boolean().optional(),
  trialDays: z.number().int().min(0).max(365).default(0),
  maxUnits: z.number().int().min(1).nullable().optional(),
  maxUsers: z.number().int().min(1).nullable().optional(),
  activationFee: money.default(0),
  setupFee: money.default(0),
  originalPrice: money.nullable().optional(),
  promoPrice: money.nullable().optional(),
  conditions: z.string().max(1000).nullable().optional(),
  modules: z.array(z.string().min(1).max(80)).max(100),
  optionalModules: z.array(optionalSchema).max(100).default([]),
  prices: z.array(priceSchema).max(4),
  reason: z.string().max(300).optional(),
}).superRefine((value, context) => {
  const periods = value.prices.map(price => price.period);
  if (new Set(periods).size !== periods.length) context.addIssue({ code: 'custom', path: ['prices'], message: 'Each billing period may be configured only once' });
  const optionalKeys = value.optionalModules.map(item => item.key);
  if (new Set(optionalKeys).size !== optionalKeys.length || optionalKeys.some(key => value.modules.includes(key))) context.addIssue({ code: 'custom', path: ['optionalModules'], message: 'Um módulo não pode ser incluído e opcional ao mesmo tempo' });
});

const planInclude = { modules: { select: { moduleKey: true, optional: true, priceOverride: true } }, prices: { orderBy: { period: 'asc' as const } }, _count: { select: { licenses: true, invoices: true } } };
type PlanWithRelations = Prisma.SaaSPlanGetPayload<{ include: typeof planInclude }>;
const present = ({ modules, ...plan }: PlanWithRelations) => ({
  ...plan,
  modules: modules.filter(item => !item.optional).map(item => item.moduleKey),
  optionalModules: modules.filter(item => item.optional).map(item => ({ key: item.moduleKey, priceOverride: item.priceOverride })),
});
const snapshot = (plan: PlanWithRelations) => ({
  name: plan.name, status: plan.status, trialDays: plan.trialDays, maxUnits: plan.maxUnits, maxUsers: plan.maxUsers,
  originalPrice: plan.originalPrice, promoPrice: plan.promoPrice, activationFee: plan.activationFee, setupFee: plan.setupFee,
  prices: plan.prices.map(price => ({ period: price.period, amount: price.amount })),
  modules: plan.modules.filter(item => !item.optional).map(item => item.moduleKey).sort(),
  optionalModules: plan.modules.filter(item => item.optional).map(item => item.moduleKey).sort(),
});

function planData(input: z.infer<typeof planSchema>) {
  const { modules, optionalModules, prices, reason: _reason, status, active, ...fields } = input;
  const nextStatus = status ?? (active === false ? CatalogStatus.INACTIVE : CatalogStatus.ACTIVE);
  return {
    scalars: {
      ...fields, status: nextStatus, active: nextStatus === CatalogStatus.ACTIVE,
      description: fields.description ?? null, headline: fields.headline ?? null, highlight: fields.highlight ?? null, conditions: fields.conditions ?? null,
      maxUnits: fields.maxUnits ?? null, maxUsers: fields.maxUsers ?? null,
      originalPrice: fields.originalPrice == null ? null : new Prisma.Decimal(fields.originalPrice),
      promoPrice: fields.promoPrice == null ? null : new Prisma.Decimal(fields.promoPrice),
      activationFee: new Prisma.Decimal(fields.activationFee), setupFee: new Prisma.Decimal(fields.setupFee),
    },
    moduleRows: [
      ...[...new Set(modules)].map(moduleKey => ({ moduleKey, optional: false, priceOverride: null })),
      ...optionalModules.map(item => ({ moduleKey: item.key, optional: true, priceOverride: item.priceOverride == null ? null : new Prisma.Decimal(item.priceOverride) })),
    ],
    priceRows: prices.map(price => ({ period: price.period, amount: new Prisma.Decimal(price.amount) })),
    allKeys: [...new Set([...modules, ...optionalModules.map(item => item.key)])],
    modules,
  };
}

// Draft plans may be saved incomplete; anything published (ACTIVE) must have a coherent module set and at least one price.
async function publishProblem(input: z.infer<typeof planSchema>, data: ReturnType<typeof planData>) {
  const included = await moduleSetProblem(data.modules);
  if (included) return included;
  const optional = await prisma.saaSModule.findMany({ where: { key: { in: data.allKeys } }, select: { key: true } });
  const missing = data.allKeys.filter(key => !optional.some(item => item.key === key));
  if (missing.length > 0) return `Módulo inexistente no catálogo: ${missing.join(', ')}`;
  if (data.scalars.status === CatalogStatus.ACTIVE && input.prices.length === 0) return 'Defina ao menos um preço antes de publicar o plano';
  return null;
}

planRoutes.get('/', async (_req, res, next) => {
  try {
    const items = await prisma.saaSPlan.findMany({ include: planInclude, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] });
    return res.json({ items: items.map(present), total: items.length });
  } catch (error) { return next(error); }
});

planRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const data = planData(parsed.data);
    const problem = await publishProblem(parsed.data, data);
    if (problem) return res.status(400).json({ message: problem });
    const item = await prisma.$transaction(async tx => {
      const created = await tx.saaSPlan.create({ data: { ...data.scalars, modules: { create: data.moduleRows }, prices: { create: data.priceRows } }, include: planInclude });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_CREATED', entityType: 'SaaSPlan', entityId: created.id, metadata: JSON.parse(JSON.stringify({ after: snapshot(created), reason: parsed.data.reason ?? null })) } });
      return created;
    });
    return res.status(201).json(present(item));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um plano com esta chave' });
    return next(error);
  }
});

planRoutes.put('/:id', async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.saaSPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!current) return res.status(404).json({ message: 'Plan not found' });
    const data = planData(parsed.data);
    const problem = await publishProblem(parsed.data, data);
    if (problem) return res.status(400).json({ message: problem });
    // Contracts copy modules and prices when signed (TenantLicense/TenantModule), so editing a plan never removes rights already contracted.
    const updated = await prisma.$transaction(async tx => {
      const item = await tx.saaSPlan.update({
        where: { id: current.id },
        data: { ...data.scalars, modules: { deleteMany: {}, create: data.moduleRows }, prices: { deleteMany: {}, create: data.priceRows } },
        include: planInclude,
      });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_UPDATED', entityType: 'SaaSPlan', entityId: item.id, metadata: JSON.parse(JSON.stringify({ before: snapshot(current), after: snapshot(item), reason: parsed.data.reason ?? null })) } });
      return item;
    });
    return res.json(present(updated));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um plano com esta chave' });
    return next(error);
  }
});

// Plans with contracts or invoices are never deleted: they are deactivated for new sales or archived, preserving history.
planRoutes.patch('/:id/status', async (req, res, next) => {
  try {
    const input = z.object({ status: z.nativeEnum(CatalogStatus), reason: z.string().max(300).optional() }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const current = await prisma.saaSPlan.findUnique({ where: { id: req.params.id }, include: { prices: true } });
    if (!current) return res.status(404).json({ message: 'Plan not found' });
    if (input.data.status === CatalogStatus.ACTIVE && current.prices.length === 0) return res.status(400).json({ message: 'Defina ao menos um preço antes de publicar o plano' });
    const item = await prisma.$transaction(async tx => {
      const changed = await tx.saaSPlan.update({ where: { id: current.id }, data: { status: input.data.status, active: input.data.status === CatalogStatus.ACTIVE }, include: planInclude });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_STATUS_CHANGED', entityType: 'SaaSPlan', entityId: current.id, metadata: { before: current.status, after: input.data.status, reason: input.data.reason ?? null } } });
      return changed;
    });
    return res.json(present(item));
  } catch (error) { return next(error); }
});

planRoutes.post('/:id/duplicate', async (req, res, next) => {
  try {
    const input = z.object({ key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80), name: z.string().min(2).max(120) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const source = await prisma.saaSPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!source) return res.status(404).json({ message: 'Plan not found' });
    const duplicate = await prisma.saaSPlan.create({
      data: {
        key: input.data.key, name: input.data.name, description: source.description, headline: source.headline, benefits: source.benefits, conditions: source.conditions,
        active: false, status: CatalogStatus.DRAFT, trialDays: source.trialDays, displayOrder: source.displayOrder,
        maxUnits: source.maxUnits, maxUsers: source.maxUsers, activationFee: source.activationFee, setupFee: source.setupFee,
        originalPrice: source.originalPrice, promoPrice: source.promoPrice,
        modules: { create: source.modules.map(module => ({ moduleKey: module.moduleKey, optional: module.optional, priceOverride: module.priceOverride })) },
        prices: { create: source.prices.map(price => ({ period: price.period, amount: price.amount })) },
      },
      include: planInclude,
    });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_DUPLICATED', entityType: 'SaaSPlan', entityId: duplicate.id, metadata: { sourceId: source.id } } });
    return res.status(201).json(present(duplicate));
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um plano com esta chave' });
    return next(error);
  }
});
