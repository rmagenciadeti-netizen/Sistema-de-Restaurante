import { Prisma, PrismaClient } from '@prisma/client';
import { loadSettings } from './settings';
import { loadBotEnv, respond, type BotResult, type BotState } from './whatsapp-bot';

export type InboundInput = { tenantId: string; jid: string; phone: string | null; name: string | null; text: string; externalId?: string | null };
export type InboundOutcome = { conversationId: string | null; replies: string[]; intent: string; duplicate?: boolean };

const STATE_TTL_MS = 30 * 60 * 1000;

export async function recordOutbound(db: Prisma.TransactionClient | PrismaClient, tenantId: string, conversationId: string, body: string, source: 'BOT' | 'STAFF' | 'AUTO', externalId?: string | null) {
  await db.whatsappChatMessage.create({ data: { tenantId, conversationId, direction: 'OUT', source, body: body.slice(0, 4000), externalId: externalId ?? null } });
  await db.whatsappConversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });
}

export async function findOrCreateConversation(db: PrismaClient | Prisma.TransactionClient, tenantId: string, jid: string, phone: string | null, name: string | null) {
  return db.whatsappConversation.upsert({ where: { tenantId_jid: { tenantId, jid } }, create: { tenantId, jid, phone, name }, update: { ...(name ? { name } : {}), ...(phone ? { phone } : {}) } });
}

// Stores the customer's message and, when the bot is on and no human is handling the chat, computes the replies.
// The caller sends the replies and then calls recordOutbound for each one that was really delivered.
export async function processInbound(db: PrismaClient, input: InboundInput, now = new Date()): Promise<InboundOutcome> {
  const text = input.text.trim();
  if (!text) return { conversationId: null, replies: [], intent: 'empty' };
  if (input.externalId && await db.whatsappChatMessage.findFirst({ where: { tenantId: input.tenantId, externalId: input.externalId }, select: { id: true } })) return { conversationId: null, replies: [], intent: 'duplicate', duplicate: true };

  const conversation = await findOrCreateConversation(db, input.tenantId, input.jid, input.phone, input.name);
  const previousMessageAt = conversation.lastMessageAt;
  await db.whatsappChatMessage.create({ data: { tenantId: input.tenantId, conversationId: conversation.id, direction: 'IN', source: 'CUSTOMER', body: text.slice(0, 4000), externalId: input.externalId ?? null } });
  await db.whatsappConversation.update({ where: { id: conversation.id }, data: { unread: { increment: 1 }, lastMessageAt: now } });

  const settings = await loadSettings(db, input.tenantId);
  if (!settings.whatsapp.botEnabled) return { conversationId: conversation.id, replies: [], intent: 'bot_disabled' };

  if (conversation.handoff) {
    if (!conversation.handoffUntil || conversation.handoffUntil > now) return { conversationId: conversation.id, replies: [], intent: 'handoff_active' };
    await db.whatsappConversation.update({ where: { id: conversation.id }, data: { handoff: false, handoffUntil: null } });
  }

  const wantsBack = /^(voltar|iniciar|retomar)$/i.test(text);
  if (conversation.optOut && !wantsBack) return { conversationId: conversation.id, replies: [], intent: 'opted_out' };

  const env = await loadBotEnv(db, input.tenantId, now);
  const stale = now.getTime() - previousMessageAt.getTime() > STATE_TTL_MS;
  const state = !stale && conversation.stateData ? conversation.stateData as unknown as BotState : null;
  const greetDue = !conversation.lastGreetingAt || now.getTime() - conversation.lastGreetingAt.getTime() > settings.whatsapp.greetingCooldownHours * 3_600_000;
  const result: BotResult = await respond(db, env, { text, phone: input.phone, name: input.name ?? conversation.name, state, greetDue }, { now });

  await db.whatsappConversation.update({
    where: { id: conversation.id },
    data: {
      stateData: result.state ? result.state as unknown as Prisma.InputJsonObject : Prisma.JsonNull,
      ...(result.handoff ? { handoff: true, handoffUntil: new Date(now.getTime() + settings.whatsapp.handoffMinutes * 60_000) } : {}),
      ...(result.optOut ? { optOut: true } : {}), ...(result.optIn ? { optOut: false } : {}),
      ...(result.greeted ? { lastGreetingAt: now } : {}),
    },
  });
  return { conversationId: conversation.id, replies: result.replies, intent: result.intent };
}
