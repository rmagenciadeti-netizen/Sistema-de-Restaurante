import { createHash } from 'node:crypto';
import { prisma } from '../prisma';
import { currentAiProvider } from '../ai-provider';
import { effectiveModules, globallyBlockedModules, licenseDenial } from '../licensing';
import { loadSettings, type TenantSettingsData } from '../settings';
import { MANAGEMENT_ROLES } from '../permissions';
import { cached, cacheKey } from './cache';
import { COMMON, DOMAIN_BY_KEY, DOMAINS, MANAGEMENT_PLAN } from './domains';
import { dataVersion } from './scope';
import { purgeOld, recordUsage } from './usage';
import { breakerFailed, breakerOk, breakerState, modelGate as sharedGate, resetBreaker, type ModelCtx } from './gateway';
import { AiAccessError, type AiContext, type DomainDef, type DomainKey, type Period, type ToolResult } from './types';
import { TOOLS } from './tools';

const MAX_RANGE_DAYS = 366;
export function parsePeriod(from?: string, to?: string): Period {
  const end = to ? new Date(to) : new Date(); const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86_400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) throw new AiAccessError('Período inválido.', 400, 'AI_BAD_PERIOD');
  if (end.getTime() - start.getTime() > MAX_RANGE_DAYS * 86_400_000) throw new AiAccessError(`O período máximo é de ${MAX_RANGE_DAYS} dias.`, 400, 'AI_PERIOD_TOO_LONG');
  return { from: start, to: end };
}

// ---- Access: license (contracted module) and user permission (role) are separate checks, both enforced here on every call ----
async function licensed(tenantId: string, module: DomainDef['module']): Promise<boolean> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { license: true, modules: true } });
  if (!tenant) return false;
  const blocked = await globallyBlockedModules(async () => (await prisma.saaSModule.findMany({ where: { blocked: true }, select: { key: true } })).map(item => item.key));
  return !licenseDenial(tenant.license, effectiveModules(tenant.modules, blocked), module === 'profit' ? '/api/v1/profit' : '/api/v1/intelligence');
}
export type Access = { allowed: true } | { allowed: false; reason: 'ROLE' | 'LICENSE'; message: string };
export async function accessFor(ctx: AiContext, domain: DomainDef): Promise<Access> {
  if (!domain.roles.includes(ctx.role)) return { allowed: false, reason: 'ROLE', message: `Seu perfil não tem permissão para consultar ${domain.name}. Solicite autorização ao administrador responsável.` };
  if (!await licensed(ctx.tenantId, domain.module)) return { allowed: false, reason: 'LICENSE', message: `${domain.name} não está contratado/habilitado para este estabelecimento.` };
  return { allowed: true };
}
async function deny(ctx: AiContext, domain: DomainDef, access: Extract<Access, { allowed: false }>, operation: string): Promise<never> {
  await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module: domain.key, operation, kind: 'DENIED', ok: false, errorCode: access.reason });
  // Only the domain, role and reason are stored, never the question text.
  await prisma.auditLog.create({ data: { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'AI_ACCESS_DENIED', entityType: 'AiDomain', entityId: domain.key, metadata: { role: ctx.role, reason: access.reason, operation } } }).catch(() => undefined);
  throw new AiAccessError(access.message, 403, access.reason === 'ROLE' ? 'AI_ROLE_FORBIDDEN' : 'AI_MODULE_NOT_LICENSED');
}

