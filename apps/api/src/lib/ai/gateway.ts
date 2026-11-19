import { createHash } from 'node:crypto';
import { currentAiProvider } from '../ai-provider';
import { prisma } from '../prisma';
import { loadSettings, type TenantSettingsData } from '../settings';
import { cached, cacheKey } from './cache';
import { limitStatus, recordUsage } from './usage';

// The single door to the external language model. Every caller (SUPER IA specialists, RM Assistente, WhatsApp bot, migration mapping) goes through it, so consent, the on/off switch,
// persistent limits (company, unit, user, module), the circuit breaker, reuse and consumption metering are enforced in one place and nowhere else.
export type ModelCtx = { tenantId: string; unitId?: string | null; userId?: string | null };

const breaker = { failures: 0, openUntil: 0 };
export const breakerState = () => ({ ...breaker });
export function resetBreaker() { breaker.failures = 0; breaker.openUntil = 0; }
export const breakerFailed = () => { breaker.failures++; if (breaker.failures >= 3) breaker.openUntil = Date.now() + 60_000; };
export const breakerOk = () => { breaker.failures = 0; };

// AI_DAILY_LIMIT (legacy environment cap) can only lower the company limit.
export function effectiveLimits(settings: TenantSettingsData) {
  const legacy = Number(process.env.AI_DAILY_LIMIT);
  const limits = settings.ai.limits;
  return Number.isFinite(legacy) && process.env.AI_DAILY_LIMIT !== undefined && process.env.AI_DAILY_LIMIT !== '' ? { ...limits, llmCallsPerTenantDay: Math.min(limits.llmCallsPerTenantDay, Math.max(0, legacy)) } : limits;
}

export async function modelGate(ctx: ModelCtx, settings: TenantSettingsData, module: string, operation = 'narrative') {
  const provider = currentAiProvider();
  if (!provider) return { ok: false as const, reason: 'IA generativa não configurada neste ambiente (AI_API_KEY/AI_MODEL). As análises determinísticas continuam disponíveis.' };
  if (!settings.ai.externalConsent) return { ok: false as const, reason: 'A empresa ainda não autorizou o envio de dados a um provedor externo de IA (consentimento em Configurações da IA).' };
  if (!settings.ai.externalEnabled) return { ok: false as const, reason: 'A IA externa está desativada para este estabelecimento.' };
  if (Date.now() < breaker.openUntil) return { ok: false as const, reason: 'O provedor de IA está temporariamente indisponível (proteção contra falhas repetidas); tente em instantes.' };
  const status = await limitStatus(ctx.tenantId, ctx.userId ?? '', module, effectiveLimits(settings), ctx.unitId ?? null);
  if (status.blocked) {
    await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module, operation, kind: 'BLOCKED_LIMIT', ok: false, errorCode: status.blocked });
    const scope = { tenant: 'da empresa', unit: 'desta unidade', user: 'do usuário', module: 'deste especialista' }[status.blocked];
    return { ok: false as const, reason: `Limite diário de chamadas ao modelo ${scope} atingido. As análises determinísticas continuam disponíveis.` };
  }
  return { ok: true as const, provider };
}

// Read-only twin of modelGate for the pre-call estimate: says whether a model call would be allowed now, without recording anything.
export async function modelAvailability(ctx: ModelCtx, settings: TenantSettingsData, module: string) {
  const provider = currentAiProvider();
  const reason = !provider ? 'Provedor de IA não configurado neste ambiente.' : !settings.ai.externalConsent ? 'Sem consentimento da empresa para IA externa.' : !settings.ai.externalEnabled ? 'IA externa desativada.' : Date.now() < breaker.openUntil ? 'Provedor temporariamente indisponível.' : null;
  const status = await limitStatus(ctx.tenantId, ctx.userId ?? '', module, effectiveLimits(settings), ctx.unitId ?? null);
  return { available: !reason && !status.blocked, reason: reason ?? (status.blocked ? `Limite diário atingido (${status.blocked}).` : null), limits: status };
}

// Pre-call estimate: characters/4 is a rough rule, always flagged as an estimate. Real token counts only come from the provider's own answer.
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
export function estimateCall(system: string, question: string, maxTokens = 400) {
  const inputTokens = estimateTokens(system) + estimateTokens(question);
  return { inputTokens, maxOutputTokens: maxTokens, estimated: true as const };
}

