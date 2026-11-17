import { Prisma } from '@prisma/client';
import { loadSettings } from './settings';
import { localParts } from './scheduling';

// Categories without schedule rows are always visible; otherwise one row must cover the current local weekday/time.
export async function hiddenCategoryIds(tx: Pick<Prisma.TransactionClient, 'categorySchedule' | 'tenantSettings'>, tenantId: string, now = new Date()): Promise<Set<string>> {
  const rows = await tx.categorySchedule.findMany({ where: { tenantId }, select: { categoryId: true, weekday: true, startMinute: true, endMinute: true } });
  if (rows.length === 0) return new Set();
  const { weekday, minutes } = localParts(now, (await loadSettings(tx, tenantId)).hours.timezone);
  const visible = new Set<string>();
  const all = new Set<string>();
  for (const row of rows) {
    all.add(row.categoryId);
    if (row.weekday === weekday && minutes >= row.startMinute && minutes <= row.endMinute) visible.add(row.categoryId);
  }
  return new Set([...all].filter(id => !visible.has(id)));
}