// ---- Deterministic analysis execution with cache, dedup and metering ----
export async function runTool(ctx: AiContext, domainKey: DomainKey, toolName: string, period: Period, settings?: TenantSettingsData): Promise<{ result: ToolResult; reuse: 'cache' | 'computed' | 'deduplicated' }> {
  const domain = DOMAIN_BY_KEY.get(domainKey); const tool = domain?.tools.find(item => item.name === toolName);
  if (!domain || !tool) throw new AiAccessError('Ferramenta desconhecida.', 404, 'AI_UNKNOWN_TOOL');
  const access = await accessFor(ctx, domain);
  if (!access.allowed) return deny(ctx, domain, access, `${domainKey}.${toolName}`);
  const config = settings ?? await loadSettings(prisma, ctx.tenantId);
  const started = Date.now();
  try {
    const version = await dataVersion(ctx, tool.parts);
    const key = cacheKey([ctx.tenantId, ctx.unitId, ctx.role, domainKey, toolName, period.from.toISOString().slice(0, 13), period.to.toISOString().slice(0, 13), version]);
    const out = await cached(key, config.ai.cacheTtlSeconds, () => tool.run(ctx, period));
    await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module: domainKey, operation: `${domainKey}.${toolName}`, kind: out.source === 'cache' ? 'CACHE_HIT' : out.source === 'deduplicated' ? 'DEDUP' : 'DETERMINISTIC', latencyMs: Date.now() - started });
    return { result: out.value, reuse: out.source };
  } catch (error) {
    await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module: domainKey, operation: `${domainKey}.${toolName}`, kind: 'ERROR', ok: false, latencyMs: Date.now() - started, errorCode: 'TOOL_FAILED' });
    throw error;
  }
}

// ---- Routing: deterministic keywords first; a model is only asked when no domain matches and external AI is allowed ----
export function routeQuestion(question: string): { domains: DomainKey[]; scores: Record<string, number> } {
  const scores: Record<string, number> = {};
  for (const domain of DOMAINS) { const matches = question.match(new RegExp(domain.keywords.source, 'gi')); if (matches) scores[domain.key] = matches.length; }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]).map(([key]) => key as DomainKey);
  return { domains: ranked, scores };
}

// ---- External model gate: lives in gateway.ts (shared with the assistant, the WhatsApp bot and the migration mapping) ----
export { breakerState, resetBreaker };
const modelGate = (ctx: ModelCtx, settings: TenantSettingsData, module: string) => sharedGate(ctx, settings, module, 'narrative');
const modelFor = (complex: boolean) => (complex ? process.env.AI_MODEL : process.env.AI_MODEL_SIMPLE ?? process.env.AI_MODEL);

async function narrate(ctx: AiContext, settings: TenantSettingsData, domains: DomainDef[], question: string, results: ToolResult[]) {
  const module = domains.length === 1 ? domains[0].key : 'central';
  const gate = await modelGate(ctx, settings, module);
  if (!gate.ok) return { text: null as string | null, note: gate.reason, usage: null };
  let facts = JSON.stringify(results.map(item => ({ analise: item.tool, periodo: item.period, unidade: item.unit, tipo: item.kind, dados: item.llmFacts })));
  if (facts.length > settings.ai.limits.maxInputChars) facts = facts.slice(0, settings.ai.limits.maxInputChars);
  const complex = domains.length > 1 || facts.length > 2500;
  const model = modelFor(complex);
  const system = domains.length === 1 ? domains[0].instructions : `Você é a SUPER IA RM Intelligence, coordenadora dos especialistas: ${domains.map(domain => domain.name).join('; ')}. Consolide sem repetir nem distorcer valores. ${COMMON}`;
  const user = `Pergunta: ${question.slice(0, 300)}\n\ndados: ${facts}`;
  // Identical question over identical data reuses the previous narrative: no second paid call, even for concurrent requests.
  const key = cacheKey([ctx.tenantId, ctx.unitId, 'narrative', createHash('sha256').update(system + user + (model ?? '')).digest('hex')]);
  const started = Date.now();
  try {
    const out = await cached(key, settings.ai.cacheTtlSeconds, async () => {
      const answer = gate.provider.answerDetailed ? await gate.provider.answerDetailed({ system, question: user, model }) : null;
      if (answer) return { text: answer.text, model: answer.model, inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, estimated: false };
      const text = await gate.provider.answer({ system, question: user, model });
      return text ? { text, model: model ?? 'default', inputTokens: Math.ceil((system.length + user.length) / 4), outputTokens: Math.ceil(text.length / 4), estimated: true } : null;
    });
    if (out.source !== 'computed') { await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module, operation: 'narrative', kind: out.source === 'cache' ? 'CACHE_HIT' : 'DEDUP' }); return { text: out.value?.text ?? null, note: null, usage: null }; }
    breakerOk();
    if (!out.value) return { text: null, note: 'O provedor não retornou texto; use a análise acima.', usage: null };
    await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module, operation: 'narrative', kind: 'LLM', provider: gate.provider.name, model: out.value.model, inputTokens: out.value.inputTokens ?? 0, outputTokens: out.value.outputTokens ?? 0, tokensEstimated: out.value.estimated, latencyMs: Date.now() - started });
    return { text: out.value.text, note: null, usage: { model: out.value.model, inputTokens: out.value.inputTokens, outputTokens: out.value.outputTokens, estimated: out.value.estimated } };
  } catch {
    // No automatic retry: the failed call may already have been billed. The deterministic analysis is returned instead.
    breakerFailed();
    await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module, operation: 'narrative', kind: 'ERROR', provider: gate.provider.name, ok: false, latencyMs: Date.now() - started, errorCode: 'PROVIDER_FAILED' });
    return { text: null, note: 'O provedor de IA não respondeu; a análise determinística acima continua válida.', usage: null };
  }
}

