import { Prisma, type PrismaClient } from '@prisma/client';
import { loadInsights } from '../routes/intelligence';
import { addDays, brl, goalProgress } from './intelligence';
import { emailProviders } from './providers';
import { localParts } from './scheduling';
import { loadSettings, type TenantSettingsData } from './settings';

type Db = PrismaClient | Prisma.TransactionClient;
type RuleKey = keyof TenantSettingsData['automations']['rules'];

// `financial` rules carry revenue/payables figures, so only roles allowed in the Financial module may read them (see routes/notifications.ts).
export const AUTOMATION_RULES: { key: RuleKey; label: string; financial: boolean; alertKey?: string }[] = [
  { key: 'lowStock', label: 'Estoque abaixo do mínimo', financial: false, alertKey: 'low-stock' },
  { key: 'expiring', label: 'Insumos próximos do vencimento', financial: false, alertKey: 'expiring' },
  { key: 'delayedOrders', label: 'Pedidos atrasados', financial: false, alertKey: 'delayed-orders' },
  { key: 'payables', label: 'Contas a pagar vencendo', financial: true, alertKey: 'payables' },
  { key: 'receivables', label: 'Contas a receber vencidas', financial: true, alertKey: 'receivables' },
  { key: 'cashDivergence', label: 'Divergência de caixa', financial: true, alertKey: 'cash-divergence' },
  { key: 'salesDrop', label: 'Queda nas vendas', financial: true, alertKey: 'sales-drop' },
  { key: 'lowMargin', label: 'Margem de lucro baixa', financial: true, alertKey: 'low-margin' },
  { key: 'waste', label: 'Desperdício registrado', financial: true, alertKey: 'waste' },
  { key: 'goalReached', label: 'Meta mensal atingida', financial: true },
  { key: 'belowGoal', label: 'Projeção abaixo da meta', financial: true },
  { key: 'dailySummary', label: 'Resumo diário', financial: true },
  { key: 'weeklyReport', label: 'Relatório semanal', financial: true },
];
export const FINANCIAL_RULE_KEYS = AUTOMATION_RULES.filter(rule => rule.financial).map(rule => rule.key as string);

export type Candidate = { ruleKey: string; dedupeKey: string; severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; body: string; href: string | null };
type Insights = Awaited<ReturnType<typeof loadInsights>>;

// Pure: turns the current insights into the notifications that should exist. Idempotency comes from dedupeKey (day, month or week).
export function planAutomations(insights: Insights, settings: TenantSettingsData, now: Date): Candidate[] {
  const config = settings.automations;
  if (!config.enabled) return [];
  const tz = settings.hours.timezone;
  const local = localParts(now, tz);
  const today = local.day;
  const hourReached = Math.floor(local.minutes / 60) >= config.summaryHour;
  const out: Candidate[] = [];

  for (const rule of AUTOMATION_RULES) {
    if (!rule.alertKey || !config.rules[rule.key]) continue;
    const alert = insights.alerts.find(item => item.key === rule.alertKey);
    if (!alert) continue;
    out.push({ ruleKey: rule.key, dedupeKey: `${rule.key}:${today}`, severity: alert.severity === 'critical' ? 'CRITICAL' : alert.severity === 'warning' ? 'WARNING' : 'INFO', title: alert.title, body: alert.detail, href: alert.href });
  }

  const goal = settings.intelligence.monthlyGoal;
  if (goal > 0) {
    const progress = goalProgress(insights.analysis.monthToDate, goal, now, tz);
    if (config.rules.goalReached && progress.reached) out.push({ ruleKey: 'goalReached', dedupeKey: `goalReached:${today.slice(0, 7)}`, severity: 'INFO', title: 'Meta mensal atingida', body: `O faturamento do mês chegou a ${brl(progress.monthToDate)}, meta de ${brl(goal)}.`, href: '/intelligence' });
    const projection = insights.forecast?.monthProjection;
    const dayOfMonth = Number(today.slice(8, 10));
    if (config.rules.belowGoal && !progress.reached && projection !== undefined && dayOfMonth >= 10 && projection < goal) {
      out.push({ ruleKey: 'belowGoal', dedupeKey: `belowGoal:${today.slice(0, 7)}:${Math.floor((dayOfMonth - 1) / 7)}`, severity: 'WARNING', title: 'Projeção abaixo da meta do mês', body: `A projeção estimada é ${brl(projection)} para uma meta de ${brl(goal)}. Faltam ${brl(progress.missing)} em ${progress.remainingDays} dia(s). Valor estimado, não é resultado efetivo.`, href: '/intelligence' });
    }
  }

  if (config.rules.dailySummary && hourReached && insights.analysis.daysWithSales > 0) {
    const yesterday = insights.analysis.dayTotals.get(addDays(today, -1)) ?? 0;
    out.push({ ruleKey: 'dailySummary', dedupeKey: `dailySummary:${today}`, severity: 'INFO', title: 'Resumo de ontem', body: `Faturamento de ${brl(yesterday)} (pedidos concluídos). Mês até agora: ${brl(insights.analysis.monthToDate)}.`, href: '/dashboard' });
  }
  if (config.rules.weeklyReport && hourReached && local.weekday === 1 && insights.trend) {
    const { last7, previous7, changePercent } = insights.trend;
    out.push({ ruleKey: 'weeklyReport', dedupeKey: `weeklyReport:${today}`, severity: 'INFO', title: 'Relatório semanal', body: `Últimos 7 dias: ${brl(last7)} (${changePercent >= 0 ? '+' : ''}${changePercent}% sobre os 7 dias anteriores, ${brl(previous7)}).`, href: '/reports?r=sales' });
  }
  return out;
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char] as string));

export async function runAutomations(db: PrismaClient, tenantId: string, now = new Date()) {
  const settings = await loadSettings(db, tenantId);
  if (!settings.automations.enabled) return { created: 0, emailed: 0 };
  const insights = await loadInsights({ tenantId }, settings, now);
  const candidates = planAutomations(insights, settings, now);
  const emailProvider = settings.automations.emailTo.length ? emailProviders.get('smtp') : undefined;
  let created = 0; let emailed = 0;
  for (const candidate of candidates) {
    let row;
    try { row = await db.notification.create({ data: { tenantId, ...candidate } }); created += 1; }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue; throw error; }
    if (!emailProvider) continue;
    try {
      for (const to of settings.automations.emailTo) await emailProvider.send({ to, subject: `RM Restaurant: ${candidate.title}`, text: `${candidate.title}\n\n${candidate.body}`, html: `<p><strong>${escapeHtml(candidate.title)}</strong></p><p>${escapeHtml(candidate.body)}</p>` });
      await db.notification.update({ where: { id: row.id }, data: { emailedAt: new Date() } });
      emailed += 1;
    } catch (error) { console.error('automation email failed', tenantId, candidate.ruleKey, error instanceof Error ? error.message : error); }
  }
  return { created, emailed };
}

export async function runAutomationsForAllTenants(db: PrismaClient, now = new Date()) {
  const tenants = await db.tenant.findMany({ where: { status: { in: ['ACTIVE', 'TRIAL'] } }, select: { id: true } });
  let created = 0;
  for (const tenant of tenants) {
    try { created += (await runAutomations(db, tenant.id, now)).created; } catch (error) { console.error('automations error', tenant.id, error); }
  }
  return created;
}
