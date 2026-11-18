'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, errorMessage, formatMoney, storedUser } from '../../lib/api';
import Link from 'next/link';
import { AppShell, flows, moduleIcon, moduleLabel, Notice, panelClass } from '../../components/app-shell';
import { AreaChart, DonutChart } from '../../components/charts';
import { GoldCard, HeroBanner, StatCard } from '../../components/ui';
import { AssistantPanel, BarList, GoalRing } from '../../components/dashboard-widgets';
import { hrefAllowed } from '../../lib/menu-catalog';

type Summary = {
  totalCompanies?: number; activeCompanies?: number; trialCompanies?: number; suspendedCompanies?: number;
  users?: number; orders?: number; products?: number; employees?: number; openOrders?: number; note?: string;
  daily?: { orders: number; completedOrders: number; sales: string | number; averageTicket: string | number };
  monthly?: { orders: number; completedOrders: number; sales: string | number };
  tables?: { active: number; occupied: number; available: number };
  financial?: { openReceivables: string | number; openPayables: string | number; monthlyExpenses: string | number; estimatedOperatingBalance: string | number } | null;
  salesTrend?: { day: string; total: string | number }[];
};

const metricIcons: Record<string, string> = { 'Empresas cadastradas': '🏢', 'Empresas ativas': '✅', 'Em período de teste': '🧪', Suspensas: '⛔', Usuários: '👥', Pedidos: '🧾', 'Receita recorrente (MRR)': '📈', 'Recebido no mês': '💰', 'Em aberto': '⏳', Vencido: '⚠️', 'Vendas concluídas hoje': '💵', 'Vendas concluídas no mês': '📊', 'Pedidos de hoje': '🛎️', 'Ticket médio hoje': '🎟️', 'Mesas ocupadas': '🪑', 'Mesas disponíveis': '✔️', 'Produtos ativos': '🍽️', 'Funcionários ativos': '🧑‍🍳', 'Contas a receber': '📥', 'Contas a pagar': '📤', 'Despesas baixadas no mês': '💳', 'Resultado estimado no mês': '🏦' };
function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return <StatCard icon={metricIcons[label]} label={label} value={value} hint={detail} tone={label.startsWith('Vendas concluídas') || label.startsWith('Receita') ? 'dark' : 'default'} />;
}

const rmModules = [
  { href: '/intelligence?tab=assistant', icon: '🧠', title: 'RM Assistente', text: 'Pergunte sobre vendas, lucro, estoque e metas em linguagem natural.' },
  { href: '/intelligence?tab=sales', icon: '📈', title: 'Inteligência de vendas', text: 'Mais vendidos, horários de pico, canais, previsão e campanhas sugeridas.' },
  { href: '/intelligence?tab=stock', icon: '📦', title: 'Inteligência de estoque', text: 'Cobertura, sugestão de compra, desperdício e curva ABC.' },
  { href: '/intelligence?tab=business', icon: '✨', title: 'Inteligência de negócios (IA)', text: 'Diagnóstico executivo com seus dados e análise por IA opcional.' },
  { href: '/kds', icon: '👨‍🍳', title: 'RM KDS — Painel de Produção', text: 'Pedidos por setor com cronômetro, atraso e prioridade em tempo real.' },
  { href: '/delivery', icon: '🛵', title: 'RM Delivery — Central de Delivery', text: 'Quadro de entregas, entregadores, zonas, taxas e tempo estimado.' },
  { href: '/profit', icon: '💹', title: 'RM Controle de Lucro', text: 'Faturamento, margem, CMV, despesas e resultado — faturamento não é lucro.' },
];

type Goal = { goal: number; monthToDate: number; missing: number; remainingDays: number; perDay: number; reached: boolean };
type Insight = { goal: Goal | null; sales: { byChannel: { channel: string; total: number }[] }; topProducts: { name: string; quantity: number; revenue: number }[]; alerts: { key: string; severity: string; title: string; detail: string; href: string }[] };
const channelLabel: Record<string, string> = { POS: 'PDV', TABLE: 'Mesa / QR Code', DELIVERY: 'Delivery', TAKEAWAY: 'Retirada', WHATSAPP: 'WhatsApp' };