// Optional model help to pick a domain when no keyword matches. Cheap model, tiny prompt, never sees business data.
async function classify(ctx: AiContext, settings: TenantSettingsData, question: string): Promise<DomainKey | null> {
  const gate = await modelGate(ctx, settings, 'central'); if (!gate.ok) return null;
  const started = Date.now();
  try {
    const out = await cached(cacheKey([ctx.tenantId, 'classify', createHash('sha256').update(question.toLowerCase().trim()).digest('hex')]), settings.ai.cacheTtlSeconds, async () => gate.provider.answerDetailed
      ? gate.provider.answerDetailed({ system: `Classifique a pergunta em UMA chave: ${DOMAINS.map(domain => domain.key).join(', ')}. Responda só a chave, ou "nenhuma".`, question: question.slice(0, 300), model: modelFor(false), maxTokens: 8 })
      : null);
    if (out.source === 'computed' && out.value) await recordUsage({ tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, module: 'central', operation: 'classify', kind: 'LLM', provider: gate.provider.name, model: out.value.model, inputTokens: out.value.inputTokens ?? 0, outputTokens: out.value.outputTokens ?? 0, latencyMs: Date.now() - started });
    const key = out.value?.text.trim().toLowerCase() as DomainKey | undefined;
    return key && DOMAIN_BY_KEY.has(key) ? key : null;
  } catch { return null; }
}

export type AskResult = {
  answer: string; domains: { key: DomainKey; name: string; tool: string }[]; denied: { key: DomainKey; name: string; reason: string }[]; results: ToolResult[]; alerts: { severity: string; message: string; domain: string }[];
  ai: { text: string; model: string | null; note: string } | null; aiNote: string | null; needsClarification: boolean; suggestions: { key: DomainKey; name: string }[]; reuse: Record<string, string>;
};

