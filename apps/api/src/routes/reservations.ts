import { Router } from 'express';
import { ReservationStatus } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { serializable } from '../lib/serializable';
import { requireAuth, requireTenant } from '../middleware/auth';
import { requireRoles, SALES_ROLES } from '../lib/permissions';
import { enqueueAutoMessage } from '../lib/whatsapp-auto';
import { loadSettings } from '../lib/settings';
import { formatLocal } from '../lib/whatsapp-text';
import { ACTIVE_RESERVATION_STATUSES as ACTIVE_STATUSES, RESERVATION_WINDOW_MS, tableConflict as tableConflictIn } from '../lib/reservations';

export { RESERVATION_WINDOW_MS };

export const reservationRoutes = Router();
reservationRoutes.use(requireAuth, requireTenant, requireRoles(...SALES_ROLES));
const schema = z.object({ unitId: z.string().uuid().optional(), tableId: z.string().uuid().optional(), customerName: z.string().min(2).max(160), phone: z.string().max(30).optional(), partySize: z.number().int().min(1).max(500), reservedAt: z.string().datetime(), notes: z.string().max(500).optional() });
const unitScope = (req: { auth?: { unitId: string | null } }) => (req.auth!.unitId ? { unitId: req.auth!.unitId } : {});

reservationRoutes.get('/', async (req, res, next) => {
  try {
    const day = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? new Date(`${req.query.date}T00:00:00.000Z`) : null;
    const range = day ? { reservedAt: { gte: day, lt: new Date(day.getTime() + 24 * 60 * 60 * 1000) } } : { reservedAt: { gte: new Date(Date.now() - 6 * 60 * 60 * 1000) } };
    const items = await prisma.reservation.findMany({ where: { tenantId: req.auth!.tenantId!, ...unitScope(req), ...range }, include: { table: { select: { id: true, label: true } } }, orderBy: { reservedAt: 'asc' }, take: 200 });
    return res.json({ items, total: items.length });
  } catch (error) { return next(error); }
});

const tableConflict = tableConflictIn;

reservationRoutes.post('/', async (req, res, next) => {
  try {
    const parsed = schema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!; const unitId = parsed.data.unitId ?? req.auth!.unitId;
    if (!unitId) return res.status(400).json({ message: 'unitId is required' });
    if (req.auth!.unitId && unitId !== req.auth!.unitId) return res.status(403).json({ message: 'Unit access denied' });
    const reservedAt = new Date(parsed.data.reservedAt);
    if (reservedAt.getTime() < Date.now() - 60 * 1000) return res.status(400).json({ message: 'reservedAt must be in the future' });
    const result = await serializable(prisma, async tx => {
      if (!await tx.unit.findFirst({ where: { id: unitId, tenantId } })) return { status: 400, message: 'Unit does not belong to this tenant' } as const;
      if (parsed.data.tableId) {
        const table = await tx.restaurantTable.findFirst({ where: { id: parsed.data.tableId, tenantId, unitId, active: true } });
        if (!table) return { status: 400, message: 'Table unavailable in this unit' } as const;
        if (parsed.data.partySize > table.seats) return { status: 400, message: 'Party size exceeds table capacity' } as const;
        if (await tableConflict(tx, tenantId, table.id, reservedAt)) return { status: 409, message: 'Table already reserved around this time' } as const;
      }
      const { unitId: _ignored, reservedAt: _at, ...data } = parsed.data;
      return { status: 201, reservation: await tx.reservation.create({ data: { ...data, tenantId, unitId, reservedAt } }) } as const;
    });
    if (result.status !== 201) return res.status(result.status).json({ message: result.message });
    return res.status(201).json(result.reservation);
  } catch (error) { return next(error); }
});

reservationRoutes.patch('/:id', async (req, res, next) => {
  try {
    const parsed = z.object({ status: z.nativeEnum(ReservationStatus), tableId: z.string().uuid().nullable() }).partial().safeParse(req.body); if (!parsed.success) return res.status(400).json({ message: 'Validation failed', errors: parsed.error.flatten() });
    const tenantId = req.auth!.tenantId!;
    const result = await serializable(prisma, async tx => {
      const current = await tx.reservation.findFirst({ where: { id: req.params.id, tenantId, ...unitScope(req) } });
      if (!current) return { status: 404, message: 'Reservation not found' } as const;
      if (!ACTIVE_STATUSES.includes(current.status)) return { status: 409, message: 'Reservation is closed' } as const;
      if (parsed.data.tableId) {
        const table = await tx.restaurantTable.findFirst({ where: { id: parsed.data.tableId, tenantId, unitId: current.unitId, active: true } });
        if (!table) return { status: 400, message: 'Table unavailable in this unit' } as const;
        if (current.partySize > table.seats) return { status: 400, message: 'Party size exceeds table capacity' } as const;
        if (await tableConflict(tx, tenantId, table.id, current.reservedAt, current.id)) return { status: 409, message: 'Table already reserved around this time' } as const;
      }
      const updated = await tx.reservation.update({ where: { id: current.id }, data: parsed.data });
      if (parsed.data.status === ReservationStatus.CONFIRMED && current.status !== ReservationStatus.CONFIRMED && current.phone) {
        const settings = await loadSettings(tx, tenantId);
        await enqueueAutoMessage(tx, { tenantId, key: 'reservation_confirmed', phone: current.phone, vars: { nome: current.customerName.split(' ')[0], data: formatLocal(current.reservedAt, settings.hours.timezone), pessoas: current.partySize } });
      }
      return { status: 200, reservation: updated } as const;
    });
    if (result.status !== 200) return res.status(result.status).json({ message: result.message });
    return res.json(result.reservation);
  } catch (error) { return next(error); }
});
