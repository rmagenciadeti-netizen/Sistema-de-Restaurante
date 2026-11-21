import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { ChatMessage, ToolCall } from '../ai/chat';
import { callChat } from '../ai/gateway';
import { AGENT_MODULE } from '../ai/usage';
import { renderTemplate } from '../whatsapp-messages';
import type { BotEnv } from '../whatsapp-bot';
import { chunkMessage, matchScore, normalizeText } from '../whatsapp-text';
import { pruneMemory, type AgentMemory } from './memory';
import { buildSystemPrompt } from './prompt';
import { cleanReply, receiptFor, unbackedClaims, type Executed } from './safety';
import { fail } from './tools/common';
import { toolsFor, toSpec } from './tools';
import type { ToolContext, ToolKind, ToolOutput } from './types';

export const MAX_STEPS = 7;
const MAX_CALLS_PER_STEP = 6;
const MAX_CALLS_PER_TURN = 14;
// Generous for hosted models (a call takes seconds); raise both for slow or self-hosted ones.
const TURN_BUDGET_MS = Math.max(15_000, Number(process.env.WHATSAPP_AGENT_TURN_BUDGET_MS) || 75_000);
const CALL_TIMEOUT_MS = Math.max(5_000, Number(process.env.WHATSAPP_AGENT_CALL_TIMEOUT_MS) || 40_000);
const RESULT_LIMIT = 7000;

export type ActionRecord = { tool: string; kind: ToolKind | 'PROPOSAL'; ok: boolean; args: unknown; result: unknown; summary: string; dedupeKey?: string; durationMs: number; duplicate?: boolean };
export type AgentTurnArgs = {
  db: PrismaClient; env: BotEnv; now: Date; dryRun: boolean;
  conversationId: string; messageId: string; text: string; history: ChatMessage[]; memory: AgentMemory;
  customer: { phone: string | null; name: string | null }; greetingDue: boolean; returnedFromHandoff?: boolean;
  saveMemory(memory: AgentMemory): Promise<void>; recordAction?(action: ActionRecord): Promise<void>;
};
export type AgentTurnResult =
  | { ok: true; replies: string[]; memory: AgentMemory; handoff: { reason: string; summary: string } | null; optOut?: boolean; actions: ActionRecord[]; steps: number; model: string | null }
  | { ok: false; code: string; reason: string; memory: AgentMemory; actions: ActionRecord[] };

const stable = (value: unknown): string => JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const zodSummary = (error: { issues: { path: PropertyKey[]; message: string }[] }) => error.issues.slice(0, 4).map(issue => `${issue.path.join('.') || '(argumentos)'}: ${issue.message}`).join('; ');

function serialize(out: ToolOutput): string {
  const body = JSON.stringify({ ok: out.ok, ...(out.ok ? {} : { error: out.error }), ...(out.data !== undefined ? { data: out.data } : {}), ...(out.duplicate ? { duplicate: true } : {}) });
  return body.length > RESULT_LIMIT ? `${body.slice(0, RESULT_LIMIT)}…[resultado truncado; refine a consulta]` : body;
}

// Knowledge entries that look relevant to what the customer just said (a small base is sent whole).
async function relevantKnowledge(db: PrismaClient, tenantId: string, text: string) {
  const entries = await db.whatsappKnowledge.findMany({ where: { tenantId, active: true }, take: 300, orderBy: { hits: 'desc' } });
  if (entries.length <= 8) return entries.map(entry => ({ title: entry.title, answer: entry.answer }));
  const padded = ` ${normalizeText(text)} `;
  return entries.map(entry => {
    let score = matchScore(text, entry.title) + matchScore(text, entry.keywords.join(' '));
    for (const keyword of entry.keywords) { const k = normalizeText(keyword); if (k && padded.includes(` ${k} `)) score += 2; }
    return { entry, score };
  }).filter(item => item.score >= 1).sort((a, b) => b.score - a.score).slice(0, 6).map(item => ({ title: item.entry.title, answer: item.entry.answer }));
}