type CommercialSummary = { revenue: { mrr: number; received: number; open: number; overdue: number }; subscriptions: { active: number; expired: number }; clients: { delinquent: number }; byPlan: { id: string; name: string; subscriptions: number }[]; evolution: { month: string; received: number }[] };
function MasterCommercial() {
  const [data, setData] = useState<CommercialSummary | null>(null);
  useEffect(() => { api<CommercialSummary>('/commercial/overview').then(setData).catch(() => undefined); }, []);
  if (!data) return null;
  return <section className="mt-6">
    <div className="mb-3 flex items-center justify-between"><h2 className="text-base font-bold">Resultado comercial do mês</h2><Link href="/commercial" className="text-sm font-semibold text-brand-700 hover:text-brand-600">Abrir gestão comercial ›</Link></div>
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Metric label="Receita recorrente (MRR)" value={formatMoney(data.revenue.mrr)} detail={`${data.subscriptions.active} assinatura(s) ativa(s)`} />
      <Metric label="Recebido no mês" value={formatMoney(data.revenue.received)} detail="Pagamentos confirmados" />
      <Metric label="Em aberto" value={formatMoney(data.revenue.open)} detail={`${data.subscriptions.expired} assinatura(s) vencida(s)`} />
      <Metric label="Vencido" value={formatMoney(data.revenue.overdue)} detail={`${data.clients.delinquent} cliente(s) inadimplente(s)`} />
    </div>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <article className={panelClass}><h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Evolução do faturamento</h3><AreaChart label="Evolução do faturamento recebido" format={formatMoney} points={data.evolution.map(point => ({ label: `${point.month.slice(5)}/${point.month.slice(2, 4)}`, value: point.received }))} /></article>
      <article className={panelClass}><h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Planos mais vendidos</h3>{data.byPlan.some(plan => plan.subscriptions > 0) ? <DonutChart centerLabel="Planos mais vendidos" format={value => `${value} assin.`} slices={data.byPlan.filter(plan => plan.subscriptions > 0).map(plan => ({ label: plan.name, value: plan.subscriptions }))} /> : <p className="text-sm text-slate-500">Nenhuma assinatura ativa.</p>}</article>
    </div>
  </section>;
}

