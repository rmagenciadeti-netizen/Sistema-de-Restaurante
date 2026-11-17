import { Router } from 'express';
import { PaymentMethod } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { activeFilter, audit, isUniqueViolation, listQuerySchema, validationError } from '../lib/registry';

export const paymentMethodRoutes = Router();
paymentMethodRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

export const DEFAULT_PAYMENT_METHODS: { name: string; equivalent: PaymentMethod; allowChange: boolean }[] = [
  { name: 'Dinheiro', equivalent: PaymentMethod.CASH, allowChange: true },
  { name: 'PIX', equivalent: PaymentMethod.PIX, allowChange: false },
  { name: 'Cartão de crédito', equivalent: PaymentMethod.CREDIT_CARD, allowChange: false },
  { name: 'Cartão de débito', equivalent: PaymentMethod.DEBIT_CARD, allowChange: false },
  { name: 'Vale', equivalent: PaymentMethod.VOUCHER, allowChange: false },
  { name: 'Outro', equivalent: PaymentMethod.OTHER, allowChange: false },
];

const schema = z.object({
  name: z.string().trim().min(2).max(60),
  equivalent: z.nativeEnum(PaymentMethod).default(PaymentMethod.OTHER),
  active: z.boolean().default(true),
  showLocal: z.boolean().default(true),
  showStore: z.boolean().default(true),
  showApp: z.boolean().default(true),
  allowChange: z.boolean().default(false),
  requireDocument: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});
const conflict = { message: 'Já existe uma forma de pagamento com esse nome.' };

// Declared before any `/:id` route so that "options" is never read as an id.
paymentMethodRoutes.get('/options', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const rows = await prisma.paymentMethodConfig.findMany({ where: { tenantId }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    if (rows.length === 0) {
      return res.json({ items: DEFAULT_PAYMENT_METHODS.map((method, index) => ({ id: `default-${method.equivalent}`, name: method.name, equivalent: method.equivalent, allowChange: method.allowChange, showLocal: true, showStore: true, showApp: true, requireDocument: false, sortOrder: index })) });
    }
    return res.json({ items: rows.filter(row => row.active).map(row => ({ id: row.id, name: row.name, equivalent: row.equivalent, allowChange: row.allowChange, showLocal: row.showLocal, showStore: row.showStore, showApp: row.showApp, requireDocument: row.requireDocument, sortOrder: row.sortOrder })) });
  } catch (error) { return next(error); }
});

// Persists the six default methods (skipping names that already exist) so the tenant can edit them.
paymentMethodRoutes.post('/defaults', async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const result = await prisma.paymentMethodConfig.createMany({ data: DEFAULT_PAYMENT_METHODS.map((method, index) => ({ tenantId, ...method, sortOrder: index })), skipDuplicates: true });
    await audit(req, 'PAYMENT_METHODS_DEFAULTS_CREATED', 'PaymentMethodConfig', tenantId, { created: result.count });
    return res.status(201).json({ created: result.count });
  } catch (error) { return next(error); }
});

paymentMethodRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const items = await prisma.paymentMethodConfig.findMany({ where: { tenantId: req.auth!.tenantId!, ...activeFilter(active), ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

paymentMethodRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    if (await prisma.paymentMethodConfig.findFirst({ where: { tenantId, name: { equals: parsed.data.name, mode: 'insensitive' } } })) return res.status(409).json(conflict);
    const created = await prisma.paymentMethodConfig.create({ data: { ...parsed.data, tenantId } });
    await audit(req, 'PAYMENT_METHOD_CREATED', 'PaymentMethodConfig', created.id);
    return res.status(201).json(created);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(conflict) : next(error); }
});

paymentMethodRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.paymentMethodConfig.findFirst({ where: { id: req.params.id, tenantId } }); if (!current) return res.status(404).json({ message: 'Forma de pagamento não encontrada.' });
    if (parsed.data.name && await prisma.paymentMethodConfig.findFirst({ where: { tenantId, id: { not: current.id }, name: { equals: parsed.data.name, mode: 'insensitive' } } })) return res.status(409).json(conflict);
    const updated = await prisma.paymentMethodConfig.update({ where: { id: current.id }, data: parsed.data });
    await audit(req, parsed.data.active !== undefined && parsed.data.active !== current.active ? (parsed.data.active ? 'PAYMENT_METHOD_ACTIVATED' : 'PAYMENT_METHOD_DEACTIVATED') : 'PAYMENT_METHOD_UPDATED', 'PaymentMethodConfig', current.id);
    return res.json(updated);
  } catch (error) { return isUniqueViolation(error) ? res.status(409).json(conflict) : next(error); }
});

// Payments store only the `equivalent` enum, never this record, so a delete never breaks history.
paymentMethodRoutes.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.paymentMethodConfig.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); if (!current) return res.status(404).json({ message: 'Forma de pagamento não encontrada.' });
    await prisma.paymentMethodConfig.delete({ where: { id: current.id } });
    await audit(req, 'PAYMENT_METHOD_DELETED', 'PaymentMethodConfig', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});