export async function ask(ctx: AiContext, question: string, options: { useAi: boolean; period: Period; domain?: DomainKey }): Promise<AskResult> {
  const settings = await loadSettings(prisma, ctx.tenantId);
  void purgeOld(ctx.tenantId, settings.ai.historyRetentionDays);
  // Asked from inside a specialist's own page: that specialist answers, whatever the wording.
  let routed = options.domain ? [options.domain] : routeQuestion(question).domains;
  if (routed.length === 0 && options.useAi) { const picked = await classify(ctx, settings, question); if (picked) routed = [picked]; }
  const suggestions = [];
  for (const domain of DOMAINS) if ((await accessFor(ctx, domain)).allowed) suggestions.push({ key: domain.key, name: domain.name });
  if (routed.length === 0) return { answer: 'Não consegui identificar qual especialista responde a essa pergunta. Escolha um dos especialistas disponíveis para o seu perfil ou reformule com termos como vendas, estoque, financeiro, margem, delivery, produção ou desperdício.', domains: [], denied: [], results: [], alerts: [], ai: null, aiNote: null, needsClarification: true, suggestions, reuse: {} };

  // Permission is checked before any tool or model is touched; a refused domain costs nothing.
  const allowed: DomainDef[] = []; const denied: AskResult['denied'] = [];
  for (const key of routed) {
    const domain = DOMAIN_BY_KEY.get(key)!; const access = await accessFor(ctx, domain);
    if (access.allowed) allowed.push(domain);
    else { denied.push({ key, name: domain.name, reason: access.message }); await deny(ctx, domain, access, 'ask').catch(() => undefined); }
  }
  let plan = allowed;
  if (allowed.length && allowed.every(domain => domain.key === 'management')) plan = MANAGEMENT_PLAN.map(key => DOMAIN_BY_KEY.get(key)!).filter(domain => allowed.concat(DOMAINS.filter(item => item.roles.includes(ctx.role))).includes(domain));
  const accessible: DomainDef[] = []; for (const domain of plan) if ((await accessFor(ctx, domain)).allowed) accessible.push(domain);
  const limited = allowed.some(domain => domain.key === 'management') ? accessible : accessible.slice(0, settings.ai.limits.maxSpecialistsPerQuestion);
  if (limited.length === 0) return { answer: denied.map(item => item.reason).join(' ') || 'Sem permissão para esta consulta.', domains: [], denied, results: [], alerts: [], ai: null, aiNote: null, needsClarification: false, suggestions, reuse: {} };

  const results: ToolResult[] = []; const reuse: Record<string, string> = {}; const used: AskResult['domains'] = [];
  for (const domain of limited) {
    const toolName = domain.panel[0];
    try { const out = await runTool(ctx, domain.key, toolName, options.period, settings); results.push(out.result); reuse[`${domain.key}.${toolName}`] = out.reuse; used.push({ key: domain.key, name: domain.name, tool: toolName }); }
    catch (error) { if (error instanceof AiAccessError) denied.push({ key: domain.key, name: domain.name, reason: error.message }); else denied.push({ key: domain.key, name: domain.name, reason: 'Este especialista está indisponível no momento.' }); }
  }
  if (allowed.some(domain => domain.key === 'management') && !ctx.boundUnitId && MANAGEMENT_ROLES.includes(ctx.role)) {
    try { const out = await runTool(ctx, 'management', 'units', options.period, settings); results.push(out.result); reuse['management.units'] = out.reuse; used.push({ key: 'management', name: DOMAIN_BY_KEY.get('management')!.name, tool: 'units' }); } catch { /* optional table */ }
  }
  const alerts = results.flatMap(item => item.alerts.map(alert => ({ ...alert, domain: item.tool }))).sort((a, b) => ['critical', 'warning', 'info'].indexOf(a.severity) - ['critical', 'warning', 'info'].indexOf(b.severity));
  const answer = [
    ...results.map(item => `${item.title}\n${item.highlights.map(line => `• ${line}`).join('\n')}`),
    ...(denied.length ? [`Sem acesso: ${denied.map(item => item.name).join('; ')}.`] : []),
  ].join('\n\n');
  let ai: AskResult['ai'] = null; let aiNote: string | null = null;
  if (options.useAi && results.length > 0) {
    const narrated = await narrate(ctx, settings, limited, question, results);
    aiNote = narrated.note; if (narrated.text) ai = { text: narrated.text, model: narrated.usage?.model ?? null, note: 'Explicação gerada por IA a partir dos dados acima; os valores vêm do sistema, não do modelo.' };
  }
  return { answer, domains: used, denied, results, alerts, ai, aiNote, needsClarification: false, suggestions, reuse };
}
