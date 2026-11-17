import { Router } from 'express';
import { BillingPeriod, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { MODULE_KEYS } from '../lib/licensing';
import { requireAuth, requireMaster } from '../middleware/auth';

export const planRoutes = Router();
planRoutes.use(requireAuth, requireMaster);

const priceSchema = z.object({
  period: z.nativeEnum(BillingPeriod),
  amount: z.number().min(0).max(10000000),
});
const planSchema = z.object({
  key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  name: z.string().min(2).max(120),
  description: z.string().max(1000).nullable().optional(),
  active: z.boolean().default(true),
  trialDays: z.number().int().min(0).max(365).default(0),
  maxUnits: z.number().int().min(1).nullable().optional(),
  maxUsers: z.number().int().min(1).nullable().optional(),
  activationFee: z.number().min(0).max(10000000).default(0),
  setupFee: z.number().min(0).max(10000000).default(0),
  modules: z.array(z.enum(MODULE_KEYS)).max(MODULE_KEYS.length),
  prices: z.array(priceSchema).max(4),
}).superRefine((value, context) => {
  const periods = value.prices.map(price => price.period);
  if (new Set(periods).size !== periods.length) {
    context.addIssue({ code: 'custom', path: ['prices'], message: 'Each billing period may be configured only once' });
  }
});

const planInclude = { modules: { select: { moduleKey: true } }, prices: { orderBy: { period: 'asc' as const } } };

planRoutes.get('/', async (_req, res, next) => {
  try {
    const items = await prisma.saaSPlan.findMany({ include: planInclude, orderBy: [{ active: 'desc' }, { name: 'asc' }] });
    return res.json({ items: items.map(item => ({ ...item, modules: item.modules.map(module => module.moduleKey) })), total: items.length });
  } catch (error) { return next(error); }
});

planRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { modules, prices, ...fields } = parsed.data;
    const item = await prisma.saaSPlan.create({
      data: {
        ...fields,
        description: fields.description ?? null,
        maxUnits: fields.maxUnits ?? null,
        maxUsers: fields.maxUsers ?? null,
        activationFee: new Prisma.Decimal(fields.activationFee),
        setupFee: new Prisma.Decimal(fields.setupFee),
        modules: { create: [...new Set(modules)].map(moduleKey => ({ moduleKey })) },
        prices: { create: prices.map(price => ({ period: price.period, amount: new Prisma.Decimal(price.amount) })) },
      },
      include: planInclude,
    });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_CREATED', entityType: 'SaaSPlan', entityId: item.id, metadata: { key: item.key, modules: [...new Set(modules)] } } });
    return res.status(201).json({ ...item, modules: item.modules.map(module => module.moduleKey) });
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
    const { modules, prices, ...fields } = parsed.data;
    const nextModules = [...new Set(modules)];
    const updated = await prisma.$transaction(async tx => {
      const item = await tx.saaSPlan.update({
        where: { id: current.id },
        data: {
          ...fields, description: fields.description ?? null, maxUnits: fields.maxUnits ?? null, maxUsers: fields.maxUsers ?? null,
          activationFee: new Prisma.Decimal(fields.activationFee), setupFee: new Prisma.Decimal(fields.setupFee),
          modules: { deleteMany: {}, create: nextModules.map(moduleKey => ({ moduleKey })) },
          prices: { deleteMany: {}, create: prices.map(price => ({ period: price.period, amount: new Prisma.Decimal(price.amount) })) },
        },
        include: planInclude,
      });
      await tx.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_UPDATED', entityType: 'SaaSPlan', entityId: item.id, metadata: { before: { key: current.key, name: current.name }, after: { key: item.key, name: item.name, modules: nextModules } } } });
      return item;
    });
    return res.json({ ...updated, modules: updated.modules.map(module => module.moduleKey) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um plano com esta chave' });
    return next(error);
  }
});

planRoutes.post('/:id/duplicate', async (req, res, next) => {
  try {
    const input = z.object({ key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80), name: z.string().min(2).max(120) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Validation failed', errors: input.error.flatten() });
    const source = await prisma.saaSPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
    if (!source) return res.status(404).json({ message: 'Plan not found' });
    const duplicate = await prisma.saaSPlan.create({
      data: {
        key: input.data.key, name: input.data.name, description: source.description, active: false, trialDays: source.trialDays,
        maxUnits: source.maxUnits, maxUsers: source.maxUsers, activationFee: source.activationFee, setupFee: source.setupFee,
        modules: { create: source.modules.map(module => ({ moduleKey: module.moduleKey })) },
        prices: { create: source.prices.map(price => ({ period: price.period, amount: price.amount })) },
      },
      include: planInclude,
    });
    await prisma.auditLog.create({ data: { actorUserId: req.auth!.userId, action: 'SAAS_PLAN_DUPLICATED', entityType: 'SaaSPlan', entityId: duplicate.id, metadata: { sourceId: source.id } } });
    return res.status(201).json({ ...duplicate, modules: duplicate.modules.map(module => module.moduleKey) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return res.status(409).json({ message: 'Já existe um plano com esta chave' });
    return next(error);
  }
});
