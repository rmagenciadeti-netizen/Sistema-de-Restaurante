import { Prisma, ReservationStatus } from '@prisma/client';
import { localParts } from './scheduling';
import type { TenantSettingsData } from './settings';

// A table is considered taken for this long around a reservation (it also bounds the "same customer, same time" duplicate check).
export const RESERVATION_WINDOW_MS = 90 * 60 * 1000;
export const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.SEATED];

const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
// Is the restaurant open at this local day/time? Only the weekly schedule mode restricts reservations. Shared by the AI attendant and the classic bot.
export function openingHoursCheck(hours: TenantSettingsData['hours'], at: Date): { ok: true } | { ok: false; code: 'CLOSED' | 'OUTSIDE_HOURS'; message: string } {
  if (hours.mode === 'CLOSED') return { ok: false, code: 'CLOSED', message: 'O restaurante está temporariamente fechado e não está aceitando reservas agora.' };
  if (hours.mode === 'OPEN') return { ok: true };
  const p = localParts(at, hours.timezone);
  const slots = hours.weekly.filter(slot => slot.day === p.weekday);
  const mins = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  if (slots.some(slot => p.minutes >= mins(slot.start) && p.minutes <= mins(slot.end))) return { ok: true };
  return { ok: false, code: 'OUTSIDE_HOURS', message: slots.length ? `Nesse dia (${WEEKDAY_NAMES[p.weekday]}) o restaurante funciona ${slots.map(slot => `das ${slot.start} às ${slot.end}`).join(' e ')}.` : `O restaurante não abre ${WEEKDAY_NAMES[p.weekday]}.` };
}

type Tx = Pick<Prisma.TransactionClient, 'reservation' | 'restaurantTable'>;

export async function tableConflict(tx: Tx, tenantId: string, tableId: string, reservedAt: Date, ignoreId?: string) {
  return tx.reservation.findFirst({ where: { tenantId, tableId, status: { in: ACTIVE_RESERVATION_STATUSES }, ...(ignoreId ? { id: { not: ignoreId } } : {}), reservedAt: { gt: new Date(reservedAt.getTime() - RESERVATION_WINDOW_MS), lt: new Date(reservedAt.getTime() + RESERVATION_WINDOW_MS) } } });
}

export const unitHasTables = async (tx: Tx, tenantId: string, unitId: string) => (await tx.restaurantTable.count({ where: { tenantId, unitId, active: true } })) > 0;

// Smallest active table that seats the party and is free around `at`.
export async function findFreeTable(tx: Tx, args: { tenantId: string; unitId: string; partySize: number; at: Date; ignoreId?: string }) {
  const tables = await tx.restaurantTable.findMany({ where: { tenantId: args.tenantId, unitId: args.unitId, active: true, seats: { gte: args.partySize } }, orderBy: [{ seats: 'asc' }, { label: 'asc' }], select: { id: true, label: true, seats: true } });
  for (const table of tables) if (!await tableConflict(tx, args.tenantId, table.id, args.at, args.ignoreId)) return table;
  return null;
}
