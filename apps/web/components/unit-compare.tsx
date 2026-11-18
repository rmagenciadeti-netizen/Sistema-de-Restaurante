'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatMoney, storedUser } from '../lib/api';
import { Field, panelClass, secondaryButtonClass } from './app-shell';
import { DonutChart } from './charts';
import { DataTable, EmptyState, StatCard } from './ui';

type Compare = { items: { id: string; name: string; status: string; revenue: number; orders: number; averageTicket: number; cancelledOrders: number; expenses: number; result: number; employees: number; tables: number }[]; totals: { revenue: number; orders: number; expenses: number; averageTicket: number; result: number } };
const FINANCE = ['ADMIN', 'MANAGER', 'FINANCE'];

export function UnitCompare() {
  const [from, setFrom] = useState(() => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState('');
  const [allowed, setAllowed] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try { setData(await api<Compare>(`/units/compare?${new URLSearchParams({ from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString() })}`)); }
    catch (cause) { setError(errorMessage(cause, 'Falha ao comparar as unidades')); }
  }, [from, to]);
  useEffect(() => { const permitted = FINANCE.includes(storedUser().role ?? ''); setAllowed(permitted); if (permitted) void load(); }, [load]);
  if (!allowed) return null;

  return <section className={`${panelClass} mt-6`}>
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Rede</p><h2 className="text-lg font-semibold">Comparativo e consolidado das unidades</h2></div>
      <div className="flex flex-wrap items-end gap-2"><Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} /><Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} /><button type="button" className={secondaryButtonClass} onClick={() => void load()}>Atualizar</button></div>
    </div>
    {error && <p role="status" className="mb-3 text-sm text-red-700">{error}</p>}
    {data && (data.items.length === 0 ? <EmptyState title="Nenhuma unidade cadastrada" /> : <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard tone="dark" icon="💰" label="Faturamento consolidado" value={formatMoney(data.totals.revenue)} hint={`${data.totals.orders} pedido(s) concluído(s)`} />
        <StatCard icon="🎟️" label="Ticket médio da rede" value={formatMoney(data.totals.averageTicket)} />
        <StatCard icon="💳" label="Despesas baixadas" value={formatMoney(data.totals.expenses)} />
        <StatCard tone="dark" icon="🏦" label="Resultado consolidado" value={formatMoney(data.totals.result)} hint="Vendas concluídas menos despesas baixadas" />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <DataTable columns={[{ label: 'Unidade' }, { label: 'Faturamento' }, { label: 'Pedidos' }, { label: 'Ticket médio' }, { label: 'Cancelados' }, { label: 'Despesas' }, { label: 'Resultado' }, { label: 'Equipe / mesas' }]}>
          {data.items.map(item => <tr key={item.id}><td className="font-semibold">{item.name}</td><td>{formatMoney(item.revenue)}</td><td>{item.orders}</td><td>{formatMoney(item.averageTicket)}</td><td>{item.cancelledOrders}</td><td>{formatMoney(item.expenses)}</td><td className={item.result < 0 ? 'font-semibold text-red-700' : 'font-semibold text-emerald-700'}>{formatMoney(item.result)}</td><td>{item.employees} / {item.tables}</td></tr>)}
        </DataTable>
        <div><h3 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-700">Participação no faturamento</h3>{data.totals.revenue > 0 ? <DonutChart centerLabel="Faturamento por unidade" format={formatMoney} slices={data.items.filter(item => item.revenue > 0).map(item => ({ label: item.name, value: item.revenue }))} /> : <p className="text-sm text-slate-500">Sem vendas concluídas no período.</p>}</div>
      </div>
    </>)}
  </section>;
}
