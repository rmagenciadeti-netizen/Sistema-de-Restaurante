import { Prisma, ReservationStatus } from '@prisma/client';

// A table is considered taken for this long around a reservation (it also bounds the "same customer, same time" duplicate check).
export const RESERVATION_WINDOW_MS = 90 * 60 * 1000;
export const ACTIVE_RESERVATION_STATUSES: ReservationStatus[] = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED, ReservationStatus.SEATED];

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
