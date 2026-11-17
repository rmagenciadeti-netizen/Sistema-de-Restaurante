import { OrderStatus, Prisma } from '@prisma/client';
import { enqueueProductionPrints } from './print-queue';
import { ORDER_INCLUDE } from './order-engine-shared';
import type { TenantSettingsData } from './settings';

export type ScheduleConfig = TenantSettingsData['scheduling'];

const MIN_LEAD_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_DAYS_AHEAD = 30;

export function parseLeadMinutes(leadTime: string): number {
  const [hours, minutes] = leadTime.split(':').map(Number);
  return hours * 60 + minutes;
}

// Weekday (0 = Sunday) and minutes since midnight of an instant, as seen in the restaurant's time zone.
export function localParts(date: Date, timeZone: string): { weekday: number; minutes: number; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { weekday, minutes: Number(get('hour')) * 60 + Number(get('minute')), day: `${get('year')}-${get('month')}-${get('day')}` };
}

const toMinutes = (value: string) => parseLeadMinutes(value);

export type ScheduleDecision =
  | { ok: true; releaseAt: Date; releaseNow: boolean }
  | { ok: false; reason: 'SCHEDULING_DISABLED' | 'SCHEDULE_TOO_SOON' | 'SCHEDULE_TOO_FAR' | 'SCHEDULE_BLOCKED' | 'SCHEDULE_OUTSIDE_SLOTS' };

// Pure rule check so API, public store and tests share the same decision.
export function decideSchedule(scheduledFor: Date, config: ScheduleConfig, timeZone: string, now = new Date(), prepMinutes = 0): ScheduleDecision {
  if (!config.enabled) return { ok: false, reason: 'SCHEDULING_DISABLED' };
  if (scheduledFor.getTime() < now.getTime() + MIN_LEAD_MS) return { ok: false, reason: 'SCHEDULE_TOO_SOON' };
  const maxDays = config.maxDaysAhead > 0 ? config.maxDaysAhead : DEFAULT_MAX_DAYS_AHEAD;
  if (scheduledFor.getTime() > now.getTime() + maxDays * 24 * 60 * 60 * 1000) return { ok: false, reason: 'SCHEDULE_TOO_FAR' };
  const local = localParts(scheduledFor, timeZone);
  if (config.blockedFrom && config.blockedTo && local.day >= config.blockedFrom && local.day <= config.blockedTo) return { ok: false, reason: 'SCHEDULE_BLOCKED' };
  if (config.slots.length > 0 && !config.slots.some(slot => slot.day === local.weekday && local.minutes >= toMinutes(slot.start) && local.minutes <= toMinutes(slot.end))) return { ok: false, reason: 'SCHEDULE_OUTSIDE_SLOTS' };
  const leadMinutes = Math.max(parseLeadMinutes(config.leadTime), prepMinutes);
  const releaseAt = new Date(scheduledFor.getTime() - leadMinutes * 60 * 1000);
  return { ok: true, releaseAt, releaseNow: releaseAt.getTime() <= now.getTime() };
}

export function isHeldOrder(order: { scheduledFor: Date | null; releasedAt: Date | null }) {
  return order.scheduledFor !== null && order.releasedAt === null;
}

// Releasing a scheduled order is what makes it appear on the KDS and print on production sectors.
export async function releaseOrder(tx: Prisma.TransactionClient, orderId: string, tenantId: string, actorUserId: string | null, now = new Date()) {
  const claimed = await tx.order.updateMany({ where: { id: orderId, tenantId, status: OrderStatus.OPEN, scheduledFor: { not: null }, releasedAt: null }, data: { releasedAt: now } });
  if (claimed.count !== 1) return false;
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
  await enqueueProductionPrints(tx, order, { onlyAutoPrint: true });
  await tx.auditLog.create({ data: { tenantId, actorUserId, action: 'ORDER_RELEASED', entityType: 'Order', entityId: orderId, metadata: { scheduledFor: order.scheduledFor?.toISOString() ?? null } } });
  return true;
}

type Db = Pick<Prisma.TransactionClient, 'order'> & { $transaction: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T> };

// Releases every scheduled order whose release time has arrived. Safe to run from the worker and lazily from list endpoints.
export async function releaseDueOrders(db: Db, options: { tenantId?: string; now?: Date } = {}): Promise<number> {
  const now = options.now ?? new Date();
  const due = await db.order.findMany({ where: { ...(options.tenantId ? { tenantId: options.tenantId } : {}), status: OrderStatus.OPEN, scheduledFor: { not: null }, releasedAt: null, releaseAt: { lte: now } }, select: { id: true, tenantId: true }, take: 200 });
  let released = 0;
  for (const order of due) if (await db.$transaction(tx => releaseOrder(tx, order.id, order.tenantId, null, now))) released += 1;
  return released;
}

// Whether the store accepts orders right now according to the configured opening mode and weekly hours.
export function isStoreOpen(hours: TenantSettingsData['hours'], now = new Date()): boolean {
  if (hours.mode === 'OPEN') return true;
  if (hours.mode === 'CLOSED') return false;
  const local = localParts(now, hours.timezone);
  return hours.weekly.some(slot => slot.day === local.weekday && local.minutes >= toMinutes(slot.start) && local.minutes <= toMinutes(slot.end));
}