export type ModelCall = {
  ctx: ModelCtx; module: string; operation: string; system: string; question: string; model?: string; maxTokens?: number;
  // Hard cap on the prompt size (characters): larger prompts are refused instead of silently truncated.
  maxChars: number; reuse?: boolean; settings?: TenantSettingsData;
};
export type ModelResult =
  | { ok: true; text: string | null; source: 'model' | 'reuse'; usage: { model: string | null; inputTokens: number | null; outputTokens: number | null; estimated: boolean } | null; estimate: ReturnType<typeof estimateCall> }
  | { ok: false; reason: string; code: 'NOT_AVAILABLE' | 'TOO_LARGE' | 'FAILED' };

export async function callModel(input: ModelCall): Promise<ModelResult> {
  const settings = input.settings ?? await loadSettings(prisma, input.ctx.tenantId);
  const estimate = estimateCall(input.system, input.question, input.maxTokens);
  const gate = await modelGate(input.ctx, settings, input.module, input.operation);
  if (!gate.ok) return { ok: false, reason: gate.reason, code: 'NOT_AVAILABLE' };
  if (input.system.length + input.question.length > input.maxChars) {
    await recordUsage({ tenantId: input.ctx.tenantId, unitId: input.ctx.unitId, userId: input.ctx.userId, module: input.module, operation: input.operation, kind: 'DENIED', ok: false, errorCode: 'INPUT_TOO_LARGE' });
    return { ok: false, reason: 'A solicitação excede o tamanho máximo permitido para envio ao modelo.', code: 'TOO_LARGE' };
  }
  const started = Date.now();
  const key = cacheKey([input.ctx.tenantId, input.ctx.unitId, input.module, input.operation, createHash('sha256').update(input.system + input.question + (input.model ?? '')).digest('hex')]);
  try {
    const out = await cached(key, input.reuse === false ? 0 : settings.ai.cacheTtlSeconds, async () => {
      const answer = gate.provider.answerDetailed ? await gate.provider.answerDetailed({ system: input.system, question: input.question, model: input.model, maxTokens: input.maxTokens }) : null;
      if (answer) return { text: answer.text, model: answer.model as string | null, inputTokens: answer.inputTokens as number | null, outputTokens: answer.outputTokens as number | null, estimated: false };
      const text = await gate.provider.answer({ system: input.system, question: input.question, model: input.model, maxTokens: input.maxTokens });
      return text ? { text, model: input.model ?? null, inputTokens: estimate.inputTokens, outputTokens: estimateTokens(text), estimated: true } : null;
    });
    if (out.source !== 'computed') {
      await recordUsage({ tenantId: input.ctx.tenantId, unitId: input.ctx.unitId, userId: input.ctx.userId, module: input.module, operation: input.operation, kind: out.source === 'cache' ? 'CACHE_HIT' : 'DEDUP' });
      return { ok: true, text: out.value?.text ?? null, source: 'reuse', usage: null, estimate };
    }
    breakerOk();
    if (!out.value) return { ok: true, text: null, source: 'model', usage: null, estimate };
    await recordUsage({ tenantId: input.ctx.tenantId, unitId: input.ctx.unitId, userId: input.ctx.userId, module: input.module, operation: input.operation, kind: 'LLM', provider: gate.provider.name, model: out.value.model, inputTokens: out.value.inputTokens ?? 0, outputTokens: out.value.outputTokens ?? 0, tokensEstimated: out.value.estimated || out.value.inputTokens === null, latencyMs: Date.now() - started });
    return { ok: true, text: out.value.text, source: 'model', usage: { model: out.value.model, inputTokens: out.value.inputTokens, outputTokens: out.value.outputTokens, estimated: out.value.estimated }, estimate };
  } catch {
    // No automatic retry: the failed call may already have been billed.
    breakerFailed();
    await recordUsage({ tenantId: input.ctx.tenantId, unitId: input.ctx.unitId, userId: input.ctx.userId, module: input.module, operation: input.operation, kind: 'ERROR', provider: gate.provider.name, ok: false, latencyMs: Date.now() - started, errorCode: 'PROVIDER_FAILED' });
    return { ok: false, reason: 'O provedor de IA não respondeu agora.', code: 'FAILED' };
  }
}
