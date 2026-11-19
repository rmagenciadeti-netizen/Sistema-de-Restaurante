import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireAuth, requireTenant } from '../middleware/auth';
import { FINANCE_ROLES, MANAGEMENT_ROLES, requireRoles } from '../lib/permissions';
import { loadSettings, saveSettingsSection } from '../lib/settings';
import { currentAiProvider } from '../lib/ai-provider';
import { accessFor, ask, parsePeriod, routeQuestion, runTool } from '../lib/ai/orchestrator';
import { specialistCsv } from '../lib/ai/export';
import { estimateCall, estimateTokens, modelAvailability } from '../lib/ai/gateway';
import { DOMAINS, DOMAIN_BY_KEY } from '../lib/ai/domains';
import { resolveUnit } from '../lib/ai/scope';
import { limitStatus, usageComparison, usageSummary } from '../lib/ai/usage';
import { AiAccessError, type AiContext, type DomainKey } from '../lib/ai/types';

export const aiRoutes = Router();
aiRoutes.use(requireAuth, requireTenant);

// The context is built from the verified session only. A unit may be chosen only by an unbound management/finance user, and only among the company's own units.
async function contextOf(req: Request): Promise<AiContext> {
  const { tenantId, userId, role, unitId } = req.auth!;
  const requested = typeof req.query.unitId === 'string' ? req.query.unitId : typeof req.body?.unitId === 'string' ? req.body.unitId : null;
  if (requested && !unitId && !FINANCE_ROLES.includes(role)) throw new AiAccessError('Seu perfil não pode selecionar outra unidade.', 403, 'AI_UNIT_FORBIDDEN');
  const selected = await resolveUnit(tenantId!, unitId, requested);
  if (requested && !unitId && !selected) throw new AiAccessError('Unidade não encontrada.', 404, 'AI_UNIT_NOT_FOUND');
  return { tenantId: tenantId!, userId, role, boundUnitId: unitId, unitId: selected };
}
const guard = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try { await handler(req, res); } catch (error) { if (error instanceof AiAccessError) return res.status(error.status).json({ message: error.message, code: error.code }); return next(error); }
};

aiRoutes.get('/domains', guard(async (req, res) => {
  const ctx = await contextOf(req);
  const available: unknown[] = []; const unavailable: unknown[] = [];
  for (const domain of DOMAINS) {
    const access = await accessFor(ctx, domain);
    if (access.allowed) available.push({ key: domain.key, name: domain.name, icon: domain.icon, description: domain.description, tools: domain.tools.map(tool => ({ name: tool.name, description: tool.description })) });
    // Only contract problems are listed (so the screen can explain them); domains the profile may not use are simply not offered.
    else if (access.reason === 'LICENSE') unavailable.push({ key: domain.key, name: domain.name, reason: access.message });
  }
  const settings = await loadSettings(prisma, ctx.tenantId);
  return res.json({ available, unavailable, unit: ctx.unitId, canSelectUnit: !ctx.boundUnitId && FINANCE_ROLES.includes(ctx.role), external: { providerConfigured: Boolean(currentAiProvider()), consent: settings.ai.externalConsent, enabled: settings.ai.externalEnabled } });
}));

const periodQuery = z.object({ from: z.string().optional(), to: z.string().optional() });
aiRoutes.get('/domains/:key/panel', guard(async (req, res) => {
  const domain = DOMAIN_BY_KEY.get(req.params.key as DomainKey);
  if (!domain) return res.status(404).json({ message: 'Especialista não encontrado.' });
  const query = periodQuery.parse(req.query); const ctx = await contextOf(req); const period = parsePeriod(query.from, query.to);
  const results = []; const reuse: Record<string, string> = {};
  for (const tool of domain.panel) { const out = await runTool(ctx, domain.key, tool, period); results.push(out.result); reuse[`${domain.key}.${tool}`] = out.reuse; }
  return res.json({ domain: { key: domain.key, name: domain.name, icon: domain.icon, description: domain.description }, results, reuse });
}));

