import { Router } from 'express';
import { DiscountType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';

export const promotionRoutes = Router();
promotionRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const baseSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.nativeEnum(DiscountType),
  value: z.number().finite().positive().max(9_999_999_999),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
  productIds: z.array(z.string().uuid()).max(500).default([]),
});
const checkRules = (value: { type?: DiscountType; value?: number; startsAt?: string; endsAt?: string | null }, ctx: z.RefinementCtx) => {
  if (value.type === DiscountType.PERCENT && value.value !== undefined && value.value > 100) ctx.addIssue({ code: 'custom', message: 'O desconto percentual não pode passar de 100%.', path: ['value'] });
  if (value.value !== undefined && new Prisma.Decimal(value.value).decimalPlaces() > 2) ctx.addIssue({ code: 'custom', message: 'Use no máximo duas casas decimais.', path: ['value'] });
  if (value.startsAt && value.endsAt && new Date(value.endsAt) <= new Date(value.startsAt)) ctx.addIssue({ code: 'custom', message: 'O fim deve ser depois do início.', path: ['endsAt'] });
};
const createSchema = baseSchema.superRefine(checkRules);
const updateSchema = baseSchema.partial().superRefine(checkRules);

const include = { products: { select: { product: { select: { id: true, name: true, price: true } } } } } as const;
type PromotionRow = Prisma.PromotionGetPayload<{ include: typeof include }>;

function present({ products, ...promotion }: PromotionRow, now = new Date()) {
  const status = promotion.endsAt && promotion.endsAt < now ? 'EXPIRED' : !promotion.active ? 'INACTIVE' : promotion.startsAt > now ? 'SCHEDULED' : 'ACTIVE';
  return { ...promotion, status, products: products.map(link => link.product) };
}

async function sameTenantProducts(db: Pick<Prisma.TransactionClient, 'product'>, tenantId: string, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return unique;
  const count = await db.product.count({ where: { tenantId, id: { in: unique } } });
  return count === unique.length ? unique : null;
}

promotionRoutes.get('/', async (req, res, next) => {
  try {
    const now = new Date();
    const status = typeof req.query.status === 'string' ? req.query.status : 'todas';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const filters: Prisma.PromotionWhereInput[] = [];
    if (status === 'ativas') filters.push({ active: true }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] });
    else if (status === 'inativas') filters.push({ active: false });
    else if (status === 'expiradas') filters.push({ endsAt: { lt: now } });
    else if (status !== 'todas') return res.status(400).json({ message: 'Filtro de situação inválido.' });
    if (q) filters.push({ name: { contains: q, mode: 'insensitive' } });
    const items = await prisma.promotion.findMany({ where: { tenantId: req.auth!.tenantId!, AND: filters }, include, orderBy: [{ createdAt: 'desc' }], take: 500 });
    return res.json({ items: items.map(item => present(item, now)), total: items.length });
  } catch (error) { return next(error); }
});

promotionRoutes.post('/', async (req, res, next) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  try {
    const { tenantId, userId } = req.auth!;
    const productIds = await sameTenantProducts(prisma, tenantId!, parsed.data.productIds);
    if (!productIds) return res.status(400).json({ message: 'Algum produto não pertence a este restaurante.' });
    const { productIds: _ids, startsAt, endsAt, ...data } = parsed.data;
    const created = await prisma.promotion.create({
      data: { ...data, tenantId: tenantId!, startsAt: new Date(startsAt), endsAt: endsAt ? new Date(endsAt) : null, products: { create: productIds.map(productId => ({ productId })) } },
      include,
    });
    await prisma.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'PROMOTION_CREATED', entityType: 'Promotion', entityId: created.id } });
    return res.status(201).json(present(created));
  } catch (error) { return next(error); }
});

promotionRoutes.patch('/:id', async (req, res, next) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
  try {
    const { tenantId, userId } = req.auth!;
    const result = await serializable(prisma, async tx => {
      const current = await tx.promotion.findFirst({ where: { id: req.params.id, tenantId: tenantId! } });
      if (!current) return { status: 404, message: 'Promoção não encontrada.' } as const;
      const { productIds, startsAt, endsAt, ...data } = parsed.data;
      const nextType = data.type ?? current.type;
      const nextValue = data.value ?? current.value.toNumber();
      if (nextType === DiscountType.PERCENT && nextValue > 100) return { status: 400, message: 'O desconto percentual não pode passar de 100%.' } as const;
      const nextStart = startsAt ? new Date(startsAt) : current.startsAt;
      const nextEnd = endsAt === undefined ? current.endsAt : endsAt ? new Date(endsAt) : null;
      if (nextEnd && nextEnd <= nextStart) return { status: 400, message: 'O fim deve ser depois do início.' } as const;
      let links: string[] | undefined;
      if (productIds) {
        const checked = await sameTenantProducts(tx, tenantId!, productIds);
        if (!checked) return { status: 400, message: 'Algum produto não pertence a este restaurante.' } as const;
        links = checked;
      }
      if (links) await tx.promotionProduct.deleteMany({ where: { promotionId: current.id } });
      const updated = await tx.promotion.update({
        where: { id: current.id },
        data: { ...data, startsAt: nextStart, endsAt: nextEnd, ...(links ? { products: { create: links.map(productId => ({ productId })) } } : {}) },
        include,
      });
      await tx.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'PROMOTION_UPDATED', entityType: 'Promotion', entityId: current.id } });
      return { status: 200, promotion: updated } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json(present(result.promotion));
  } catch (error) { return next(error); }
});

promotionRoutes.delete('/:id', async (req, res, next) => {
  try {
    const { tenantId, userId } = req.auth!;
    const result = await prisma.promotion.deleteMany({ where: { id: req.params.id, tenantId: tenantId! } });
    if (!result.count) return res.status(404).json({ message: 'Promoção não encontrada.' });
    await prisma.auditLog.create({ data: { tenantId: tenantId!, actorUserId: userId, action: 'PROMOTION_DELETED', entityType: 'Promotion', entityId: req.params.id } });
    return res.status(204).send();
  } catch (error) { return next(error); }
});
