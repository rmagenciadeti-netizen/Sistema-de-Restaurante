export type AiDomainKey = 'finance' | 'stock' | 'profit' | 'sales' | 'purchasing' | 'customers' | 'delivery' | 'production' | 'waste' | 'management';
export type AiDomain = { key: AiDomainKey; name: string; icon: string; description: string; tools: { name: string; description: string }[] };
export type AiDomainList = { available: AiDomain[]; unavailable: { key: AiDomainKey; name: string; reason: string }[]; unit: string | null; canSelectUnit: boolean; external: { providerConfigured: boolean; consent: boolean; enabled: boolean } };
export type AiAlert = { severity: 'critical' | 'warning' | 'info'; message: string; domain?: string };
export type AiToolResult = { tool: string; title: string; period: { from: string; to: string }; unit: string | null; source: string; kind: 'FACT' | 'ESTIMATE' | 'MIXED'; data: Record<string, any>; highlights: string[]; alerts: AiAlert[]; limitations: string[] };
export type AiPanel = { domain: { key: AiDomainKey; name: string; icon: string; description: string }; results: AiToolResult[]; reuse: Record<string, 'cache' | 'computed' | 'deduplicated'> };
export type AiAsk = {
  conversationId: string; answer: string; domains: { key: AiDomainKey; name: string; tool: string }[]; denied: { key: AiDomainKey; name: string; reason: string }[]; results: AiToolResult[]; alerts: (AiAlert & { domain: string })[];
  ai: { text: string; model: string | null; note: string } | null; aiNote: string | null; needsClarification: boolean; suggestions: { key: AiDomainKey; name: string }[]; reuse: Record<string, string>;
};
export type AiUsage = {
  tokens?: { real: { calls: number; tokens: number }; estimated: { calls: number; tokens: number } };
  days: number; totals: { analyses: number; modelCalls: number; cacheHits: number; deduplicated: number; denied: number; blockedByLimit: number; errors: number; inputTokens: number; outputTokens: number; avgModelLatencyMs: number | null; reuseRatePercent: number | null };
  byModule: { module: string; kind: string; count: number; inputTokens: number; outputTokens: number }[]; topOperations: { module: string; operation: string; kind: string; count: number; tokens: number; avgLatencyMs: number }[]; daily: { day: string; kind: string; calls: number; tokens: number }[];
  limits: { unit?: { used: number; limit: number }; tenant: { used: number; limit: number }; user: { used: number; limit: number }; module: { used: number; limit: number } }; provider: { configured: boolean; name: string | null; model: string | null; simpleModel: string | null }; notes: string[];
  settings: { externalConsent: boolean; externalEnabled: boolean; limits: { llmCallsPerTenantDay: number; llmCallsPerUserDay: number; llmCallsPerModuleDay: number; llmCallsPerUnitDay?: number; maxSpecialistsPerQuestion: number; maxInputChars: number }; cacheTtlSeconds: number; historyRetentionDays: number };
};
export type AiComparison = { days: number; current: AiWindow; previous: AiWindow; change: { modelCallsPercent: number | null; realTokensPercent: number | null }; note: string };
export type AiWindow = { modelCalls: number; cacheHits: number; deduplicated: number; blockedByLimit: number; denied: number; errors: number; realTokens: number; estimatedTokens: number };
export const KIND_LABEL: Record<string, string> = { FACT: 'Fato registrado', ESTIMATE: 'Estimativa', MIXED: 'Fatos e estimativas' };
export const SEVERITY_TONE = { critical: 'red', warning: 'amber', info: 'blue' } as const;
