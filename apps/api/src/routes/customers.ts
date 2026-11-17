import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, MANAGEMENT_ROLES, requireRoles, SALES_ROLES } from '../lib/permissions';
import { normalizePhone } from '../lib/order-engine';
import { averageSpent, classifyCustomer, SEGMENT_RULES, type CustomerStats } from '../lib/crm';

export const customerRoutes = Router();
customerRoutes.use(requireAuth, requireTenant, allowRead(SALES_ROLES, SALES_ROLES));
const schema = z.object({ name: z.string().min(2).max(160), phone: z.string().min(8).max(30), email: z.string().email().optional(), document: z.string().max(20).optional(), address: z.string().max(500).optional(), notes: z.string().max(1000).optional(), marketingConsent: z.boolean().default(false) });

customerRoutes.get('/', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1); const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 25));
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 60) : '';
    const digits = search.replace(/\D/g, '');
    const where = { tenantId: req.auth!.tenantId!, active: true, ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' as const } }, ...(digits ? [{ phone: { contains: digits } }] : [])] } : {}) };
    const [items, total] = await Promise.all([prisma.customer.findMany({ where, orderBy: { name: 'asc' }, skip: (page - 1) * pageSize, take: pageSize }), prisma.customer.count({ where })]);
    return res.json({ items, total, page, pageSize });
  } catch (error) { return next(error); }
});
customerRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const phone = normalizePhone(parsed.data.phone); if (!phone) return res.status(400).json({ message: 'Invalid phone' });
    const tenantId = req.auth!.tenantId!;
    if (await prisma.customer.findUnique({ where: { tenantId_phone: { tenantId, phone } } })) return res.status(409).json({ message: 'Customer with this phone already exists' });
    return res.status(201).json(await prisma.customer.create({ data: { ...parsed.data, phone, tenantId } }));
  } catch (error) { return next(error); }
});
// Segments are computed from completed orders only, never from guesses. Must stay above '/:id'.
customerRoutes.get('/segments', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!; const now = new Date();
    const [customers, sums] = await Promise.all([
      prisma.customer.findMany({ where: { tenantId, active: true }, select: { id: true, name: true, phone: true, email: true, marketingConsent: true, loyaltyPoints: true }, take: 5000 }),
      prisma.order.groupBy({ by: ['customerId'], where: { tenantId, status: 'COMPLETED', customerId: { not: null } }, _count: true, _sum: { total: true }, _min: { createdAt: true }, _max: { createdAt: true } }),
    ]);
    const stats = new Map<string, CustomerStats>(sums.map(row => [row.customerId!, { id: row.customerId!, orders: row._count, spent: Number(row._sum.total ?? 0), firstOrderAt: row._min.createdAt, lastOrderAt: row._max.createdAt }]));
    const all = customers.map(customer => stats.get(customer.id) ?? { id: customer.id, orders: 0, spent: 0, firstOrderAt: null, lastOrderAt: null });
    const average = averageSpent(all);
    const items = customers.map(customer => {
      const entry = stats.get(customer.id) ?? { id: customer.id, orders: 0, spent: 0, firstOrderAt: null, lastOrderAt: null };
      return { ...customer, segment: classifyCustomer(entry, average, now), orders: entry.orders, spent: Math.round(entry.spent * 100) / 100, averageTicket: entry.orders ? Math.round((entry.spent / entry.orders) * 100) / 100 : null, lastOrderAt: entry.lastOrderAt };
    }).sort((a, b) => b.spent - a.spent);
    const counts = items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item.segment]: (acc[item.segment] ?? 0) + 1 }), {});
    return res.json({ items, counts, rules: SEGMENT_RULES, averageSpent: Math.round(average * 100) / 100, truncated: customers.length >= 5000 });
  } catch (error) { return next(error); }
});
customerRoutes.get('/:id', async (req, res, next) => {
  try {
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, include: { orders: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, code: true, channel: true, status: true, total: true, createdAt: true } } } });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    return res.json(customer);
  } catch (error) { return next(error); }
});
customerRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.omit({ phone: true }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const current = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, active: true } }); if (!current) return res.status(404).json({ message: 'Customer not found' });
    return res.json(await prisma.customer.update({ where: { id: current.id }, data: parsed.data }));
  } catch (error) { return next(error); }
});
// LGPD: personal data portability and erasure. Orders are kept for fiscal/financial history but detached from identifying data.
customerRoutes.get('/:id/export', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const customer = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! }, include: { orders: { select: { id: true, code: true, channel: true, status: true, total: true, createdAt: true } } } });
    if (!customer) return res.status(404).json({ message: 'Customer not found' });
    await prisma.auditLog.create({ data: { tenantId: customer.tenantId, actorUserId: req.auth!.userId, action: 'CUSTOMER_DATA_EXPORTED', entityType: 'Customer', entityId: customer.id } });
    return res.json(customer);
  } catch (error) { return next(error); }
});
customerRoutes.post('/:id/anonymize', requireRoles(...MANAGEMENT_ROLES), async (req, res, next) => {
  try {
    const tenantId = req.auth!.tenantId!;
    const current = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId } }); if (!current) return res.status(404).json({ message: 'Customer not found' });
    await prisma.$transaction([
      prisma.customer.update({ where: { id: current.id }, data: { name: 'Cliente anonimizado', phone: `anon-${current.id}`, email: null, document: null, address: null, notes: null, marketingConsent: false, active: false } }),
      prisma.order.updateMany({ where: { customerId: current.id, tenantId }, data: { customerName: null } }),
      prisma.whatsappMessage.updateMany({ where: { tenantId, order: { customerId: current.id } }, data: { toPhone: 'redacted', payload: Prisma.DbNull } }),
      prisma.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'CUSTOMER_ANONYMIZED', entityType: 'Customer', entityId: current.id } }),
    ]);
    return res.status(204).end();
  } catch (error) { return next(error); }
});
