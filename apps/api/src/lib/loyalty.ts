import { LoyaltyEntryType, Prisma } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { TenantSettingsData } from './settings';

export type LoyaltyConfig = TenantSettingsData['loyalty'];
type Tx = Prisma.TransactionClient;
const DAY = 86_400_000;

// Pure rules (unit-tested): everything below the DB helpers is deterministic so the owner can audit why a customer has a given balance.
export const pointsForOrder = (total: number, config: LoyaltyConfig) => (config.enabled ? Math.max(0, Math.floor(total * config.pointsPerReal)) : 0);
export const redeemValue = (points: number, config: LoyaltyConfig) => Math.round(points * config.redeemValuePerPoint * 100) / 100;
export const idleExpired = (lastEarnAt: Date | null, config: LoyaltyConfig, now: Date) => config.validityDays > 0 && lastEarnAt !== null && now.getTime() - lastEarnAt.getTime() > config.validityDays * DAY;
// birthDate is a calendar date (stored as UTC midnight), so month/day are read in UTC.
export const isBirthdayMonth = (birthDate: Date | null, now: Date) => birthDate !== null && birthDate.getUTCMonth() === now.getUTCMonth();
export const daysSince = (date: Date | null, now: Date) => (date ? Math.floor((now.getTime() - date.getTime()) / DAY) : null);
export const newCouponCode = () => `FID-${randomBytes(4).toString('hex').toUpperCase()}`;

async function record(tx: Tx, data: { tenantId: string; customerId: string; type: LoyaltyEntryType; points: number; balanceAfter: number; orderId?: string | null; note?: string | null; actorUserId?: string | null; couponCode?: string | null }) {
  return tx.loyaltyEntry.create({ data: { orderId: null, note: null, actorUserId: null, couponCode: null, ...data } });
}

// Points for a completed order. Idempotent per order: an order that already has an EARN entry is never credited twice.
export async function earnForOrder(tx: Tx, order: { id: string; tenantId: string; customerId: string; total: Prisma.Decimal }, config: LoyaltyConfig) {
  const points = pointsForOrder(order.total.toNumber(), config);
  if (points <= 0) return null;
  if (await tx.loyaltyEntry.findFirst({ where: { tenantId: order.tenantId, orderId: order.id, type: LoyaltyEntryType.EARN }, select: { id: true } })) return null;
  const customer = await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { increment: points } }, select: { loyaltyPoints: true } });
  return record(tx, { tenantId: order.tenantId, customerId: order.customerId, type: LoyaltyEntryType.EARN, points, balanceAfter: customer.loyaltyPoints, orderId: order.id });
}

// A cancelled order gives back what it earned (never below zero) so points always match real, kept sales.
export async function reverseForOrder(tx: Tx, order: { id: string; tenantId: string; customerId: string }) {
  const earned = await tx.loyaltyEntry.findFirst({ where: { tenantId: order.tenantId, orderId: order.id, type: LoyaltyEntryType.EARN }, select: { points: true } });
  if (!earned) return null;
  if (await tx.loyaltyEntry.findFirst({ where: { tenantId: order.tenantId, orderId: order.id, type: LoyaltyEntryType.REVERSAL }, select: { id: true } })) return null;
  const current = await tx.customer.findUnique({ where: { id: order.customerId }, select: { loyaltyPoints: true } });
  if (!current) return null;
  const points = Math.min(earned.points, current.loyaltyPoints);
  const customer = await tx.customer.update({ where: { id: order.customerId }, data: { loyaltyPoints: { decrement: points } }, select: { loyaltyPoints: true } });
  return record(tx, { tenantId: order.tenantId, customerId: order.customerId, type: LoyaltyEntryType.REVERSAL, points: -points, balanceAfter: customer.loyaltyPoints, orderId: order.id, note: 'Pedido cancelado' });
}

