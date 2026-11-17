'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { Field, Notice, secondaryButtonClass, Select } from '../app-shell';
import { DataTable, EmptyState, StatCard } from '../ui';
import { exportCsv, Section, type PlanRow } from './common';

type Overview = {
  clients: { total: number; active: number; trial: number; suspended: number; delinquent: number };
  subscriptions: { active: number; expired: number; suspended: number; pending: number; cancelled: number; created: number };
  revenue: { mrr: number; arr: number; issued: number; received: number; open: number; overdue: number; discounts: number };
  catalog: { plans: number; modules: number; activeCampaigns: number; activeCoupons: number; couponUses: number; campaignUses: number };
  byPlan: { id: string; name: string; subscriptions: number; mrr: number; received: number }[];
  byModule: { key: string; name: string; tenants: number; addonMrr: number }[];
  evolution: { month: string; received: number }[];
};
type Change = { id: string; createdAt: string; tenant: { name: string } | null; actor: { name: string } | null; metadata: { direction: string; from: { name: string | null; price: string | null }; to: { name: string | null; price: string | null }; reason: string | null } };

const directionLabel: Record<string, string> = { UPGRADE: 'Upgrade', DOWNGRADE: 'Downgrade', CHANGE: 'Troca' };
const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10); };

export function CommercialOverview() {
  const [data, setData] = useState<Overview | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [planId, setPlanId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    const params = new URLSearchParams({ from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString() });
    if (planId) params.set('planId', planId);
    try {
      const [overview, changeList, planList] = await Promise.all([api<Overview>(`/commercial/overview?${params}`), api<{ items: Change[] }>('/commercial/reports/changes'), api<{ items: PlanRow[] }>('/plans')]);
      setData(overview); setChanges(changeList.items); setPlans(planList.items);
    } catch (cause) { setError(errorMessage(cause, 'Falha ao carregar o painel comercial')); }
  }, [from, to, planId]);
  useEffect(() => { void load(); }, [load]);

  const peak = Math.max(1, ...(data?.evolution ?? []).map(point => point.received));
  const maxSubscriptions = Math.max(1, ...(data?.byPlan ?? []).map(plan => plan.subscriptions));
  return <>
    {error && <Notice message={error} />}
    <Section title="Filtros">
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} />
        <Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} />
        <Select label="Plano" value={planId} onChange={event => setPlanId(event.target.value)}><option value="">Todos</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</Select>
        <button type="button" className={`${secondaryButtonClass} self-end`} onClick={() => void load()}>Atualizar</button>
      </div>
    </Section>
    {!data && !error && <p className="text-sm text-slate-500">Carregando indicadores…</p>}
    {data && <>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard tone="dark" label="Receita recorrente (MRR)" value={formatMoney(data.revenue.mrr)} hint={`ARR ${formatMoney(data.revenue.arr)} · contratada, não recebida`} />
        <StatCard tone="dark" label="Recebido no período" value={formatMoney(data.revenue.received)} hint="Pagamentos confirmados" />
        <StatCard label="Cobranças emitidas" value={formatMoney(data.revenue.issued)} hint={`Descontos concedidos: ${formatMoney(data.revenue.discounts)}`} />
        <StatCard label="Em aberto / vencido" value={`${formatMoney(data.revenue.open)} / ${formatMoney(data.revenue.overdue)}`} hint={`${data.clients.delinquent} cliente(s) inadimplente(s)`} />
        <StatCard label="Clientes" value={data.clients.total} hint={`${data.clients.active} ativos · ${data.clients.trial} em teste · ${data.clients.suspended} suspensos/bloqueados`} />
        <StatCard label="Assinaturas ativas" value={data.subscriptions.active} hint={`${data.subscriptions.expired} vencidas · ${data.subscriptions.suspended} suspensas · ${data.subscriptions.pending} pendentes`} />
        <StatCard label="Novas × cancelamentos" value={`${data.subscriptions.created} / ${data.subscriptions.cancelled}`} hint="No período filtrado" />
        <StatCard label="Catálogo" value={`${data.catalog.plans} planos · ${data.catalog.modules} módulos`} hint={`${data.catalog.activeCampaigns} promoções e ${data.catalog.activeCoupons} cupons ativos · ${data.catalog.couponUses + data.catalog.campaignUses} usos`} />
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Evolução do faturamento recebido (6 meses)">
          <div className="flex h-44 items-end gap-3" role="img" aria-label="Evolução do faturamento recebido">
            {data.evolution.map(point => <div key={point.month} className="flex flex-1 flex-col items-center justify-end gap-1">
              <span className="text-[10px] font-semibold text-slate-600">{point.received > 0 ? formatMoney(point.received) : '—'}</span>
              <div className="w-full rounded-t-lg bg-gradient-to-t from-brand-600 to-brand-300" style={{ height: `${Math.max(4, (point.received / peak) * 100)}%` }} />
              <span className="text-[10px] uppercase tracking-wide text-slate-500">{point.month.slice(5)}/{point.month.slice(2, 4)}</span>
            </div>)}
          </div>
        </Section>
        <Section title="Planos" actions={<button type="button" className={secondaryButtonClass} onClick={() => exportCsv('planos.csv', ['Plano', 'Assinaturas', 'MRR', 'Recebido no período'], data.byPlan.map(plan => [plan.name, plan.subscriptions, plan.mrr, plan.received]))}>Exportar CSV</button>}>
          {data.byPlan.length === 0 ? <EmptyState title="Nenhum plano cadastrado" /> : <div className="space-y-3">
            {data.byPlan.map(plan => <div key={plan.id}>
              <div className="flex justify-between text-sm"><strong>{plan.name}</strong><span className="text-slate-500">{plan.subscriptions} assinatura(s) · MRR {formatMoney(plan.mrr)} · recebido {formatMoney(plan.received)}</span></div>
              <div className="mt-1 h-2 rounded-full bg-slate-100"><div className="h-2 rounded-full bg-brand-500" style={{ width: `${(plan.subscriptions / maxSubscriptions) * 100}%` }} /></div>
            </div>)}
          </div>}
        </Section>
      </div>
      <Section title="Módulos mais contratados" actions={<button type="button" className={secondaryButtonClass} onClick={() => exportCsv('modulos.csv', ['Módulo', 'Clientes', 'MRR avulso'], data.byModule.map(item => [item.name, item.tenants, item.addonMrr]))}>Exportar CSV</button>}>
        <DataTable columns={[{ label: 'Módulo' }, { label: 'Clientes' }, { label: 'Receita avulsa mensal' }]}>
          {data.byModule.map(item => <tr key={item.key}><td>{item.name}</td><td>{item.tenants}</td><td>{formatMoney(item.addonMrr)}</td></tr>)}
        </DataTable>
      </Section>
      <Section title="Upgrades e downgrades">
        {changes.length === 0 ? <EmptyState icon="🔁" title="Nenhuma troca de plano registrada" hint="As trocas feitas em Clientes e assinaturas aparecem aqui com valores anteriores e novos." /> : <DataTable columns={[{ label: 'Data' }, { label: 'Cliente' }, { label: 'Tipo' }, { label: 'De' }, { label: 'Para' }, { label: 'Responsável' }]}>
          {changes.map(change => <tr key={change.id}><td>{formatDateTime(change.createdAt)}</td><td>{change.tenant?.name ?? '—'}</td><td>{directionLabel[change.metadata.direction] ?? change.metadata.direction}</td><td>{change.metadata.from.name ?? 'Sem plano'} {change.metadata.from.price && `(${formatMoney(change.metadata.from.price)})`}</td><td>{change.metadata.to.name ?? 'Sem plano'} {change.metadata.to.price && `(${formatMoney(change.metadata.to.price)})`}</td><td>{change.actor?.name ?? '—'}</td></tr>)}
        </DataTable>}
      </Section>
    </>}
  </>;
}
