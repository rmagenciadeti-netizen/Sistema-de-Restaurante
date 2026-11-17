import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { allowRead, ALL_TENANT_ROLES, MANAGEMENT_ROLES } from '../lib/permissions';
import { moneySchema } from '../lib/money';
import { activeFilter, audit, listQuerySchema, resolveUnit, unitReadScope, validationError } from '../lib/registry';

// Couvert artístico: per-person fee charged while an event is in effect. The POS reads `GET /current` to know whether to offer it.
export const coverEventRoutes = Router();
coverEventRoutes.use(requireAuth, requireTenant, allowRead(ALL_TENANT_ROLES, MANAGEMENT_ROLES));

const schema = z.object({
  description: z.string().trim().min(2).max(160),
  amount: moneySchema,
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  unitId: z.string().uuid().nullish(),
  active: z.boolean().default(true),
});
const periodError = { message: 'A data final deve ser posterior à data inicial.' };
const scope = (req: Parameters<typeof unitReadScope>[0], extra: object = {}) => ({ tenantId: req.auth!.tenantId!, ...unitReadScope(req), ...extra });

// Declared before `/:id` so that "current" is never read as an id. Returns the event in effect now, or null.
coverEventRoutes.get('/current', async (req, res, next) => {
  try {
    const now = new Date();
    const event = await prisma.coverEvent.findFirst({ where: scope(req, { active: true, startsAt: { lte: now }, endsAt: { gte: now } }), orderBy: [{ unitId: { sort: 'desc', nulls: 'last' } }, { startsAt: 'desc' }] });
    return res.json(event);
  } catch (error) { return next(error); }
});

coverEventRoutes.get('/', async (req, res, next) => {
  try {
    const query = listQuerySchema.safeParse(req.query); if (!query.success) return res.status(400).json(validationError(query.error));
    const { q, active } = query.data;
    const items = await prisma.coverEvent.findMany({ where: scope(req, { ...activeFilter(active), ...(q ? { description: { contains: q, mode: 'insensitive' } } : {}) }), orderBy: [{ startsAt: 'desc' }, { id: 'asc' }], take: 500 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

coverEventRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const startsAt = new Date(parsed.data.startsAt); const endsAt = new Date(parsed.data.endsAt);
    if (endsAt <= startsAt) return res.status(400).json(periodError);
    const unit = await resolveUnit(req, parsed.data.unitId); if ('error' in unit) return res.status(unit.status).json({ message: unit.error });
    const created = await prisma.coverEvent.create({ data: { tenantId: req.auth!.tenantId!, description: parsed.data.description, amount: parsed.data.amount, active: parsed.data.active, startsAt, endsAt, unitId: unit.unitId } });
    await audit(req, 'COVER_EVENT_CREATED', 'CoverEvent', created.id);
    return res.status(201).json(created);
  } catch (error) { return next(error); }
});

coverEventRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = schema.partial().safeParse(req.body); if (!parsed.success) return res.status(400).json(validationError(parsed.error));
    const current = await prisma.coverEvent.findFirst({ where: scope(req, { id: req.params.id }) }); if (!current) return res.status(404).json({ message: 'Evento não encontrado.' });
    const startsAt = parsed.data.startsAt ? new Date(parsed.data.startsAt) : current.startsAt;
    const endsAt = parsed.data.endsAt ? new Date(parsed.data.endsAt) : current.endsAt;
    if (endsAt <= startsAt) return res.status(400).json(periodError);
    const data: { description?: string; amount?: number; active?: boolean; startsAt: Date; endsAt: Date; unitId?: string | null } = { description: parsed.data.description, amount: parsed.data.amount, active: parsed.data.active, startsAt, endsAt };
    if (parsed.data.unitId !== undefined) {
      const unit = await resolveUnit(req, parsed.data.unitId); if ('error' in unit) return res.status(unit.status).json({ message: unit.error });
      data.unitId = unit.unitId;
    }
    const updated = await prisma.coverEvent.update({ where: { id: current.id }, data });
    await audit(req, parsed.data.active !== undefined && parsed.data.active !== current.active ? (parsed.data.active ? 'COVER_EVENT_ACTIVATED' : 'COVER_EVENT_DEACTIVATED') : 'COVER_EVENT_UPDATED', 'CoverEvent', current.id);
    return res.json(updated);
  } catch (error) { return next(error); }
});

// Orders keep the charged amount in Order.couvertFee and do not reference the event, so deleting is safe.
coverEventRoutes.delete('/:id', async (req, res, next) => {
  try {
    const current = await prisma.coverEvent.findFirst({ where: scope(req, { id: req.params.id }) }); if (!current) return res.status(404).json({ message: 'Evento não encontrado.' });
    await prisma.coverEvent.delete({ where: { id: current.id } });
    await audit(req, 'COVER_EVENT_DELETED', 'CoverEvent', current.id);
    return res.json({ deleted: true, deactivated: false });
  } catch (error) { return next(error); }
});
