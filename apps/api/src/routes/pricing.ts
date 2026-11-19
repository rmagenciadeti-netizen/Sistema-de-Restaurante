import { Router, type Request } from 'express';
import { OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { FINANCE_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings, saveSettingsSection } from '../lib/settings';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FORMULAS, computePricing, effectiveInput, pricingDefaults, type PricingInput } from '../lib/pricing';

export const pricingRoutes = Router();
pricingRoutes.use(requireAuth, requireTenant, requireRoles(...FINANCE_ROLES));

const percent = z.number().min(0).max(60);
const num = (value: Prisma.Decimal.Value | null | undefined) => Number(value ?? 0);
const money = z.number().min(0).max(9_999_999_999.99);

const productWhere = (req: Request, extra: Prisma.ProductWhereInput = {}): Prisma.ProductWhereInput => ({ tenantId: req.auth!.tenantId!, ...(req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {}), ...extra });
const pricingSelect = { freightCost: true, otherAcquisitionCost: true, marginPercent: true, operationalCostPercent: true, operationalCostFixed: true, taxPercent: true, cardFeePercent: true, commissionPercent: true, otherVariablePercent: true } as const;

async function audit(tx: Prisma.TransactionClient, req: Request, action: string, entityType: string, entityId: string, metadata?: Prisma.InputJsonValue) {
  await tx.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action, entityType, entityId, metadata } });
}

// ---- Company defaults ----
const settingsSchema = z.object({ marginPercent: z.number().min(0).max(1000), taxPercent: percent, cardFeePercent: z.number().min(0).max(30), commissionPercent: percent, operationalCostPercent: percent, otherVariablePercent: percent, rounding: z.enum(['NONE', 'UP_10_CENTS', 'UP_TO_90']) })
  .refine(value => value.taxPercent + value.cardFeePercent + value.commissionPercent + value.operationalCostPercent + value.otherVariablePercent < 100, { message: 'A soma dos percentuais sobre o preço deve ser menor que 100%.' });

pricingRoutes.get('/settings', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const fiscal = await prisma.fiscalSettings.findUnique({ where: { tenantId }, select: { issuer: true } });
    const regime = (fiscal?.issuer as { taxRegime?: string } | null)?.taxRegime ?? null;
    // The regime is shown for the user to review the tax percentage with their accountant. No rate is derived from it: Simples, MEI and Lucro Presumido/Real are computed in different ways (revenue band, annex, state).
    return res.json({ defaults: pricingDefaults(await loadSettings(prisma, tenantId)), formulas: FORMULAS, taxReview: { fiscalRegime: regime, rateSuggested: false, note: 'O sistema não presume alíquotas. O percentual de tributos usado nos preços e na lucratividade é o que você informar; confirme-o com seu contador de acordo com o regime tributário, a faixa de faturamento e o estado.' } });
  }
  catch (error) { return next(error); }
});

pricingRoutes.put('/settings', async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const value = parsed.data;
    const defaults = await prisma.$transaction(async tx => {
      const current = await loadSettings(tx, tenantId);
      await saveSettingsSection(tx, tenantId, 'products', { ...current.products, defaultMarginPercent: value.marginPercent });
      await saveSettingsSection(tx, tenantId, 'profit', { ...current.profit, taxPercent: value.taxPercent, cardFeePercent: value.cardFeePercent });
      await saveSettingsSection(tx, tenantId, 'pricing', { commissionPercent: value.commissionPercent, operationalCostPercent: value.operationalCostPercent, otherVariablePercent: value.otherVariablePercent, rounding: value.rounding });
      await audit(tx, req, 'PRICING_DEFAULTS_UPDATED', 'TenantSettings', tenantId, { previous: pricingDefaults(current), next: value });
      return pricingDefaults(await loadSettings(tx, tenantId));
    });
    return res.json({ defaults });
  } catch (error) { return next(error); }
});

// ---- Per-product costs ----
async function loadProduct(req: Request, id: string) {
  return prisma.product.findFirst({ where: productWhere(req, { id }), select: { id: true, name: true, price: true, cost: true, active: true, category: { select: { name: true } }, pricing: { select: pricingSelect } } });
}
const pricingFields = z.object({
  freightCost: money, otherAcquisitionCost: money, marginPercent: z.number().min(0).max(1000).nullable(), operationalCostPercent: percent.nullable(), operationalCostFixed: money.nullable(),
  taxPercent: percent.nullable(), cardFeePercent: z.number().min(0).max(30).nullable(), commissionPercent: percent.nullable(), otherVariablePercent: percent.nullable(),
});

