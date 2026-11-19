import { FINANCE_ROLES } from '../permissions';
import { prisma } from '../prisma';
import type { AiContext, Period, ToolResult } from './types';

export const n = (value: unknown) => Number(value ?? 0);
export const r2 = (value: number) => Math.round(value * 100) / 100;
export const brl = (value: number) => `R$ ${r2(value).toFixed(2).replace('.', ',')}`;
export const pct = (value: number | null) => (value === null ? '—' : `${r2(value).toFixed(2).replace('.', ',')}%`);
export const canSeeMoney = (ctx: AiContext) => FINANCE_ROLES.includes(ctx.role);
// The unit comes from the user's own binding; only an unbound user may narrow to a unit, and only to a unit of the same company (validated by resolveUnit).
export const unitWhere = (ctx: AiContext) => (ctx.unitId ? { unitId: ctx.unitId } : {});
export const tenantWhere = (ctx: AiContext) => ({ tenantId: ctx.tenantId, ...unitWhere(ctx) });
export const daysBetween = (period: Period) => Math.max(1, Math.round((period.to.getTime() - period.from.getTime()) / 86_400_000));
export const iso = (date: Date) => date.toISOString();

export async function resolveUnit(tenantId: string, boundUnitId: string | null, requested: string | null | undefined): Promise<string | null> {
  if (boundUnitId) return boundUnitId;
  if (!requested) return null;
  const unit = await prisma.unit.findFirst({ where: { id: requested, tenantId }, select: { id: true } });
  return unit?.id ?? null;
}

export async function unitName(ctx: AiContext) { return ctx.unitId ? (await prisma.unit.findFirst({ where: { id: ctx.unitId, tenantId: ctx.tenantId }, select: { name: true } }))?.name ?? null : null; }

export async function result(ctx: AiContext, period: Period, base: Omit<ToolResult, 'period' | 'unit'>): Promise<ToolResult> {
  return { ...base, period: { from: iso(period.from), to: iso(period.to) }, unit: (await unitName(ctx)) ?? (ctx.unitId ? ctx.unitId : 'Todas as unidades autorizadas') };
}

// Data version used in cache keys: any change in the underlying tables changes it, so stale answers are never reused.
export async function dataVersion(ctx: AiContext, parts: string[]): Promise<string> {
  const t = ctx.tenantId; const u = ctx.unitId;
  const unit = u ? { unitId: u } : {};
  const stamp = (row: { _count: number; _max: { updatedAt?: Date | null; createdAt?: Date | null } }) => `${row._count}.${(row._max.updatedAt ?? row._max.createdAt)?.getTime() ?? 0}`;
  const queries: Record<string, () => Promise<string>> = {
    orders: async () => stamp(await prisma.order.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { updatedAt: true } })),
    items: async () => stamp(await prisma.orderItem.aggregate({ where: { order: { tenantId: t, ...unit } }, _count: true, _max: { updatedAt: true } })),
    finance: async () => stamp(await prisma.financialEntry.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { updatedAt: true } })) + '/' + stamp(await prisma.payment.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { paidAt: true } as never })),
    ingredients: async () => stamp(await prisma.ingredient.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { updatedAt: true } })),
    stockMovements: async () => stamp(await prisma.stockMovement.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { createdAt: true } })),
    products: async () => stamp(await prisma.product.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { updatedAt: true } })) + '/' + stamp(await prisma.productPricing.aggregate({ where: { tenantId: t }, _count: true, _max: { updatedAt: true } })),
    purchases: async () => stamp(await prisma.purchaseOrder.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { receivedAt: true } as never })),
    customers: async () => stamp(await prisma.customer.aggregate({ where: { tenantId: t }, _count: true, _max: { updatedAt: true } })),
    delivery: async () => stamp(await prisma.deliveryJob.aggregate({ where: { tenantId: t, ...unit }, _count: true, _max: { updatedAt: true } })),
    settings: async () => stamp(await prisma.tenantSettings.aggregate({ where: { tenantId: t }, _count: true, _max: { updatedAt: true } })),
  };
  return (await Promise.all(parts.map(async part => `${part}:${await queries[part]()}`))).join(';');
}