export default function DashboardPage() {
  const [result, setResult] = useState<{ summary: Summary; isMaster: boolean } | null>(null);
  const [error, setError] = useState('');
  const [insight, setInsight] = useState<Insight | null>(null);
  const [enabledModules, setEnabledModules] = useState<string[] | null>(null);
  const router = useRouter();

  useEffect(() => {
    let active = true;
    const user = storedUser();
    const isMaster = user.role === 'MASTER_ADMIN';
    api<Summary>(isMaster ? '/dashboard/master' : '/dashboard/restaurant')
      .then(summary => { if (active) setResult({ summary, isMaster }); if (!isMaster) api<{ user: { enabledModules?: string[] | null } }>('/auth/me').then(me => { if (active) setEnabledModules(me.user.enabledModules ?? null); }).catch(() => undefined); if (!isMaster) api<Insight>('/intelligence/summary').then(data => { if (active) setInsight(data); }).catch(() => undefined); })
      .catch(cause => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) router.replace('/login');
        else setError(errorMessage(cause, 'Erro ao carregar painel'));
      });
    return () => { active = false; };
  }, [router]);

  const summary = result?.summary;
  const isMaster = result?.isMaster ?? false;
  const formatDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });

  return <AppShell title={isMaster ? 'Painel Master' : 'Visão geral'}>
    {error && <Notice message={error} />}
    {!summary && !error && <p className="text-sm text-slate-500">Carregando indicadores…</p>}
    {summary && (isMaster
      ? <>
        <HeroBanner title="RM Painel Admin" highlight="Gestão Comercial Completa, Inteligente e Dinâmica" text="Crie, gerencie e potencialize planos, módulos, promoções e clientes em um só lugar." tiles={[{ href: '/plans', icon: '💎', label: 'Planos Personalizados' }, { href: '/commercial?tab=modules', icon: '🧩', label: 'Módulos Flexíveis' }, { href: '/commercial?tab=campaigns', icon: '🔖', label: 'Promoções e Cupons' }, { href: '/licenses', icon: '🏢', label: 'Clientes Organizados' }, { href: '/commercial?tab=billing', icon: '💳', label: 'Financeiro Integrado' }]} />
        <GoldCard number={1} title="Visão geral da plataforma" subtitle="Estabelecimentos e uso em tempo real">
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <Metric label="Empresas cadastradas" value={summary.totalCompanies ?? 0} />
            <Metric label="Empresas ativas" value={summary.activeCompanies ?? 0} />
            <Metric label="Em período de teste" value={summary.trialCompanies ?? 0} />
            <Metric label="Suspensas" value={summary.suspendedCompanies ?? 0} />
            <Metric label="Usuários" value={summary.users ?? 0} />
            <Metric label="Pedidos" value={summary.orders ?? 0} />
          </section>
        </GoldCard>
        <MasterCommercial />
      </>
      : <>
        <HeroBanner title="RM Restaurant" highlight="Gestão gastronômica completa e conectada" text="Acompanhe o atendimento, a cozinha e os resultados em um só lugar." tiles={[{ href: '/pdv', icon: '🖥️', label: 'PDV Interativo' }, { href: '/comandas', icon: '🍽️', label: 'Mesas e Comandas' }, { href: '/kds', icon: '👨‍🍳', label: 'Painel de Produção' }, { href: '/inventory', icon: '📦', label: 'Estoque Inteligente' }, { href: '/intelligence', icon: '🧠', label: 'RM Inteligência' }]} />
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Indicadores do dia">
          <Metric label="Vendas concluídas hoje" value={formatMoney(summary.daily?.sales)} detail={`${summary.daily?.completedOrders ?? 0} pedido(s) concluído(s)`} />
          <Metric label="Pedidos de hoje" value={summary.daily?.orders ?? 0} detail={`${summary.openOrders ?? 0} em andamento agora`} />
          <Metric label="Ticket médio hoje" value={formatMoney(summary.daily?.averageTicket)} detail="Pedidos concluídos" />
          <Metric label="Vendas concluídas no mês" value={formatMoney(summary.monthly?.sales)} detail={`${summary.monthly?.completedOrders ?? 0} pedido(s) concluído(s)`} />
        </section>
        <section className="mt-4 grid gap-4 xl:grid-cols-3">
          <article className={`${panelClass} xl:col-span-2`}>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Operação</p><h2 className="mt-1 text-lg font-semibold">Vendas concluídas · últimos 7 dias</h2></div><p className="text-xs text-slate-500">Valores reais de pedidos concluídos</p></div>
            <AreaChart label="Gráfico de vendas concluídas nos últimos sete dias" format={formatMoney} points={(summary.salesTrend ?? []).map(point => ({ label: formatDay(point.day), value: Number(point.total) }))} />
            {(summary.salesTrend ?? []).every(point => Number(point.total) === 0) && <p className="mt-2 text-sm text-slate-500">Ainda não há vendas concluídas nesse período.</p>}
          </article>
          {insight ? <article className={panelClass}><h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-slate-700">Vendas por canal · 90 dias</h2>{insight.sales.byChannel.length === 0 ? <p className="text-sm text-slate-500">Sem vendas concluídas para comparar canais.</p> : <DonutChart centerLabel="Vendas por canal" format={formatMoney} slices={insight.sales.byChannel.map(item => ({ label: channelLabel[item.channel] ?? item.channel, value: item.total }))} />}</article> : <article className={panelClass}><p className="text-sm text-slate-500">Carregando canais…</p></article>}
        </section>
        <section className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <article className={panelClass}><AssistantPanel allowed={hrefAllowed('/intelligence', enabledModules)} /></article>
          <article className={panelClass}><h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Meta do mês</h2><GoalRing goal={insight?.goal ?? null} /></article>
          <article className={panelClass}><h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Fluxo financeiro</h2>{summary.financial
            ? <><BarList rows={[{ label: 'Vendas no mês', value: Number(summary.monthly?.sales ?? 0), tone: 'good' }, { label: 'A receber', value: Number(summary.financial.openReceivables) }, { label: 'A pagar', value: Number(summary.financial.openPayables), tone: 'warn' }, { label: 'Despesas pagas no mês', value: Number(summary.financial.monthlyExpenses), tone: 'warn' }]} /><p className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-600">Resultado estimado: <strong className="text-slate-900">{formatMoney(summary.financial.estimatedOperatingBalance)}</strong></p></>
            : <p className="text-sm text-slate-500">Visível apenas para perfis com acesso financeiro.</p>}</article>
          {insight ? <article className={panelClass}><h2 className="mb-4 text-sm font-bold uppercase tracking-wider text-slate-700">Mais vendidos · 30 dias</h2>{insight.topProducts.length === 0 ? <p className="text-sm text-slate-500">Sem vendas no período.</p> : <ol className="space-y-2 text-sm">{insight.topProducts.map((item, index) => <li key={item.name} className="flex items-center gap-3"><span className="grid h-6 w-6 place-items-center rounded-full bg-neutral-950 text-xs font-bold text-brand-300">{index + 1}</span><span className="min-w-0 flex-1 truncate">{item.name}</span><span className="text-xs text-slate-500">{item.quantity}×</span><span className="font-semibold">{formatMoney(item.revenue)}</span></li>)}</ol>}</article> : <article className={panelClass}><p className="text-sm text-slate-500">Carregando mais vendidos…</p></article>}
        </section>
        {insight && <section className="mt-4"><article className={panelClass}><div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-bold uppercase tracking-wider text-slate-700">Alertas inteligentes</h2><Link href="/intelligence" className="text-xs font-semibold text-brand-700 hover:text-brand-600">RM Inteligência ›</Link></div>{insight.alerts.length === 0 ? <p className="text-sm text-slate-500">Nenhum alerta no momento.</p> : <ul className="space-y-2 text-sm">{insight.alerts.slice(0, 4).map(alert => <li key={alert.key}><Link href={alert.href} className="flex gap-2 rounded-lg border border-slate-200 p-2 hover:border-brand-400"><span aria-hidden="true" className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${alert.severity === 'critical' ? 'bg-red-500' : alert.severity === 'warning' ? 'bg-amber-500' : 'bg-sky-500'}`} /><span><strong className="block">{alert.title}</strong><span className="text-xs text-slate-500">{alert.detail}</span></span></Link></li>)}</ul>}</article></section>}
        <section className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-label="Estrutura">
          <Metric label="Mesas ocupadas" value={summary.tables?.occupied ?? 0} detail={`${summary.tables?.active ?? 0} mesas ativas`} />
          <Metric label="Mesas disponíveis" value={summary.tables?.available ?? 0} />
          <Metric label="Produtos ativos" value={summary.products ?? 0} />
          <Metric label="Funcionários ativos" value={summary.employees ?? 0} />
        </section>
        <div className="mt-6">
        <GoldCard number={1} title="Módulos RM" subtitle="Inteligência, produção, delivery e lucro">
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {rmModules.map(item => { const allowed = hrefAllowed(item.href, enabledModules); return <li key={item.href}>
              <Link href={allowed ? item.href : '/support'} className={`flex h-full gap-3 rounded-xl border p-3 transition ${allowed ? 'border-brand-500/40 bg-slate-50 hover:border-brand-500 hover:bg-brand-50' : 'border-slate-200 bg-slate-100 opacity-70'}`}>
                <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-brand-400/60 bg-neutral-950 text-xl">{item.icon}</span>
                <span className="min-w-0"><span className="block text-sm font-bold text-slate-900">{item.title}</span><span className="mt-0.5 block text-xs text-slate-600">{allowed ? item.text : 'Módulo não incluído no plano — fale com o suporte para contratar.'}</span></span>
              </Link></li>; })}
          </ul>
        </GoldCard>
        </div>
      </>)}
    {result && !isMaster && <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Central de módulos</p><h2 className="mt-1 text-xl font-bold">Tudo conectado em um só lugar</h2></div><p className="text-xs text-slate-500">O acesso a cada módulo respeita as permissões da sua conta.</p></div>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        {flows.map(flow => <article key={flow.title} className="overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 border-b border-slate-200 pb-3 text-xs font-semibold uppercase tracking-wider text-slate-700">{flow.title}</h3>
          <div className="grid grid-cols-2 gap-2">{flow.hrefs.map(href => <Link key={href} href={href} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm transition hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700"><span aria-hidden="true" className="text-lg">{moduleIcon(href)}</span><span>{moduleLabel(href)}</span></Link>)}</div>
        </article>)}
      </div>
    </section>}
  </AppShell>;
}
