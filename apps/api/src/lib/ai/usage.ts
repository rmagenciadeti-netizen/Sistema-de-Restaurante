import { prisma } from '../prisma';

export type UsageKind = 'DETERMINISTIC' | 'LLM' | 'CACHE_HIT' | 'DEDUP' | 'DENIED' | 'BLOCKED_LIMIT' | 'ERROR';
export type UsageInput = { tenantId: string; unitId?: string | null; userId?: string | null; module: string; operation: string; kind: UsageKind; provider?: string | null; model?: string | null; inputTokens?: number; outputTokens?: number; tokensEstimated?: boolean; latencyMs?: number; ok?: boolean; errorCode?: string | null };

// Never stores prompts, answers or secrets: only counters and identifiers.
export async function recordUsage(input: UsageInput) {
  try {
    await prisma.aiUsageEvent.create({ data: { tenantId: input.tenantId, unitId: input.unitId ?? null, userId: input.userId ?? null, module: input.module, operation: input.operation.slice(0, 80), kind: input.kind, provider: input.provider ?? null, model: input.model ?? null, inputTokens: input.inputTokens ?? 0, outputTokens: input.outputTokens ?? 0, tokensEstimated: input.tokensEstimated ?? false, latencyMs: Math.round(input.latencyMs ?? 0), ok: input.ok ?? true, errorCode: input.errorCode ?? null } });
  } catch { /* metering must never break an analysis */ }
}

const startOfUtcDay = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); };

// Persistent (database) counters, so limits survive deploys and are shared by every API instance.
export async function llmCalls(tenantId: string, filter: { userId?: string; module?: string; unitId?: string } = {}) {
  return prisma.aiUsageEvent.count({ where: { tenantId, kind: 'LLM', createdAt: { gte: startOfUtcDay() }, ...(filter.userId ? { userId: filter.userId } : {}), ...(filter.module ? { module: filter.module } : {}), ...(filter.unitId ? { unitId: filter.unitId } : {}) } });
}
export type Limits = { llmCallsPerTenantDay: number; llmCallsPerUserDay: number; llmCallsPerModuleDay: number; llmCallsPerUnitDay?: number };
export async function limitStatus(tenantId: string, userId: string, module: string, limits: Limits, unitId: string | null = null) {
  const unitLimit = limits.llmCallsPerUnitDay ?? 60;
  const [tenant, user, mod, unit] = await Promise.all([llmCalls(tenantId), userId ? llmCalls(tenantId, { userId }) : Promise.resolve(0), llmCalls(tenantId, { module }), unitId ? llmCalls(tenantId, { unitId }) : Promise.resolve(0)]);
  const blocked = tenant >= limits.llmCallsPerTenantDay ? 'tenant' as const : unitId && unit >= unitLimit ? 'unit' as const : user >= limits.llmCallsPerUserDay ? 'user' as const : mod >= limits.llmCallsPerModuleDay ? 'module' as const : null;
  return { blocked, tenant: { used: tenant, limit: limits.llmCallsPerTenantDay }, unit: { used: unit, limit: unitLimit }, user: { used: user, limit: limits.llmCallsPerUserDay }, module: { used: mod, limit: limits.llmCallsPerModuleDay } };
}

// Before/after: the last `days` against the `days` before them, with real (provider-reported) and estimated tokens kept apart. Reuse and denials show what was NOT sent to the model.
export async function usageComparison(tenantId: string, days: number) {
  const now = Date.now(); const mid = new Date(now - days * 86_400_000); const start = new Date(now - 2 * days * 86_400_000);
  const window = async (from: Date, to: Date) => {
    const rows = await prisma.aiUsageEvent.groupBy({ by: ['kind', 'tokensEstimated'], where: { tenantId, createdAt: { gte: from, lt: to } }, _count: true, _sum: { inputTokens: true, outputTokens: true } });
    const count = (kind: string) => rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row._count, 0);
    const tokens = (estimated: boolean) => rows.filter(row => row.kind === 'LLM' && row.tokensEstimated === estimated).reduce((sum, row) => sum + (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0), 0);
    return { from, to, modelCalls: count('LLM'), cacheHits: count('CACHE_HIT'), deduplicated: count('DEDUP'), deterministic: count('DETERMINISTIC'), blockedByLimit: count('BLOCKED_LIMIT'), denied: count('DENIED'), errors: count('ERROR'), realTokens: tokens(false), estimatedTokens: tokens(true) };
  };
  const [current, previous] = await Promise.all([window(mid, new Date(now + 1000)), window(start, mid)]);
  const delta = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10);
  return { days, current, previous, change: { modelCallsPercent: delta(current.modelCalls, previous.modelCalls), realTokensPercent: delta(current.realTokens, previous.realTokens) },
    note: 'Tokens “reais” vêm do relatório do provedor; “estimados” usam caracteres÷4 quando o provedor não informa. Chamadas de teste com provedor simulado nunca são consumo real.' };
}

