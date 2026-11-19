'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from '../../components/nav-link';
import { api, errorMessage, formatMoney } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, StatCard, Tabs, Toggle } from '../../components/ui';
import { BusinessPanel, SalesOpportunities, StockPanel } from '../../components/intelligence-panels';
import { AutomationsPanel } from '../../components/automations-panel';
import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

type Alert = { key: string; severity: 'critical' | 'warning' | 'info'; title: string; detail: string; href: string };
type Config = { monthlyGoal: number; alerts: Record<string, boolean>; salesDropPercent: number; payableDays: number; expiringDays: number; delayedMinutes: number; marginFloorPercent: number };
type Summary = {
  historyDays: number; truncated: boolean;
  sales: { today: number; yesterday: number; ordersToday: number; monthToDate: number; ordersMonth: number; avgTicketMonth: number | null; previousMonthSamePeriod: number; monthChangePercent: number | null; bestDay: { day: string; total: number } | null; byChannel: { channel: string; orders: number; total: number; share: number }[]; peakHours: { hour: number; orders: number }[]; daysWithSales: number };
  trend: { last7: number; previous7: number; changePercent: number } | null;
  goal: { goal: number; monthToDate: number; missing: number; remainingDays: number; perDay: number; reached: boolean } | null;
  forecast: { basis: string; nextDays: { day: string; expected: number }[]; monthProjection: number; remainingDays: number; dailyAverage: number } | null; forecastNote: string;
  month: { revenue: number; revenueWithCost: number; cogs: number; grossProfit: number; coverage: number; expensesPaid: number; operatingResult: number };
  topProducts: { name: string; quantity: number; revenue: number }[]; lessSold: { name: string; quantity: number }[];
  topMargins: { name: string; price: number; cost: number; marginPercent: number; marginValue: number }[];
  expenses: { current: number; previous: number }; wasteCost: number; alerts: Alert[]; alertConfig: Config;
};
type Message = { role: 'user' | 'assistant'; text: string; notes?: string[] };
const suggestions = ['Quanto vendi hoje?', 'Quanto lucrei neste mês?', 'Qual foi meu melhor dia de vendas?', 'Qual produto vende mais?', 'Qual produto oferece maior margem?', 'Quais produtos estão vendendo menos?', 'Quais despesas aumentaram?', 'Qual funcionário realizou mais vendas?', 'Qual foi o ticket médio?', 'Quais produtos preciso comprar?', 'Qual a previsão de faturamento do mês?', 'Qual a evolução em relação ao mês anterior?'];
const alertLabels: Record<string, string> = { salesDrop: 'Queda nas vendas', lowStock: 'Estoque crítico', payables: 'Contas a pagar próximas do vencimento', receivables: 'Contas a receber vencidas', lowMargin: 'Margem de lucro reduzida', delayedOrders: 'Pedidos atrasados', cashDivergence: 'Divergência de caixa', waste: 'Desperdício registrado', expiring: 'Insumos próximos do vencimento' };
const channelLabels: Record<string, string> = { POS: 'PDV', TABLE: 'Mesa / QR Code', DELIVERY: 'Delivery', TAKEAWAY: 'Retirada', WHATSAPP: 'WhatsApp' };
const tone = { critical: 'red', warning: 'gold', info: 'blue' } as const;
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', timeZone: 'UTC' });

const tabs = [{ key: 'assistant', label: '🧠 RM Assistente' }, { key: 'sales', label: '📈 Inteligência de vendas' }, { key: 'stock', label: '📦 Inteligência de estoque' }, { key: 'business', label: '✨ Inteligência de negócios (IA)' }] as const;
type Tab = (typeof tabs)[number]['key'];

