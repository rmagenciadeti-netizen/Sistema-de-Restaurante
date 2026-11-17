'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, errorMessage, formatMoney, storedUser } from '../../lib/api';
import Link from 'next/link';
import { AppShell, flows, moduleIcon, moduleLabel, Notice, panelClass } from '../../components/app-shell';

type Summary = {
  totalCompanies?: number; activeCompanies?: number; trialCompanies?: number; suspendedCompanies?: number;
  users?: number; orders?: number; products?: number; employees?: number; openOrders?: number; note?: string;
  daily?: { orders: number; completedOrders: number; sales: string | number; averageTicket: string | number };
  monthly?: { orders: number; completedOrders: number; sales: string | number };
  tables?: { active: number; occupied: number; available: number };
  financial?: { openReceivables: string | number; openPayables: string | number; monthlyExpenses: string | number; estimatedOperatingBalance: string | number } | null;
  salesTrend?: { day: string; total: string | number }[];
};

function Metric({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return <article className={`${panelClass} relative overflow-hidden`}>
    <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-brand-400 via-brand-500 to-brand-300" />
    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{label}</p>
    <p className="mt-4 text-2xl font-bold tracking-tight text-slate-900">{value}</p>
    {detail && <p className="mt-2 text-xs text-slate-500">{detail}</p>}
  </article>;
}

export default function DashboardPage() {
  const [result, setResult] = useState<{ summary: Summary; isMaster: boolean } | null>(null);
  const [error, setError] = useState('');
  const router = useRouter();

  useEffect(() => {
    let active = true;
    const user = storedUser();
    const isMaster = user.role === 'MASTER_ADMIN';
    api<Summary>(isMaster ? '/dashboard/master' : '/dashboard/restaurant')
      .then(summary => { if (active) setResult({ summary, isMaster }); })
      .catch(cause => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) router.replace('/login');
        else setError(errorMessage(cause, 'Erro ao carregar painel'));
      });
    return () => { active = false; };
  }, [router]);

  const summary = result?.summary;
  const isMaster = result?.isMaster ?? false;
  const maxTrend = Math.max(0, ...(summary?.salesTrend ?? []).map(point => Number(point.total)));
  const formatDay = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });

  return <AppShell title={isMaster ? 'Painel Master' : 'Visão geral'}>
    {error && <Notice message={error} />}
    {!summary && !error && <p className="text-sm text-slate-500">Carregando indicadores…</p>}
    {summary && (isMaster
      ? <>
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Metric label="Empresas cadastradas" value={summary.totalCompanies ?? 0} />
          <Metric label="Empresas ativas" value={summary.activeCompanies ?? 0} />
          <Metric label="Em período de teste" value={summary.trialCompanies ?? 0} />
          <Metric label="Suspensas" value={summary.suspendedCompanies ?? 0} />
          <Metric label="Usuários" value={summary.users ?? 0} />
          <Metric label="Pedidos" value={summary.orders ?? 0} />
        </section>
        {summary.note && <p className="mt-5 text-sm text-slate-500">{summary.note}</p>}
      </>
      : <>
        <section className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">RM Restaurant · Gestão gastronômica</p><h2 className="mt-2 text-2xl font-bold">Seu restaurante em movimento</h2><p className="mt-1 text-sm text-slate-600">Acompanhe o atendimento, a cozinha e os resultados em um só lugar.</p></div>
          <div className="flex flex-wrap gap-3"><Link href="/orders" className="rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-neutral-950 hover:bg-brand-400">Abrir pedidos</Link><Link href="/tables" className="rounded-lg border border-brand-400 px-4 py-2.5 text-sm font-semibold text-brand-700 hover:bg-brand-50">Ver mesas</Link></div>
        </section>
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Vendas concluídas hoje" value={formatMoney(summary.daily?.sales)} detail={`${summary.daily?.completedOrders ?? 0} pedido(s) concluído(s)`} />
          <Metric label="Vendas concluídas no mês" value={formatMoney(summary.monthly?.sales)} detail={`${summary.monthly?.completedOrders ?? 0} pedido(s) concluído(s)`} />
          <Metric label="Pedidos de hoje" value={summary.daily?.orders ?? 0} detail={`${summary.openOrders ?? 0} em andamento agora`} />
          <Metric label="Ticket médio hoje" value={formatMoney(summary.daily?.averageTicket)} detail="Pedidos concluídos" />
          <Metric label="Mesas ocupadas" value={summary.tables?.occupied ?? 0} detail={`${summary.tables?.active ?? 0} mesas ativas`} />
          <Metric label="Mesas disponíveis" value={summary.tables?.available ?? 0} />
          <Metric label="Produtos ativos" value={summary.products ?? 0} />
          <Metric label="Funcionários ativos" value={summary.employees ?? 0} />
        </section>
        {summary.financial && <section className="mt-6">
          <div className="mb-3 flex items-end justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Acesso financeiro</p><h2 className="mt-1 text-lg font-semibold">Resumo do período</h2></div><p className="text-xs text-slate-500">Contas registradas e vendas concluídas</p></div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="Contas a receber" value={formatMoney(summary.financial.openReceivables)} />
            <Metric label="Contas a pagar" value={formatMoney(summary.financial.openPayables)} />
            <Metric label="Despesas baixadas no mês" value={formatMoney(summary.financial.monthlyExpenses)} />
            <Metric label="Resultado estimado no mês" value={formatMoney(summary.financial.estimatedOperatingBalance)} detail="Vendas concluídas menos despesas baixadas" />
          </div>
        </section>}
        <section className={`${panelClass} mt-6`}>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Operação</p><h2 className="mt-1 text-lg font-semibold">Vendas concluídas · últimos 7 dias</h2></div><p className="text-xs text-slate-500">Valores reais de pedidos concluídos</p></div>
          <div className="grid min-h-48 grid-cols-7 items-end gap-3" role="img" aria-label="Gráfico de vendas concluídas nos últimos sete dias">
            {(summary.salesTrend ?? []).map(point => {
              const value = Number(point.total);
              const height = maxTrend > 0 ? Math.max(4, value / maxTrend * 100) : 0;
              return <div key={point.day} className="flex h-48 min-w-0 flex-col items-center justify-end gap-2">
                <span className="max-w-full truncate text-center text-[10px] text-slate-500">{formatMoney(value)}</span>
                <div className="flex h-32 w-full items-end rounded-t bg-slate-100"><div className="w-full rounded-t bg-brand-500 transition-[height]" style={{ height: `${height}%` }} /></div>
                <span className="text-center text-[10px] capitalize text-slate-500">{formatDay(point.day)}</span>
              </div>;
            })}
          </div>
          {summary.salesTrend?.length === 0 && <p className="text-sm text-slate-500">Ainda não há vendas concluídas nesse período.</p>}
        </section>
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
