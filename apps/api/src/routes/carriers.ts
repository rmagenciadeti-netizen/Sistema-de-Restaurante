import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { activeFilter, audit, documentSchema, listQuerySchema, optionalText, validationError } from '../lib/registry';

export const carrierRoutes = Router();
carrierRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const schema = z.object({
  name: z.string().trim().min(2).max(160),
  document: documentSchema,
  phone: optionalText(30),
  email: z.string().trim().email().max(160).nullish().transform(value => value || null),
  notes: optionalText(500),
  active: z.boolean().default(true),
});

carrierRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const digits = q?.replace(/\D/g, '');
    const search = q ? { AND: [{ OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { email: { contains: q, mode: 'insensitive' as const } }, ...(digits ? [{ document: { contains: digits } }, { phone: { contains: digits } }] : [])] }] } : {};
    const items = await prisma.carrier.findMany({ where: { tenantId: req.auth!.tenantId!, ...activeFilter(active), ...search }, orderBy: [{ active: 'desc' }, { name: 'asc' }], take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

carrierRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const created = await prisma.carrier.create({ data: { ...parsed.data, tenantId: req.auth!.tenantId! } });
    await audit(req, 'CARRIER_CREATED', 'Carrier', created.id);
    return res.status(201).json(created);
  } catch (error) { return next(error); }
});

carrierRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const current = await prisma.carrier.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); if (!current) return res.status(404).json({ message: 'Transportadora não encontrada.' });
    const updated = await prisma.carrier.update({ where: { id: current.id }, data: parsed.data });
    await audit(req, parsed.data.active !== undefined && parsed.data.active !== current.active ? (parsed.data.active ? 'CARRIER_ACTIVATED' : 'CARRIER_DEACTIVATED') : 'CARRIER_UPDATED', 'Carrier', current.id);
    return res.json(updated);
  } catch (error) { return next(error); }
});

// Nothing else references carriers yet, so removal is a real delete; use PATCH {active:false} to keep the record.
carrierRoutes.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.carrier.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId! } }); if (!current) return res.status(404).json({ message: 'Transportadora não encontrada.' });
    await prisma.carrier.delete({ where: { id: current.id } });
    await audit(req, 'CARRIER_DELETED', 'Carrier', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});