function IntelligenceContent({ initial }: { initial: Tab }) {
  const [tab, setTabState] = useState<Tab>(initial);
  const router = useRouter();
  const setTab = (next: Tab) => { setTabState(next); router.replace(`/intelligence?tab=${next}`, { scroll: false }); };
  const [data, setData] = useState<Summary | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [messages, setMessages] = useState<Message[]>([{ role: 'assistant', text: 'Olá! Respondo com os dados reais do seu restaurante. Se algo não estiver registrado, eu aviso. Escolha uma pergunta ou escreva a sua.' }]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try { const summary = await api<Summary>('/intelligence/summary'); setData(summary); setConfig(summary.alertConfig); } catch (cause) { setError(errorMessage(cause, 'Falha ao carregar o RM Inteligência')); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);

  async function ask(text: string) {
    const content = text.trim();
    if (content.length < 3 || asking) return;
    setMessages(current => [...current, { role: 'user', text: content }]); setQuestion(''); setAsking(true);
    try {
      const result = await api<{ answer: string; limitations: string[] }>('/intelligence/ask', { method: 'POST', body: JSON.stringify({ question: content }) });
      setMessages(current => [...current, { role: 'assistant', text: result.answer, notes: result.limitations }]);
    } catch (cause) { setMessages(current => [...current, { role: 'assistant', text: errorMessage(cause, 'Não foi possível responder agora.') }]); } finally { setAsking(false); }
  }
  async function saveConfig(event: React.FormEvent) {
    event.preventDefault(); if (!config) return; setSaved('');
    try { await api('/settings/intelligence', { method: 'PUT', body: JSON.stringify(config) }); setSaved('Preferências salvas.'); await load(); } catch (cause) { setError(errorMessage(cause, 'Falha ao salvar as preferências')); }
  }

  const peak = Math.max(1, ...(data?.forecast?.nextDays ?? []).map(day => day.expected));
  return <AppShell title="RM Inteligência">
    <Tabs tabs={tabs.map(item => ({ key: item.key, label: item.label }))} value={tab} onChange={setTab} label="RM Inteligência" />
    <PageHeader title="RM Inteligência" subtitle="Indicadores, previsões e alertas calculados com os dados reais do seu restaurante. Nada é inventado: quando faltar informação, o sistema informa a limitação." />
    {error && <Notice message={error} />}
    {!data && !error && <p className="text-sm text-slate-500">Analisando os dados…</p>}
    {data && <>
      {data.truncated && <Notice message="O histórico de 90 dias é muito grande; a análise considera os pedidos mais recentes." />}
      {tab === 'assistant' && <>
      <section aria-label="Alertas inteligentes" className="mb-6">
        {data.alerts.length === 0 ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">✅ Nenhum alerta ativo no momento.</div> : <div className="grid gap-3 lg:grid-cols-2">
          {data.alerts.map(alert => <Link key={alert.key} href={alert.href} className="block rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-400">
            <div className="flex items-center gap-2"><Badge tone={tone[alert.severity]}>{alert.severity === 'critical' ? 'Crítico' : alert.severity === 'warning' ? 'Atenção' : 'Informativo'}</Badge><strong className="text-sm">{alert.title}</strong></div>
            <p className="mt-1 text-xs text-slate-600">{alert.detail}</p>
          </Link>)}
        </div>}
      </section>
        <div className="mb-6 max-w-4xl">
        <section className={`${panelClass} flex flex-col`} aria-label="Assistente">
          <h2 className="text-base font-bold">🧠 Assistente do proprietário</h2>
          <div className="my-3 h-72 space-y-3 overflow-y-auto rounded-xl bg-slate-50 p-3" role="log" aria-live="polite">
            {messages.map((message, index) => <div key={index} className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm ${message.role === 'user' ? 'ml-auto bg-neutral-950 text-white' : 'border border-slate-200 bg-white text-slate-800'}`}>
              {message.text}{message.notes?.map((note, noteIndex) => <p key={noteIndex} className="mt-1 text-xs text-slate-500">ℹ {note}</p>)}
            </div>)}
            {asking && <p className="text-xs text-slate-500">Consultando os dados…</p>}
            <div ref={endRef} />
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">{suggestions.map(item => <button key={item} type="button" onClick={() => void ask(item)} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:border-brand-400 hover:bg-brand-50">{item}</button>)}</div>
          <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void ask(question); }}>
            <input aria-label="Pergunta" value={question} maxLength={300} onChange={event => setQuestion(event.target.value)} placeholder="Pergunte sobre vendas, lucro, estoque, metas…" className="min-w-0 flex-1 rounded-xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-brand-500" />
            <button className={buttonClass} disabled={asking || question.trim().length < 3}>Perguntar</button>
          </form>
        </section>
        </div>
      </>}
      {tab === 'sales' && <>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard tone="dark" label="Hoje" value={formatMoney(data.sales.today)} hint={`${data.sales.ordersToday} pedido(s) concluído(s)`} />
        <StatCard label="Ontem" value={formatMoney(data.sales.yesterday)} />
        <StatCard label="Mês até hoje" value={formatMoney(data.sales.monthToDate)} hint={data.sales.monthChangePercent === null ? 'Sem base do mês anterior' : `${data.sales.monthChangePercent >= 0 ? '+' : ''}${data.sales.monthChangePercent}% vs. mesmo período do mês anterior`} />
        <StatCard label="Ticket médio do mês" value={data.sales.avgTicketMonth === null ? '—' : formatMoney(data.sales.avgTicketMonth)} hint={`${data.sales.ordersMonth} pedidos`} />
        <StatCard label="Meta mensal" value={data.goal ? (data.goal.reached ? 'Alcançada ✅' : `Faltam ${formatMoney(data.goal.missing)}`) : 'Não definida'} hint={data.goal ? `${formatMoney(data.goal.perDay)} por dia em ${data.goal.remainingDays} dia(s)` : 'Defina em Preferências'} />
      </div>
        <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <section className={panelClass} aria-label="Previsão">
          <div className="flex items-center justify-between"><h2 className="text-base font-bold">📈 Previsão de faturamento</h2><Badge tone="blue">Estimativa</Badge></div>
          {data.forecast ? <>
            <p className="mt-2 text-sm text-slate-600">Realizado no mês: <strong>{formatMoney(data.sales.monthToDate)}</strong> · Projeção do mês: <strong>{formatMoney(data.forecast.monthProjection)}</strong> <span className="text-xs text-slate-500">(estimativa)</span></p>
            <div className="mt-4 flex h-40 items-end gap-2" role="img" aria-label="Previsão dos próximos 7 dias">
              {data.forecast.nextDays.map(day => <div key={day.day} className="flex flex-1 flex-col items-center justify-end gap-1"><span className="text-[10px] font-semibold text-slate-600">{formatMoney(day.expected)}</span><div className="w-full rounded-t-lg border border-dashed border-brand-500 bg-brand-100" style={{ height: `${Math.max(4, (day.expected / peak) * 100)}%` }} /><span className="text-[10px] text-slate-500">{weekday(day.day)}</span></div>)}
            </div>
            <p className="mt-3 text-xs text-slate-500">{data.forecast.basis}. Média diária recente: {formatMoney(data.forecast.dailyAverage)}. Barras tracejadas = previsto; o resultado real aparece nos indicadores acima.</p>
          </> : <p className="mt-3 text-sm text-slate-600">{data.forecastNote}</p>}
          {data.trend && <p className="mt-3 text-sm text-slate-700">Últimos 7 dias: <strong>{formatMoney(data.trend.last7)}</strong> ({data.trend.changePercent >= 0 ? '+' : ''}{data.trend.changePercent}% vs. 7 dias anteriores)</p>}
        </section>
        <section className={panelClass}><h2 className="mb-3 text-base font-bold">🔀 Canais de venda (90 dias)</h2>
          {data.sales.byChannel.length === 0 ? <EmptyState title="Sem vendas concluídas" /> : <div className="space-y-3">{data.sales.byChannel.map(channel => <div key={channel.channel}><div className="flex justify-between text-sm"><strong>{channelLabels[channel.channel] ?? channel.channel}</strong><span className="text-slate-500">{formatMoney(channel.total)} · {channel.orders} pedidos · {channel.share}%</span></div><div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${channel.share}%` }} /></div></div>)}</div>}
          {data.sales.peakHours.length > 0 && <p className="mt-4 text-sm text-slate-700">Horários de pico: {data.sales.peakHours.map(item => `${String(item.hour).padStart(2, '0')}h (${item.orders})`).join(' · ')}</p>}
          {data.sales.bestDay && <p className="mt-1 text-sm text-slate-700">Melhor dia: {data.sales.bestDay.day.split('-').reverse().join('/')} — {formatMoney(data.sales.bestDay.total)}</p>}
        </section>
        </div>
      <div className="mb-6 grid gap-6 xl:grid-cols-3">
        <section className={panelClass}><h2 className="mb-3 text-base font-bold">🏆 Mais vendidos (30 dias)</h2>
          {data.topProducts.length === 0 ? <EmptyState icon="🍽️" title="Sem vendas no período" /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Qtd.' }, { label: 'Faturamento' }]}>{data.topProducts.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.quantity}</td><td>{formatMoney(item.revenue)}</td></tr>)}</DataTable>}
        </section>
        <section className={panelClass}><h2 className="mb-3 text-base font-bold">🐢 Menos vendidos (30 dias)</h2>
          {data.lessSold.length === 0 ? <EmptyState title="Nenhum produto ativo" /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Qtd.' }]}>{data.lessSold.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.quantity}</td></tr>)}</DataTable>}
        </section>
        <section className={panelClass}><h2 className="mb-3 text-base font-bold">💹 Maiores margens</h2>
          {data.topMargins.length === 0 ? <EmptyState icon="🧮" title="Nenhum custo cadastrado" hint="Cadastre custo ou ficha técnica nos produtos." /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Margem' }, { label: 'Por un.' }]}>{data.topMargins.map(item => <tr key={item.name}><td>{item.name}</td><td>{item.marginPercent}%</td><td>{formatMoney(item.marginValue)}</td></tr>)}</DataTable>}
        </section>
      </div>
        <SalesOpportunities data={data} />
      </>}
      {tab === 'business' && <>
        <BusinessPanel />
      <section className={`${panelClass} mb-6`} aria-label="Resultado do mês">
        <h2 className="mb-1 text-base font-bold">💰 Resultado do mês — faturamento não é lucro</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Faturamento (pedidos concluídos)" value={formatMoney(data.month.revenue)} />
          <StatCard label="Lucro bruto estimado" value={formatMoney(data.month.grossProfit)} hint={`Custo de ${formatMoney(data.month.cogs)} · cobre ${data.month.coverage}% do faturamento`} />
          <StatCard label="Despesas pagas no mês" value={formatMoney(data.month.expensesPaid)} hint={`Mês anterior: ${formatMoney(data.expenses.previous)}`} />
          <StatCard tone="dark" label="Resultado operacional" value={formatMoney(data.month.operatingResult)} hint="Faturamento − despesas pagas" />
        </div>
        {data.month.coverage < 100 && <p className="mt-2 text-xs text-slate-500">O lucro bruto só considera produtos com custo cadastrado ({data.month.coverage}% do faturamento). Cadastre custos ou fichas técnicas para aumentar a precisão.{data.wasteCost > 0 && ` Perdas registradas em 30 dias: ${formatMoney(data.wasteCost)}.`}</p>}
      </section>
        <div className="mb-6">
        {config && <form onSubmit={saveConfig} className={`${panelClass} space-y-3`}>
          <h2 className="text-base font-bold">⚙️ Preferências de alertas e meta</h2>
          {saved && <Notice message={saved} kind="success" />}
          <div className="grid gap-2 sm:grid-cols-2">{Object.keys(alertLabels).map(key => <Toggle key={key} label={alertLabels[key]} checked={config.alerts[key] ?? true} onChange={value => setConfig({ ...config, alerts: { ...config.alerts, [key]: value } })} />)}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Meta de faturamento mensal (R$, 0 = sem meta)" type="number" min={0} step="0.01" value={config.monthlyGoal} onChange={event => setConfig({ ...config, monthlyGoal: Number(event.target.value) })} />
            <Field label="Queda de vendas que gera alerta (%)" type="number" min={5} max={90} value={config.salesDropPercent} onChange={event => setConfig({ ...config, salesDropPercent: Number(event.target.value) })} />
            <Field label="Avisar contas a pagar em (dias)" type="number" min={0} max={30} value={config.payableDays} onChange={event => setConfig({ ...config, payableDays: Number(event.target.value) })} />
            <Field label="Avisar vencimento de insumos em (dias)" type="number" min={0} max={60} value={config.expiringDays ?? 3} onChange={event => setConfig({ ...config, expiringDays: Number(event.target.value) })} />
            <Field label="Pedido atrasado após (minutos)" type="number" min={5} max={240} value={config.delayedMinutes} onChange={event => setConfig({ ...config, delayedMinutes: Number(event.target.value) })} />
            <Field label="Margem mínima desejada (%)" type="number" min={0} max={100} value={config.marginFloorPercent} onChange={event => setConfig({ ...config, marginFloorPercent: Number(event.target.value) })} />
          </div>
          <button className={buttonClass}>Salvar preferências</button>
        </form>}
        <AutomationsPanel />
        </div>
      </>}
    </>}
    {tab === 'stock' && <StockPanel />}
  </AppShell>;
}

export default function IntelligencePage() {
  return <Suspense fallback={null}><IntelligenceRoute /></Suspense>;
}

function IntelligenceRoute() {
  const requested = useSearchParams().get('tab');
  const initial = tabs.find(item => item.key === requested)?.key ?? 'assistant';
  return <IntelligenceContent key={initial} initial={initial} />;
}