// CSV of the specialist's analyses for a period: same permission, licence and unit scope as the panel (it is the panel's data), audited.
aiRoutes.get('/domains/:key/export.csv', guard(async (req, res) => {
  const domain = DOMAIN_BY_KEY.get(req.params.key as DomainKey);
  if (!domain) return res.status(404).json({ message: 'Especialista não encontrado.' });
  const query = periodQuery.parse(req.query); const ctx = await contextOf(req); const period = parsePeriod(query.from, query.to);
  const results = [];
  for (const tool of domain.panel) results.push((await runTool(ctx, domain.key, tool, period)).result);
  await prisma.auditLog.create({ data: { tenantId: ctx.tenantId, actorUserId: ctx.userId, action: 'AI_EXPORT_CSV', entityType: 'AiDomain', entityId: domain.key, metadata: { unitId: ctx.unitId, from: period.from.toISOString(), to: period.to.toISOString() } } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', `attachment; filename="rm-${domain.key}-${period.from.toISOString().slice(0, 10)}_${period.to.toISOString().slice(0, 10)}.csv"`); res.setHeader('Cache-Control', 'no-store');
  return res.send(specialistCsv(domain.name, results));
}));

aiRoutes.post('/ask', guard(async (req, res) => {
  const body = z.object({ question: z.string().trim().min(3).max(300), conversationId: z.string().uuid().optional(), useAi: z.boolean().default(false), from: z.string().optional(), to: z.string().optional(), unitId: z.string().uuid().optional(), domain: z.enum(['finance', 'stock', 'profit', 'sales', 'purchasing', 'customers', 'delivery', 'production', 'waste', 'management']).optional() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: 'Escreva uma pergunta de 3 a 300 caracteres.' });
  const ctx = await contextOf(req); const period = parsePeriod(body.data.from, body.data.to);
  const result = await ask(ctx, body.data.question, { useAi: body.data.useAi, period, domain: body.data.domain });
  // History is private to the user and the company; it keeps the question and the delivered answer, never prompts or secrets.
  let conversationId = body.data.conversationId;
  if (conversationId && !await prisma.aiConversation.findFirst({ where: { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId }, select: { id: true } })) return res.status(404).json({ message: 'Conversa não encontrada.' });
  if (!conversationId) conversationId = (await prisma.aiConversation.create({ data: { tenantId: ctx.tenantId, unitId: ctx.unitId, userId: ctx.userId, title: body.data.question.slice(0, 80) } })).id;
  const meta = { period: { from: period.from.toISOString(), to: period.to.toISOString() }, unit: ctx.unitId, sources: result.results.map(item => ({ tool: item.tool, source: item.source })), reuse: result.reuse };
  await prisma.aiMessage.createMany({ data: [
    { conversationId, tenantId: ctx.tenantId, role: 'user', content: body.data.question, domains: [] },
    { conversationId, tenantId: ctx.tenantId, role: 'assistant', content: [result.answer, result.ai?.text ? `\n${result.ai.text}` : ''].join(''), domains: result.domains.map(item => item.key), meta },
  ] });
  await prisma.aiConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
  return res.json({ conversationId, ...result });
}));

aiRoutes.get('/conversations', guard(async (req, res) => {
  const items = await prisma.aiConversation.findMany({ where: { tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, orderBy: { updatedAt: 'desc' }, take: 50, select: { id: true, title: true, updatedAt: true } });
  return res.json({ items });
}));
aiRoutes.get('/conversations/:id', guard(async (req, res) => {
  const conversation = await prisma.aiConversation.findFirst({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, userId: req.auth!.userId }, include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } } });
  return conversation ? res.json(conversation) : res.status(404).json({ message: 'Conversa não encontrada.' });
}));
aiRoutes.delete('/conversations/:id', guard(async (req, res) => {
  const removed = await prisma.aiConversation.deleteMany({ where: { id: req.params.id, tenantId: req.auth!.tenantId!, userId: req.auth!.userId } });
  return removed.count ? res.status(204).end() : res.status(404).json({ message: 'Conversa não encontrada.' });
}));