// One customer message, from the model's first thought to the reply. The model decides what to look up and what to do; the backend decides what is allowed,
// does the real work through tools, and checks that the words sent to the customer match what really happened.
export async function runAgentTurn(args: AgentTurnArgs): Promise<AgentTurnResult> {
  const { env, now } = args;
  const agent = env.settings.whatsapp.agent;
  const memory = pruneMemory(args.memory, now);
  const tools = toolsFor(agent); const byName = new Map(tools.map(tool => [tool.name, tool])); const specs = tools.map(toSpec);
  const actions: ActionRecord[] = []; const executed: Executed[] = [];
  const persist = async () => { if (!args.dryRun) await args.saveMemory(memory); };
  const ctx: ToolContext = { db: args.db, env, agent, now, dryRun: args.dryRun, tenantId: env.tenantId, unitId: env.unitId, conversationId: args.conversationId, messageId: args.messageId, inboundText: args.text, customer: args.customer, memory, saveMemory: persist };

  const [knowledge, methods] = await Promise.all([relevantKnowledge(args.db, env.tenantId, args.text), args.db.paymentMethodConfig.findMany({ where: { tenantId: env.tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { name: true } })]);
  const system = buildSystemPrompt({ env, agent, memory, now, customerName: args.customer.name, phoneVerified: Boolean(args.customer.phone && args.customer.phone.replace(/\D/g, '').length >= 8), greetingDue: args.greetingDue, returnedFromHandoff: args.returnedFromHandoff, knowledge, paymentNames: methods.map(method => method.name) });

  const messages: ChatMessage[] = [...args.history];
  let handoff: { reason: string; summary: string } | null = null; let optOut: boolean | undefined;
  let totalCalls = 0; let corrected = false; let emptyRetries = 0; let finalText: string | null = null; let model: string | null = null; let steps = 0;
  let failure: { code: string; reason: string } | null = null;
  const deadline = Date.now() + TURN_BUDGET_MS;

  async function runTool(call: ToolCall): Promise<ToolOutput> {
    const started = Date.now();
    const tool = byName.get(call.name);
    let out: ToolOutput | undefined; let dedupeKey: string | undefined; let parsedArgs: unknown = call.arguments;
    if (!tool) out = fail('UNKNOWN_TOOL', `A ferramenta "${call.name}" não existe. Use apenas as ferramentas disponíveis.`);
    else if (call.parseError) out = fail('INVALID_ARGS', `Argumentos inválidos (${call.parseError}).`);
    else {
      const parsed = tool.schema.safeParse(call.arguments);
      if (!parsed.success) out = fail('INVALID_ARGS', `Argumentos inválidos: ${zodSummary(parsed.error)}.`);
      else {
        parsedArgs = parsed.data;
        // An operation is executed at most once per customer message and set of arguments, however many times the model (or a retry) asks for it.
        if (tool.kind === 'WRITE' && !args.dryRun) {
          dedupeKey = createHash('sha256').update(`${args.messageId}|${tool.name}|${stable(parsed.data)}`).digest('hex').slice(0, 40);
          const prior = await args.db.whatsappAgentAction.findFirst({ where: { tenantId: env.tenantId, conversationId: args.conversationId, dedupeKey, ok: true }, select: { result: true } });
          const stored = prior?.result && typeof prior.result === 'object' ? (prior.result as { output?: ToolOutput }).output : undefined;
          if (stored) out = { ...stored, duplicate: true };
        }
        if (!out) {
          try { out = await tool.run(ctx, parsed.data); }
          catch (error) { console.error(`[agent] tool ${tool.name} failed:`, error instanceof Error ? error.message : error); out = fail('TOOL_ERROR', 'Erro interno ao executar. Tente de novo; se persistir, chame um atendente.'); }
        }
      }
    }
    const result = out;
    if (tool && tool.kind !== 'READ' && !args.dryRun && !result.duplicate) await persist();
    if (result.handoff) handoff = result.handoff;
    if (result.optOut !== undefined) optOut = result.optOut;
    executed.push({ tool: call.name, kind: tool?.kind ?? 'READ', ok: result.ok, wrote: result.wrote, data: result.data });
    // The log separates what was really done (WRITE) from questions asked to the customer (PROPOSAL) and from harmless no-ops (READ).
    const noop = tool?.kind === 'WRITE' && result.ok && !result.wrote && !result.handoff && result.optOut === undefined && !result.proposal && call.name !== 'report_unanswered';
    const kind: ToolKind | 'PROPOSAL' = result.proposal ? 'PROPOSAL' : noop ? 'READ' : tool?.kind ?? 'READ';
    const record: ActionRecord = { tool: call.name, kind, ok: result.ok, args: parsedArgs, result: result.ok ? { summary: result.summary, ...(result.wrote ? { data: result.data } : {}) } : { error: result.error }, summary: result.summary.slice(0, 300), dedupeKey: result.ok && tool?.kind === 'WRITE' ? dedupeKey : undefined, durationMs: Date.now() - started, ...(result.duplicate ? { duplicate: true } : {}) };
    actions.push(record);
    if (!args.dryRun && !result.duplicate && args.recordAction) await args.recordAction({ ...record, result: { ...(record.result as object), ...(tool?.kind === 'WRITE' ? { output: result } : {}) } }).catch(error => console.error('[agent] could not record the action:', error instanceof Error ? error.message : error));
    return result;
  }

  for (; steps < MAX_STEPS && Date.now() < deadline; steps += 1) {
    const res = await callChat({ ctx: { tenantId: env.tenantId, unitId: env.unitId, userId: null }, module: AGENT_MODULE, operation: 'chat', system, messages, tools: specs, maxTokens: 900, temperature: 0.3, timeoutMs: CALL_TIMEOUT_MS, maxChars: 110_000, settings: env.settings });
    if (!res.ok) { failure = { code: res.code, reason: res.reason }; break; }
    model = res.usage.model;
    if (res.toolCalls.length > 0) {
      messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
      for (const [index, call] of res.toolCalls.entries()) {
        const allowed = index < MAX_CALLS_PER_STEP && totalCalls < MAX_CALLS_PER_TURN;
        const out = allowed ? await runTool(call) : fail('TOO_MANY_CALLS', 'Muitas ferramentas de uma vez; responda ao cliente com o que já tem ou faça menos chamadas.');
        if (allowed) totalCalls += 1;
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: serialize(out) });
      }
      continue;
    }
    const text = cleanReply(res.text ?? '');
    if (!text) { if (emptyRetries < 1) { emptyRetries += 1; messages.push({ role: 'user', content: '[SISTEMA — não é o cliente] Sua resposta veio vazia. Responda ao cliente agora.' }); continue; } break; }
    // An order or reservation made earlier in this conversation (and remembered) is real: talking about it again is not an invention.
    const recent = (stamp: string | undefined) => Boolean(stamp && now.getTime() - Date.parse(stamp) < 24 * 3_600_000);
    const claims = unbackedClaims(text, executed, { order: recent(memory.order.lastOrderAt), reservation: Boolean(memory.reservation.lastReservationId) });
    if (claims.length === 0) { finalText = text; break; }
    if (!corrected) {
      corrected = true;
      messages.push({ role: 'assistant', content: text });
      messages.push({ role: 'user', content: `[SISTEMA — não é o cliente] Sua resposta afirma que algo foi concluído (${claims.join(', ')}), mas nenhuma ferramenta confirmou isso nesta conversa. Se ainda não foi feito, execute a ferramenta correta (ou peça o que falta / a confirmação do cliente). Se já foi feito antes, consulte os dados reais. Depois reescreva a resposta ao cliente sem afirmar nada que o sistema não confirmou.` });
      continue;
    }
    handoff = handoff ?? { reason: 'O robô tentou afirmar uma operação que o sistema não confirmou', summary: `Cliente disse: "${args.text.slice(0, 300)}". Verifique o que ele precisa.` };
    finalText = 'Quero ter certeza de que está tudo certo antes de confirmar. Vou chamar um atendente para concluir isso com você. 🙋';
    break;
  }

  if (!finalText) {
    const receipt = receiptFor(executed);
    if (receipt) finalText = receipt;
    else if (handoff) finalText = renderTemplate(env.templates('handoff').body, { nome: (args.customer.name ?? 'cliente').split(' ')[0], restaurante: env.restaurant });
  }
  if (!finalText) return finish({ ok: false, code: failure?.code ?? 'NO_ANSWER', reason: failure?.reason ?? 'O atendente de IA não chegou a uma resposta.' });
  return finish({ ok: true, text: finalText });

  async function finish(outcome: { ok: true; text: string } | { ok: false; code: string; reason: string }): Promise<AgentTurnResult> {
    memory.turns += 1;
    await persist();
    if (!outcome.ok) return { ok: false, code: outcome.code, reason: outcome.reason, memory, actions };
    return { ok: true, replies: chunkMessage(outcome.text, 1500).slice(0, 4), memory, handoff, ...(optOut !== undefined ? { optOut } : {}), actions, steps: steps + 1, model };
  }
}