// Idle expiry: when the last EARN is older than `validityDays`, the whole balance expires (recorded, never silent).
export async function expireIfIdle(tx: Tx, tenantId: string, customerId: string, config: LoyaltyConfig, now = new Date()) {
  if (config.validityDays <= 0) return null;
  const customer = await tx.customer.findFirst({ where: { id: customerId, tenantId }, select: { loyaltyPoints: true } });
  if (!customer || customer.loyaltyPoints <= 0) return null;
  const lastEarn = await tx.loyaltyEntry.findFirst({ where: { tenantId, customerId, type: LoyaltyEntryType.EARN }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!idleExpired(lastEarn?.createdAt ?? null, config, now)) return null;
  const updated = await tx.customer.updateMany({ where: { id: customerId, tenantId, loyaltyPoints: customer.loyaltyPoints }, data: { loyaltyPoints: 0 } });
  if (updated.count !== 1) return null;
  return record(tx, { tenantId, customerId, type: LoyaltyEntryType.EXPIRE, points: -customer.loyaltyPoints, balanceAfter: 0, note: `Sem compras há mais de ${config.validityDays} dias` });
}

export class LoyaltyError extends Error { constructor(readonly code: string, message: string) { super(message); } }

// Redeems points as a single-use fixed-value coupon, reusing the restaurant's existing coupon engine at checkout.
export async function redeemPoints(tx: Tx, input: { tenantId: string; customerId: string; points: number; actorUserId: string }, config: LoyaltyConfig, now = new Date()) {
  if (!config.enabled) throw new LoyaltyError('DISABLED', 'O programa de fidelidade está desativado');
  await expireIfIdle(tx, input.tenantId, input.customerId, config, now);
  if (input.points < config.minRedeemPoints) throw new LoyaltyError('BELOW_MINIMUM', `O resgate mínimo é de ${config.minRedeemPoints} pontos`);
  const value = redeemValue(input.points, config);
  if (value <= 0) throw new LoyaltyError('NO_VALUE', 'Os pontos não têm valor de resgate configurado');
  const debited = await tx.customer.updateMany({ where: { id: input.customerId, tenantId: input.tenantId, active: true, loyaltyPoints: { gte: input.points } }, data: { loyaltyPoints: { decrement: input.points } } });
  if (debited.count !== 1) throw new LoyaltyError('INSUFFICIENT', 'Saldo de pontos insuficiente');
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId }, select: { loyaltyPoints: true } });
  const code = newCouponCode();
  await tx.coupon.create({ data: { tenantId: input.tenantId, code, type: 'FIXED', value, maxUses: 1, validUntil: new Date(now.getTime() + config.couponValidDays * DAY) } });
  await record(tx, { tenantId: input.tenantId, customerId: input.customerId, type: LoyaltyEntryType.REDEEM, points: -input.points, balanceAfter: customer.loyaltyPoints, actorUserId: input.actorUserId, couponCode: code, note: `Cupom de R$ ${value.toFixed(2)}` });
  return { code, value, balance: customer.loyaltyPoints, validUntil: new Date(now.getTime() + config.couponValidDays * DAY) };
}

// Manual correction by a manager: always justified and never allowed to take the balance below zero.
export async function adjustPoints(tx: Tx, input: { tenantId: string; customerId: string; points: number; note: string; actorUserId: string }) {
  if (input.points < 0) {
    const debited = await tx.customer.updateMany({ where: { id: input.customerId, tenantId: input.tenantId, loyaltyPoints: { gte: -input.points } }, data: { loyaltyPoints: { increment: input.points } } });
    if (debited.count !== 1) throw new LoyaltyError('INSUFFICIENT', 'O ajuste deixaria o saldo negativo');
  } else {
    const credited = await tx.customer.updateMany({ where: { id: input.customerId, tenantId: input.tenantId }, data: { loyaltyPoints: { increment: input.points } } });
    if (credited.count !== 1) throw new LoyaltyError('NOT_FOUND', 'Cliente não encontrado');
  }
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: input.customerId }, select: { loyaltyPoints: true } });
  return record(tx, { tenantId: input.tenantId, customerId: input.customerId, type: LoyaltyEntryType.ADJUST, points: input.points, balanceAfter: customer.loyaltyPoints, note: input.note, actorUserId: input.actorUserId });
}
