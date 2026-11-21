import { z } from 'zod';

// Persistent memory of the attendant for ONE conversation (tenant + WhatsApp contact), stored in WhatsappConversation.agentMemory. It survives worker restarts and
// reconnections, is never shared between customers, and keeps each subject in its own section so one operation never blocks another conversation topic.
const text = (max: number) => z.string().trim().max(max);
const draftItem = z.object({
  id: z.string().max(40), productId: z.string().max(60), name: text(120), quantity: z.number().positive().max(999), weightKg: z.number().positive().max(999.999).optional(),
  optionIds: z.array(z.string().max(60)).max(20).default([]), optionNames: z.array(text(80)).max(20).default([]), notes: text(200).optional(),
});
export const PENDING_ACTIONS = ['place_order', 'cancel_order', 'modify_order', 'cancel_reservation'] as const;
const pending = z.object({ id: z.string().max(40), action: z.enum(PENDING_ACTIONS), targetId: z.string().max(60).optional(), hash: z.string().max(80), summary: text(700), proposedAtMessageId: z.string().max(60), expiresAt: z.string().max(40) });
const stamp = z.string().max(40).optional();

const profile = z.object({ name: text(60).optional(), phone: text(20).optional(), addresses: z.array(text(300)).max(3).default([]), preferences: z.array(text(160)).max(10).default([]) });
const reservation = z.object({ partySize: z.number().int().min(1).max(500).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional(), name: text(80).optional(), notes: text(300).optional(), lastReservationId: z.string().max(60).optional(), lastReservationSummary: text(200).optional(), updatedAt: stamp });
const order = z.object({
  items: z.array(draftItem).max(30).default([]), fulfillment: z.enum(['DELIVERY', 'TAKEAWAY']).optional(), notes: text(300).optional(), scheduledFor: z.string().max(40).optional(), couponCode: text(40).optional(),
  lastOrderId: z.string().max(60).optional(), lastOrderNumber: z.string().max(20).optional(), lastOrderAt: stamp, updatedAt: stamp,
});
const delivery = z.object({ address: text(300).optional(), neighborhood: text(80).optional(), zoneId: z.string().max(60).optional(), zoneName: text(80).optional(), fee: z.number().min(0).optional(), updatedAt: stamp });
const payment = z.object({ methodId: z.string().max(60).optional(), methodName: text(60).optional(), changeFor: z.number().positive().max(99999).optional(), updatedAt: stamp });
const support = z.object({ handoff: z.object({ reason: text(200), summary: text(800), at: z.string().max(40) }).optional(), topics: z.array(text(80)).max(6).default([]) });

export const agentMemorySchema = z.object({
  v: z.number().default(1),
  profile: profile.catch({ addresses: [], preferences: [] }),
  facts: z.array(text(200)).max(20).catch([]),
  reservation: reservation.catch({}),
  order: order.catch({ items: [] }),
  delivery: delivery.catch({}),
  payment: payment.catch({}),
  support: support.catch({ topics: [] }),
  pending: z.array(pending).max(4).catch([]),
  summary: text(2500).optional().catch(undefined),
  summarizedUntil: z.string().max(40).optional().catch(undefined),
  turns: z.number().int().min(0).catch(0),
});
export type AgentMemory = z.infer<typeof agentMemorySchema>;
export type DraftItem = z.infer<typeof draftItem>;
export type PendingAction = z.infer<typeof pending>;

export const emptyMemory = (): AgentMemory => agentMemorySchema.parse({});
export function loadMemory(raw: unknown): AgentMemory {
  const parsed = agentMemorySchema.safeParse(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {});
  return parsed.success ? parsed.data : emptyMemory();
}

const HOUR = 3_600_000;
export const ORDER_DRAFT_TTL_MS = 6 * HOUR;
export const RESERVATION_DRAFT_TTL_MS = 48 * HOUR;
export const PENDING_TTL_MS = 30 * 60_000;
const age = (value: string | undefined, now: Date) => (value ? now.getTime() - Date.parse(value) : 0);

// Drafts and confirmations go stale (a cart from yesterday must not surprise the customer); facts, profile and the history summary do not.
export function pruneMemory(memory: AgentMemory, now: Date): AgentMemory {
  const next: AgentMemory = structuredClone(memory);
  next.pending = next.pending.filter(item => Date.parse(item.expiresAt) > now.getTime());
  if (next.order.items.length > 0 && age(next.order.updatedAt, now) > ORDER_DRAFT_TTL_MS) { next.order.items = []; next.order.scheduledFor = undefined; next.order.couponCode = undefined; next.order.notes = undefined; next.delivery = {}; next.payment = {}; }
  if (age(next.reservation.updatedAt, now) > RESERVATION_DRAFT_TTL_MS) next.reservation = { lastReservationId: next.reservation.lastReservationId, lastReservationSummary: next.reservation.lastReservationSummary };
  return next;
}

export const touch = (now: Date) => now.toISOString();

export function rememberFact(memory: AgentMemory, fact: string) {
  const clean = fact.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (clean.length < 3 || memory.facts.some(item => item.toLowerCase() === clean.toLowerCase())) return;
  memory.facts = [...memory.facts, clean].slice(-20);
}
export function addAddress(memory: AgentMemory, address: string) {
  const clean = address.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (clean.length < 5 || memory.profile.addresses.some(item => item.toLowerCase() === clean.toLowerCase())) return;
  memory.profile.addresses = [clean, ...memory.profile.addresses].slice(0, 3);
}
