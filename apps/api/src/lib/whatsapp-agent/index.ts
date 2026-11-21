import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { ChatMessage } from '../ai/chat';
import { currentAiProvider } from '../ai-provider';
import { modelAvailability } from '../ai/gateway';
import { AGENT_MODULE } from '../ai/usage';
import type { BotEnv } from '../whatsapp-bot';
import { runAgentTurn, type ActionRecord, type AgentTurnResult } from './agent';
import { agentMemorySchema, emptyMemory, loadMemory, type AgentMemory } from './memory';
import { describeInstant } from './tools/common';

export { runAgentTurn, type AgentTurnResult, type ActionRecord } from './agent';
export { loadMemory, emptyMemory, type AgentMemory } from './memory';

const HISTORY_MESSAGES = 40;
const BODY_LIMIT = 700;
const GAP_MARK_MS = 3 * 3_600_000;

// Can the attendant answer right now? When it cannot (switched off, no provider, no consent, daily budget used, provider down) the classic bot answers instead,
// so the customer is never left unattended.
export async function agentGate(env: BotEnv): Promise<{ available: true } | { available: false; reason: string }> {
  if (!env.settings.whatsapp.agent.enabled) return { available: false, reason: 'O atendente de IA está desligado nas configurações.' };
  const provider = currentAiProvider();
  if (!provider) return { available: false, reason: 'Nenhum provedor de IA configurado na plataforma.' };
  if (!provider.chat) return { available: false, reason: 'O provedor de IA configurado não oferece conversa com ferramentas.' };
  const availability = await modelAvailability({ tenantId: env.tenantId, unitId: env.unitId, userId: null }, env.settings, AGENT_MODULE);
  return availability.available ? { available: true } : { available: false, reason: availability.reason ?? 'IA indisponível no momento.' };
}

type HistoryRow = { direction: string; source: string; body: string; createdAt: Date };
// The persisted chat becomes the model's conversation. Staff and automatic messages are labelled so the model knows who said what; long silences are marked.
export function buildHistory(rows: HistoryRow[], timeZone: string): ChatMessage[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  let previous: Date | null = null;
  for (const row of rows) {
    const body = row.body.replace(/\s+\n/g, '\n').slice(0, BODY_LIMIT);
    if (!body.trim()) continue;
    const role = row.direction === 'IN' ? 'user' as const : 'assistant' as const;
    const gap = previous && row.createdAt.getTime() - previous.getTime() >= GAP_MARK_MS && role === 'user' ? `[${describeInstant(row.createdAt, timeZone).human}] ` : '';
    const text = role === 'user' ? `${gap}${body}` : row.source === 'STAFF' ? `[Atendente humano] ${body}` : row.source === 'AUTO' ? `[Aviso automático do sistema] ${body}` : body;
    previous = row.createdAt;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${text}`; else out.push({ role, content: text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function loadHistory(db: PrismaClient, conversationId: string, timeZone: string) {
  const rows = await db.whatsappChatMessage.findMany({ where: { conversationId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY_MESSAGES, select: { direction: true, source: true, body: true, createdAt: true } });
  return buildHistory(rows.reverse(), timeZone);
}

const asJson = (value: unknown) => value as Prisma.InputJsonValue;
// Runs the attendant for one stored customer message. Memory and every executed tool are persisted as they happen, so a crash or restart never loses what was done.
export async function runConversationTurn(db: PrismaClient, env: BotEnv, conversation: { id: string; phone: string | null; name: string | null; agentMemory: unknown }, inbound: { id: string; text: string }, options: { now: Date; greetingDue: boolean; returnedFromHandoff?: boolean }): Promise<AgentTurnResult> {
  const history = await loadHistory(db, conversation.id, env.settings.hours.timezone);
  if (history.length === 0 || history[history.length - 1].role !== 'user') history.push({ role: 'user', content: inbound.text });
  return runAgentTurn({
    db, env, now: options.now, dryRun: false, conversationId: conversation.id, messageId: inbound.id, text: inbound.text, history, memory: loadMemory(conversation.agentMemory),
    customer: { phone: conversation.phone, name: conversation.name }, greetingDue: options.greetingDue, returnedFromHandoff: options.returnedFromHandoff,
    saveMemory: async memory => { await db.whatsappConversation.update({ where: { id: conversation.id }, data: { agentMemory: asJson(memory) } }); },
    recordAction: async (action: ActionRecord) => {
      try { await db.whatsappAgentAction.create({ data: { tenantId: env.tenantId, conversationId: conversation.id, messageId: inbound.id, tool: action.tool, kind: action.kind, ok: action.ok, args: asJson(action.args ?? null), result: asJson(action.result ?? null), summary: action.summary, dedupeKey: action.dedupeKey ?? null, durationMs: action.durationMs } }); }
      catch (error) { if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error; }
    },
  });
}

// ---- Panel simulator: the real attendant against the real restaurant data, but nothing is written and the "conversation" lives in the browser. ----
export const simulationSessionSchema = z.object({
  memory: agentMemorySchema.optional(),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) })).max(60).default([]),
});
export type SimulationSession = z.infer<typeof simulationSessionSchema>;

export async function simulateAgentTurn(db: PrismaClient, env: BotEnv, input: { text: string; session?: SimulationSession; phone?: string | null; name?: string | null; now?: Date }) {
  const gate = await agentGate(env);
  if (!gate.available) return { available: false as const, reason: gate.reason };
  const history: ChatMessage[] = [...(input.session?.history ?? []).map(item => ({ role: item.role, content: item.content })), { role: 'user', content: input.text }];
  const memory: AgentMemory = input.session?.memory ? loadMemory(input.session.memory) : emptyMemory();
  const result = await runAgentTurn({
    db, env, now: input.now ?? new Date(), dryRun: true, conversationId: 'simulation', messageId: `sim-${Date.now().toString(36)}-${history.length}`, text: input.text, history, memory,
    customer: { phone: input.phone ?? null, name: input.name ?? null }, greetingDue: history.length <= 1, saveMemory: async () => undefined,
  });
  const reply = result.ok ? result.replies.join('\n\n') : '';
  const nextHistory = [...history, ...(reply ? [{ role: 'assistant' as const, content: reply }] : [])].slice(-60).map(item => ({ role: item.role as 'user' | 'assistant', content: item.content as string }));
  return { available: true as const, ok: result.ok, replies: result.ok ? result.replies : [], reason: result.ok ? null : result.reason, handoff: result.ok ? result.handoff : null, actions: result.actions.map(action => ({ tool: action.tool, kind: action.kind, ok: action.ok, summary: action.summary })), session: { memory: result.memory, history: nextHistory }, model: result.ok ? result.model : null };
}