pricingRoutes.get('/products/:id', async (req, res, next) => {
  try {
    const product = await loadProduct(req, req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const defaults = pricingDefaults(await loadSettings(prisma, req.auth!.tenantId!));
    const history = await prisma.priceHistory.findMany({ where: { tenantId: req.auth!.tenantId!, productId: product.id }, orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, price: true, cost: true, reason: true, createdAt: true } });
    return res.json({ product: { id: product.id, name: product.name, price: num(product.price), cost: product.cost === null ? null : num(product.cost), category: product.category?.name ?? null }, pricing: product.pricing, defaults, result: computePricing(effectiveInput(product, product.pricing, defaults)), history });
  } catch (error) { return next(error); }
});

pricingRoutes.put('/products/:id', async (req, res, next) => {
  try {
    const parsed = pricingFields.extend({ acquisitionCost: money.nullable().optional() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const product = await loadProduct(req, req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const { acquisitionCost, ...fields } = parsed.data;
    const defaults = pricingDefaults(await loadSettings(prisma, req.auth!.tenantId!));
    const nextCost = acquisitionCost === undefined ? product.cost : acquisitionCost;
    const check = computePricing(effectiveInput({ cost: nextCost, price: product.price }, fields, defaults));
    if (!check.ok && check.code !== 'NO_COST') return res.status(400).json({ message: check.message });
    await prisma.$transaction(async tx => {
      await tx.productPricing.upsert({ where: { productId: product.id }, create: { tenantId: req.auth!.tenantId!, productId: product.id, ...fields }, update: fields });
      if (acquisitionCost !== undefined && String(acquisitionCost) !== String(product.cost)) {
        await tx.product.update({ where: { id: product.id }, data: { cost: acquisitionCost } });
        await tx.priceHistory.create({ data: { tenantId: req.auth!.tenantId!, productId: product.id, price: product.price, cost: acquisitionCost, reason: 'COST_UPDATE', actorUserId: req.auth!.userId } });
      }
      await audit(tx, req, 'PRODUCT_PRICING_UPDATED', 'Product', product.id, { acquisitionCost: acquisitionCost ?? null, ...fields });
    });
    const updated = await loadProduct(req, product.id);
    return res.json({ pricing: updated!.pricing, result: computePricing(effectiveInput(updated!, updated!.pricing, defaults)) });
  } catch (error) { return next(error); }
});

// Official price changes only happen here, after an explicit confirmation.
pricingRoutes.post('/products/:id/apply-price', async (req, res, next) => {
  try {
    const parsed = z.object({ price: z.number().positive().max(9_999_999_999.99), confirm: z.literal(true) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Confirme a alteração do preço oficial.' });
    const product = await loadProduct(req, req.params.id);
    if (!product) return res.status(404).json({ message: 'Product not found' });
    const price = new Prisma.Decimal(parsed.data.price).toDecimalPlaces(2);
    await prisma.$transaction(async tx => {
      await tx.product.update({ where: { id: product.id }, data: { price } });
      await tx.priceHistory.create({ data: { tenantId: req.auth!.tenantId!, productId: product.id, price, cost: product.cost, reason: 'PRICING_APPLIED', actorUserId: req.auth!.userId } });
      await audit(tx, req, 'PRODUCT_PRICE_UPDATED', 'Product', product.id, { previousPrice: product.price.toString(), price: price.toString(), source: 'pricing' });
    });
    return res.json({ price: price.toNumber() });
  } catch (error) { return next(error); }
});

// Free simulation: nothing is saved. With productId it starts from that product's effective inputs, otherwise from the company defaults.
pricingRoutes.post('/simulate', async (req, res, next) => {
  try {
    const optional = z.number().min(0).max(9_999_999_999.99).optional();
    const parsed = z.object({ productId: z.string().uuid().optional(), acquisitionCost: optional, freightCost: optional, otherAcquisitionCost: optional, marginPercent: z.number().min(0).max(1000).optional(), taxPercent: percent.optional(), cardFeePercent: percent.optional(), commissionPercent: percent.optional(), operationalCostPercent: percent.optional(), otherVariablePercent: percent.optional(), operationalCostFixed: optional, currentPrice: optional, simulatedPrice: optional }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const { productId, ...overrides } = parsed.data;
    const defaults = pricingDefaults(await loadSettings(prisma, req.auth!.tenantId!));
    let base: PricingInput;
    if (productId) {
      const product = await loadProduct(req, productId);
      if (!product) return res.status(404).json({ message: 'Product not found' });
      base = effectiveInput(product, product.pricing, defaults);
    } else base = effectiveInput({ cost: 0, price: 0 }, null, defaults);
    const input = { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) } as PricingInput;
    return res.json(computePricing(input));
  } catch (error) { return next(error); }
});

// ---- Bulk price changes: always simulate first; applying needs explicit confirmation and the same parameters ----
const bulkSchema = z.object({
  categoryId: z.string().uuid().optional(), productIds: z.array(z.string().uuid()).max(2000).optional(),
  marginPercent: z.number().min(0).max(1000).optional(), keepIndividualMargins: z.boolean().default(true), onlyIncreases: z.boolean().default(false),
});
type BulkRow = { id: string; name: string; category: string | null; cost: number; currentPrice: number; newPrice: number; difference: number; currentMla: string | null; newMla: string | null };

async function bulkPlan(req: Request, body: z.infer<typeof bulkSchema>) {
  const defaults = pricingDefaults(await loadSettings(prisma, req.auth!.tenantId!));
  const products = await prisma.product.findMany({
    where: productWhere(req, { active: true, ...(body.categoryId ? { categoryId: body.categoryId } : {}), ...(body.productIds ? { id: { in: body.productIds } } : {}) }),
    select: { id: true, name: true, price: true, cost: true, category: { select: { name: true } }, pricing: { select: pricingSelect } }, orderBy: { name: 'asc' }, take: 5000,
  });
  const rows: BulkRow[] = []; const skipped: { id: string; name: string; reason: string }[] = [];
  for (const product of products) {
    if (product.cost === null || product.cost.lte(0)) { skipped.push({ id: product.id, name: product.name, reason: 'Sem custo cadastrado' }); continue; }
    const own = product.pricing?.marginPercent ?? null;
    const margin = body.keepIndividualMargins && own !== null ? own : body.marginPercent ?? own ?? defaults.marginPercent;
    const result = computePricing(effectiveInput(product, product.pricing, defaults, { marginPercent: margin }));
    if (!result.ok) { skipped.push({ id: product.id, name: product.name, reason: result.message }); continue; }
    const newPrice = Number(result.recommendedPrice); const currentPrice = num(product.price);
    if (body.onlyIncreases && newPrice <= currentPrice) { skipped.push({ id: product.id, name: product.name, reason: 'Preço atual já é igual ou maior' }); continue; }
    if (newPrice === currentPrice) { skipped.push({ id: product.id, name: product.name, reason: 'Sem alteração' }); continue; }
    rows.push({ id: product.id, name: product.name, category: product.category?.name ?? null, cost: num(product.cost), currentPrice, newPrice, difference: Math.round((newPrice - currentPrice) * 100) / 100, currentMla: result.current?.mla ?? null, newMla: result.recommended.mla });
  }
  return { rows, skipped };
}

pricingRoutes.post('/bulk/preview', async (req, res, next) => {
  try {
    const parsed = bulkSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const plan = await bulkPlan(req, parsed.data);
    return res.json({ ...plan, count: plan.rows.length, requiresConfirmation: true });
  } catch (error) { return next(error); }
});

pricingRoutes.post('/bulk/apply', async (req, res, next) => {
  try {
    const parsed = bulkSchema.extend({ confirm: z.literal(true), expectedCount: z.number().int().min(1) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: 'Simule a alteração e confirme antes de aplicar.' });
    const { confirm: _confirm, expectedCount, ...body } = parsed.data;
    const plan = await bulkPlan(req, body);
    if (plan.rows.length !== expectedCount) return res.status(409).json({ message: 'Os preços mudaram desde a simulação. Simule novamente.' });
    if (plan.rows.length > BULK_LIMIT) return res.status(400).json({ message: `Limite de ${BULK_LIMIT} produtos por aplicação. Filtre por categoria e aplique em etapas.` });
    const tenantId = req.auth!.tenantId!;
    await prisma.$transaction(async tx => {
      for (const row of [...plan.rows].sort((a, b) => a.id.localeCompare(b.id))) {
        const done = await tx.product.updateMany({ where: { id: row.id, tenantId, price: row.currentPrice }, data: { price: row.newPrice } });
        if (done.count !== 1) throw new BulkConflict();
      }
      await tx.priceHistory.createMany({ data: plan.rows.map(row => ({ tenantId, productId: row.id, price: row.newPrice, cost: row.cost, reason: 'PRICING_BULK', actorUserId: req.auth!.userId })) });
      await tx.auditLog.createMany({ data: plan.rows.map(row => ({ tenantId, actorUserId: req.auth!.userId, action: 'PRODUCT_PRICE_UPDATED', entityType: 'Product', entityId: row.id, metadata: { previousPrice: row.currentPrice, price: row.newPrice, source: 'pricing-bulk' } })) });
    }, { timeout: 120_000, maxWait: 10_000 });
    return res.json({ updated: plan.rows.length });
  } catch (error) {
    if (error instanceof BulkConflict) return res.status(409).json({ message: 'Um preço foi alterado durante a aplicação. Nada foi gravado; simule novamente.' });
    return next(error);
  }
});
class BulkConflict extends Error {}
const BULK_LIMIT = 2000;

// ---- Profitability panel ----
pricingRoutes.get('/panel', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const now = new Date();
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return res.status(400).json({ message: 'Invalid date range' });
    const defaults = pricingDefaults(await loadSettings(prisma, tenantId));
    const [products, items] = await Promise.all([
      prisma.product.findMany({ where: productWhere(req, { active: true, isCombo: false }), select: { id: true, name: true, price: true, cost: true, category: { select: { name: true } }, pricing: { select: pricingSelect } }, orderBy: { name: 'asc' }, take: 5000 }),
      prisma.orderItem.findMany({ where: { order: { tenantId, ...(req.auth!.unitId ? { unitId: req.auth!.unitId } : {}), status: OrderStatus.COMPLETED, createdAt: { gte: from, lte: to } }, parentItemId: null, unitCost: { not: null } }, take: 100_000, select: { productId: true, quantity: true, weightKg: true, total: true, unitCost: true } }),
    ]);
    const realized = new Map<string, { units: number; revenue: number; cost: number }>();
    for (const item of items) {
      const units = item.weightKg ? num(item.weightKg) * num(item.quantity) : num(item.quantity);
      const row = realized.get(item.productId) ?? { units: 0, revenue: 0, cost: 0 };
      row.units += units; row.revenue += num(item.total); row.cost += units * num(item.unitCost); realized.set(item.productId, row);
    }
    type Row = { id: string; name: string; category: string; price: number; totalCost: number; ml: number | null; mla: number | null; netResult: number; recommendedPrice: number; status: string; realizedMl: number | null; realizedUnits: number };
    const rows: Row[] = []; const withoutCost: { id: string; name: string }[] = []; const invalid: { id: string; name: string; reason: string }[] = [];
    for (const product of products) {
      if (product.cost === null || product.cost.lte(0)) { withoutCost.push({ id: product.id, name: product.name }); continue; }
      const result = computePricing(effectiveInput(product, product.pricing, defaults));
      if (!result.ok) { invalid.push({ id: product.id, name: product.name, reason: result.message }); continue; }
      const sold = realized.get(product.id);
      rows.push({
        id: product.id, name: product.name, category: product.category?.name ?? 'Sem categoria', price: num(product.price), totalCost: Number(result.totalCost),
        ml: result.current?.ml === undefined || result.current === null ? null : Number(result.current.ml), mla: result.current?.mla ? Number(result.current.mla) : null, netResult: result.current ? Number(result.current.netResult) : 0,
        recommendedPrice: Number(result.recommendedPrice), status: result.status,
        realizedMl: sold && sold.cost > 0 ? Math.round(((sold.revenue - sold.cost) / sold.cost) * 10000) / 100 : null, realizedUnits: sold?.units ?? 0,
      });
    }
    const priced = rows.filter(row => row.price > 0 && row.mla !== null);
    const sorted = [...priced].sort((a, b) => (b.mla ?? 0) - (a.mla ?? 0));
    const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100 : null;
    const categories = new Map<string, Row[]>();
    for (const row of priced) categories.set(row.category, [...(categories.get(row.category) ?? []), row]);
    const totals = [...realized.values()].reduce((sum, row) => ({ revenue: sum.revenue + row.revenue, cost: sum.cost + row.cost }), { revenue: 0, cost: 0 });
    return res.json({
      period: { from, to }, defaults, analyzed: rows.length, withoutCost, invalid,
      summary: {
        averageMl: average(priced.map(row => row.ml ?? 0)), averageMla: average(priced.map(row => row.mla ?? 0)), negative: priced.filter(row => row.status === 'NEGATIVE').length,
        belowTarget: priced.filter(row => row.status === 'BELOW_TARGET').length, onTarget: priced.filter(row => row.status === 'ON_TARGET').length, noPrice: rows.length - priced.length,
        realizedRevenue: Math.round(totals.revenue * 100) / 100, realizedCost: Math.round(totals.cost * 100) / 100, realizedMl: totals.cost > 0 ? Math.round(((totals.revenue - totals.cost) / totals.cost) * 10000) / 100 : null,
      },
      mostProfitable: sorted.slice(0, 10), leastProfitable: sorted.slice(-10).reverse(), negative: priced.filter(row => row.status === 'NEGATIVE').slice(0, 100), belowTarget: priced.filter(row => row.status === 'BELOW_TARGET').slice(0, 100),
      byCategory: [...categories.entries()].map(([category, list]) => ({ category, products: list.length, averageMl: average(list.map(row => row.ml ?? 0)), averageMla: average(list.map(row => row.mla ?? 0)) })).sort((a, b) => (b.averageMla ?? 0) - (a.averageMla ?? 0)),
    });
  } catch (error) { return next(error); }
});
