import { OrderStatus, type Prisma } from '@prisma/client';
import { z } from 'zod';
import { last8 } from '../../whatsapp-auto';
import { localParts } from '../../scheduling';
import { localToUtc, normalizeText, samePhone } from '../../whatsapp-text';
import type { ToolContext, ToolOutput } from '../types';

export const ok = (data: unknown, summary: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({ ok: true, data, summary, ...extra });
export const fail = (code: string, message: string, extra: Partial<ToolOutput> = {}): ToolOutput => ({ ok: false, error: { code, message }, summary: `${code}: ${message}`, ...extra });
export const money = (value: Prisma.Decimal | number | string) => `R$ ${Number(value).toFixed(2).replace('.', ',')}`;
export const num = (value: Prisma.Decimal | number | string | null | undefined) => (value === null || value === undefined ? null : Number(Number(value).toFixed(2)));

export const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use o formato AAAA-MM-DD');
export const timeField = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use o formato HH:mm (24 horas)');

export const tzOf = (ctx: ToolContext) => ctx.env.settings.hours.timezone;
export const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
export const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
// Calendar date + clock time as the restaurant sees them -> the exact instant.
export function toInstant(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = time.split(':').map(Number);
  return localToUtc(y, m, d, hh, mm, timeZone);
}
export function describeInstant(at: Date, timeZone: string) {
  const parts = localParts(at, timeZone);
  const time = `${String(Math.floor(parts.minutes / 60)).padStart(2, '0')}:${String(parts.minutes % 60).padStart(2, '0')}`;
  return { date: parts.day, time, weekday: WEEKDAYS[parts.weekday], human: `${WEEKDAYS[parts.weekday]}, ${dayMonth(parts.day)} às ${time}` };
}

// The WhatsApp number is the customer's identity: orders and reservations are only ever read or changed for the phone of this very conversation.
export const verifiedPhone = (ctx: ToolContext) => (ctx.customer.phone && ctx.customer.phone.replace(/\D/g, '').length >= 8 ? ctx.customer.phone : null);
export const needPhone = () => fail('PHONE_UNVERIFIED', 'Não consigo identificar o telefone deste contato do WhatsApp, então não posso consultar nem alterar pedidos ou reservas por aqui. Encaminhe para um atendente se o cliente precisar disso.');

export type OrderRow = Awaited<ReturnType<typeof loadMyOrders>>[number];
export async function loadMyOrders(ctx: ToolContext, args: { ref?: string; take?: number; days?: number } = {}) {
  const phone = verifiedPhone(ctx);
  if (!phone) return [];
  const code = args.ref?.match(/\bp-[a-z0-9]{4,}\b/i)?.[0]?.toUpperCase();
  const number = args.ref?.match(/(\d{1,9})/)?.[1];
  const rows = await ctx.db.order.findMany({
    where: { tenantId: ctx.tenantId, customer: { phone: { endsWith: last8(phone) } }, createdAt: { gte: new Date(ctx.now.getTime() - (args.days ?? 30) * 86_400_000) }, ...(code ? { code } : args.ref && number ? { number: Number(number) } : {}) },
    include: { customer: { select: { phone: true } }, deliveryJob: { select: { status: true, courierName: true, address: true } }, items: { include: { product: { select: { name: true } }, modifiers: true } }, payments: { where: { status: 'CONFIRMED' }, select: { id: true } } },
    orderBy: { createdAt: 'desc' }, take: Math.min(args.take ?? 10, 40),
  });
  return rows.filter(row => samePhone(row.customer?.phone, phone));
}

export const orderRef = (order: { number?: number | null; code: string }) => (order.number ? `#${order.number}` : order.code);
export function orderStatusTitle(ctx: ToolContext, order: { status: OrderStatus; scheduledFor: Date | null; releasedAt: Date | null; deliveryJob?: { status: string } | null }): string {
  const titles = ctx.env.settings.orderStatuses.items;
  const title = (key: string, fallback: string) => titles.find(item => item.key === key)?.title ?? fallback;
  if (order.scheduledFor && !order.releasedAt && order.status === OrderStatus.OPEN) return 'Agendado (ainda não foi para a cozinha)';
  if (order.status === OrderStatus.READY && order.deliveryJob?.status === 'PICKED_UP') return title('OUT_FOR_DELIVERY', 'Saiu para entrega');
  return { OPEN: title('ACCEPTED', 'Aceito'), PREPARING: title('PREPARING', 'Em preparo'), READY: title('READY', 'Pronto'), COMPLETED: title('COMPLETED', 'Finalizado'), CANCELLED: title('CANCELLED', 'Cancelado') }[order.status];
}

// Customer-made changes are only allowed while the kitchen has not started (or the order is still waiting for its scheduled release) and, for ordinary orders, shortly after placing.
export function orderChangeability(ctx: ToolContext, order: OrderRow): { allowed: boolean; reason?: string } {
  if (!ctx.agent.allowOrderChanges) return { allowed: false, reason: 'O restaurante não permite alterar ou cancelar pedidos pelo atendimento automático.' };
  if (order.status !== OrderStatus.OPEN) return { allowed: false, reason: `O pedido já está "${orderStatusTitle(ctx, order)}" e a cozinha já começou ou o pedido foi encerrado.` };
  if (order.channel !== 'DELIVERY' && order.channel !== 'TAKEAWAY') return { allowed: false, reason: 'Este pedido não foi feito pelo canal de entrega/retirada.' };
  if (order.payments.length > 0) return { allowed: false, reason: 'Este pedido já tem pagamento registrado; só a equipe pode alterá-lo ou cancelá-lo.' };
  const held = Boolean(order.scheduledFor && !order.releasedAt);
  if (!held && ctx.now.getTime() - order.createdAt.getTime() > ctx.agent.orderChangeWindowMinutes * 60_000) return { allowed: false, reason: `O prazo de ${ctx.agent.orderChangeWindowMinutes} minutos para alterar ou cancelar sozinho já passou.` };
  return { allowed: true };
}

export const same = (a: string, b: string) => normalizeText(a) === normalizeText(b);
export const clip = (value: string | null | undefined, max: number) => (value ? (value.length > max ? `${value.slice(0, max - 1)}…` : value) : null);