export async function usageSummary(tenantId: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  const where = { tenantId, createdAt: { gte: since } };
  const [byKind, byModule, byOperation, daily, byEstimate] = await Promise.all([
    prisma.aiUsageEvent.groupBy({ by: ['kind'], where, _count: true, _sum: { inputTokens: true, outputTokens: true, latencyMs: true } }),
    prisma.aiUsageEvent.groupBy({ by: ['module', 'kind'], where, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
    prisma.aiUsageEvent.groupBy({ by: ['module', 'operation', 'kind'], where: { ...where, kind: { in: ['LLM', 'DETERMINISTIC'] } }, _count: true, _sum: { inputTokens: true, outputTokens: true, latencyMs: true }, orderBy: [{ _sum: { inputTokens: 'desc' } }], take: 15 }),
    prisma.$queryRaw<{ day: Date; kind: string; calls: bigint; tokens: bigint }[]>`SELECT date_trunc('day', "createdAt") AS day, kind, count(*) AS calls, COALESCE(sum("inputTokens" + "outputTokens"), 0) AS tokens FROM "AiUsageEvent" WHERE "tenantId" = ${tenantId} AND "createdAt" >= ${since} GROUP BY 1, 2 ORDER BY 1`,
    prisma.aiUsageEvent.groupBy({ by: ['tokensEstimated'], where: { ...where, kind: 'LLM' }, _count: true, _sum: { inputTokens: true, outputTokens: true } }),
  ]);
  const tokenSplit = (estimated: boolean) => { const row = byEstimate.find(item => item.tokensEstimated === estimated); return { calls: row?._count ?? 0, tokens: (row?._sum.inputTokens ?? 0) + (row?._sum.outputTokens ?? 0) }; };
  const count = (kind: string) => byKind.find(row => row.kind === kind)?._count ?? 0;
  const eligible = count('DETERMINISTIC') + count('CACHE_HIT') + count('DEDUP');
  const llm = byKind.find(row => row.kind === 'LLM');
  return {
    since, days,
    totals: { analyses: eligible, modelCalls: count('LLM'), cacheHits: count('CACHE_HIT'), deduplicated: count('DEDUP'), denied: count('DENIED'), blockedByLimit: count('BLOCKED_LIMIT'), errors: count('ERROR'), inputTokens: llm?._sum.inputTokens ?? 0, outputTokens: llm?._sum.outputTokens ?? 0, avgModelLatencyMs: llm && llm._count ? Math.round((llm._sum.latencyMs ?? 0) / llm._count) : null,
      // Share of analyses answered without recomputing (cache/dedup). Not a cost saving percentage: it is only the measured reuse.
      reuseRatePercent: eligible > 0 ? Math.round(((count('CACHE_HIT') + count('DEDUP')) / eligible) * 1000) / 10 : null },
    // Real = reported by the provider; estimated = characters/4 when it reports nothing. Never mixed.
    tokens: { real: tokenSplit(false), estimated: tokenSplit(true) },
    byModule: byModule.map(row => ({ module: row.module, kind: row.kind, count: row._count, inputTokens: row._sum.inputTokens ?? 0, outputTokens: row._sum.outputTokens ?? 0 })),
    topOperations: byOperation.map(row => ({ module: row.module, operation: row.operation, kind: row.kind, count: row._count, tokens: (row._sum.inputTokens ?? 0) + (row._sum.outputTokens ?? 0), avgLatencyMs: row._count ? Math.round((row._sum.latencyMs ?? 0) / row._count) : 0 })),
    daily: daily.map(row => ({ day: row.day.toISOString().slice(0, 10), kind: row.kind, calls: Number(row.calls), tokens: Number(row.tokens) })),
  };
}

// Retention: old conversations and usage rows are purged (at most once per hour per process).
let lastPurge = 0;
export async function purgeOld(tenantId: string, retentionDays: number) {
  if (Date.now() - lastPurge < 3_600_000) return;
  lastPurge = Date.now();
  const before = new Date(Date.now() - retentionDays * 86_400_000);
  try {
    await prisma.aiConversation.deleteMany({ where: { tenantId, updatedAt: { lt: before } } });
    await prisma.aiUsageEvent.deleteMany({ where: { tenantId, createdAt: { lt: new Date(Date.now() - Math.max(retentionDays, 90) * 86_400_000) } } });
  } catch { /* best effort */ }
}