// Consumption and efficiency panel: measured counters only.
aiRoutes.get('/usage', requireRoles(...MANAGEMENT_ROLES), guard(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30)); const tenantId = req.auth!.tenantId!;
  const settings = await loadSettings(prisma, tenantId);
  const [summary, limits] = await Promise.all([usageSummary(tenantId, days), limitStatus(tenantId, req.auth!.userId, 'central', settings.ai.limits)]);
  return res.json({ ...summary, limits, settings: settings.ai, provider: { configured: Boolean(currentAiProvider()), name: currentAiProvider()?.name ?? null, model: process.env.AI_MODEL ?? null, simpleModel: process.env.AI_MODEL_SIMPLE ?? null },
    notes: ['Tokens vêm do provedor quando ele os informa; caso contrário são estimados (marcado). Custo em moeda depende da tabela de preços do provedor e não é inventado aqui.', 'A taxa de reaproveitamento mede análises servidas por cache/deduplicação; não é uma economia percentual de custo.'] });
}));
// Before/after consumption: the last N days against the N before. Real and estimated tokens are never summed together.
aiRoutes.get('/usage/compare', requireRoles(...MANAGEMENT_ROLES), guard(async (req, res) => res.json(await usageComparison(req.auth!.tenantId!, Math.min(90, Math.max(1, Number(req.query.days) || 7))))));

// Pre-call estimate for a question: which specialists would answer, an input-token range and whether a paid model call would be allowed now. Nothing is sent and nothing is recorded.
aiRoutes.post('/estimate', guard(async (req, res) => {
  const body = z.object({ question: z.string().trim().min(2).max(1000) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ message: 'Informe a pergunta.' });
  const ctx = await contextOf(req); const settings = await loadSettings(prisma, ctx.tenantId);
  const routed = routeQuestion(body.data.question).domains.slice(0, settings.ai.limits.maxSpecialistsPerQuestion);
  const domains = routed.map(key => DOMAIN_BY_KEY.get(key)!).filter(domain => domain.roles.includes(ctx.role));
  const system = domains.map(domain => domain.instructions).join(' ');
  const base = estimateCall(system, body.data.question, 500);
  const availability = await modelAvailability(ctx, settings, domains.length === 1 ? domains[0].key : 'central');
  return res.json({ domains: domains.map(domain => ({ key: domain.key, name: domain.name })), estimate: { ...base, inputTokensMax: base.inputTokens + estimateTokens('x'.repeat(settings.ai.limits.maxInputChars)), note: 'Estimativa por caracteres÷4 antes da chamada; o consumo real só é conhecido depois, pelo relatório do provedor.' },
    modelCallAllowed: domains.length > 0 && availability.available, reason: domains.length === 0 ? 'Nenhum especialista disponível para esta pergunta e perfil.' : availability.reason, limits: availability.limits });
}));
aiRoutes.get('/settings', requireRoles(...MANAGEMENT_ROLES), guard(async (req, res) => res.json({ ai: (await loadSettings(prisma, req.auth!.tenantId!)).ai })));
aiRoutes.put('/settings', requireRoles('ADMIN'), guard(async (req, res) => {
  const tenantId = req.auth!.tenantId!;
  const saved = await prisma.$transaction(async tx => {
    const current = await loadSettings(tx, tenantId);
    const next = await saveSettingsSection(tx, tenantId, 'ai', { ...current.ai, ...(typeof req.body === 'object' && req.body ? req.body : {}), limits: { ...current.ai.limits, ...(req.body?.limits ?? {}) } });
    await tx.auditLog.create({ data: { tenantId, actorUserId: req.auth!.userId, action: 'AI_SETTINGS_UPDATED', entityType: 'TenantSettings', entityId: tenantId, metadata: { externalConsent: next.externalConsent, externalEnabled: next.externalEnabled } } });
    return next;
  });
  return res.json({ ai: saved });
}));
