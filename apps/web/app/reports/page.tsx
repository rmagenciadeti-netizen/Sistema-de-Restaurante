'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, ReportOverview, ServiceFeeDistribution, WaiterReportRow, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';

const pad = (value: number) => String(value).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const startOf = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const endOf = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();
const methodLabel: Record<string, string> = { CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito', DEBIT_CARD: 'Cartão de débito', VOUCHER: 'Vale-refeição', OTHER: 'Outro' };
const th = 'p-3'; const td = 'p-3';

export default function ReportsPage() {
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(false);
  const [overview, setOverview] = useState<ReportOverview | null>(null); const [waiters, setWaiters] = useState<WaiterReportRow[]>([]); const [distribution, setDistribution] = useState<ServiceFeeDistribution | null>(null);

  async function load(start = from || today(), end = to || today()) {
    if (start > end) { setMessage('A data inicial não pode ser posterior à data final.'); return; }
    setLoading(true); setMessage('');
    try {
      const query = `from=${encodeURIComponent(startOf(start))}&to=${encodeURIComponent(endOf(end))}`;
      const [o, w, d] = await Promise.all([api<ReportOverview>(`/reports/overview?${query}`), api<Pick<ListResponse<WaiterReportRow>, 'items'>>(`/reports/waiters?${query}`), api<ServiceFeeDistribution>(`/reports/service-fee-distribution?${query}`)]);
      setOverview(o); setWaiters(w.items); setDistribution(d); setFrom(start); setTo(end);
    } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar relatórios')); } finally { setLoading(false); }
  }
  useAutoLoad(() => load());

  const cards = overview ? [['Pedidos', String(overview.orders)], ['Subtotal', formatMoney(overview.totals.subtotal)], ['Taxa de serviço', formatMoney(overview.totals.serviceFee)], ['Entrega', formatMoney(overview.totals.deliveryFee)], ['Descontos', formatMoney(overview.totals.discount)], ['Total vendido', formatMoney(overview.totals.total)], ['Despesas pagas', formatMoney(overview.paidExpenses)]] : [];

  return <AppShell title="Relatórios">
    {message && <Notice message={message} />}
    <section className={`${panelClass} mb-6`}><form onSubmit={event => { event.preventDefault(); void load(); }} className="flex flex-wrap items-end gap-4"><Field label="De" type="date" required value={from} onChange={e => setFrom(e.target.value)} /><Field label="Até" type="date" required min={from || undefined} value={to} onChange={e => setTo(e.target.value)} /><button className={buttonClass} disabled={loading}>{loading ? 'Carregando...' : 'Aplicar período'}</button></form></section>

    {overview && <>
      <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{cards.map(([label, value]) => <div key={label} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-xs uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold text-white">{value}</p></div>)}</section>
      <div className="mb-6 grid gap-6 xl:grid-cols-2">
        <section className={panelClass}><h2 className="mb-3 text-lg font-semibold">Recebimentos por forma</h2><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className={th}>Forma</th><th className={th}>Qtd.</th><th className={th}>Valor</th></tr></thead><tbody>{overview.paymentsByMethod.map(row => <tr key={row.method} className="border-t border-slate-800"><td className={td}>{methodLabel[row.method] ?? row.method}</td><td className={td}>{row._count}</td><td className={td}>{formatMoney(row._sum.amount)}</td></tr>)}</tbody></table>{overview.paymentsByMethod.length === 0 && <p className="text-sm text-slate-400">Sem recebimentos no período.</p>}</section>
        <section className={panelClass}><h2 className="mb-3 text-lg font-semibold">Mais vendidos</h2><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className={th}>Produto</th><th className={th}>Qtd.</th><th className={th}>Vendas</th></tr></thead><tbody>{overview.bestSellers.map(row => <tr key={row.productId} className="border-t border-slate-800"><td className={td}>{row.name}</td><td className={td}>{row.quantity ?? 0}</td><td className={td}>{formatMoney(row.sales)}</td></tr>)}</tbody></table>{overview.bestSellers.length === 0 && <p className="text-sm text-slate-400">Sem vendas no período.</p>}</section>
      </div>
    </>}

    <section className={`${panelClass} mb-6`}><h2 className="mb-3 text-lg font-semibold">Vendas por atendente (pedidos concluídos)</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className={th}>Atendente</th><th className={th}>Pedidos</th><th className={th}>Vendas</th><th className={th}>Taxa de serviço</th><th className={th}>Total</th></tr></thead><tbody>{waiters.map(row => <tr key={row.userId ?? 'none'} className="border-t border-slate-800"><td className={td}>{row.name}</td><td className={td}>{row.orders}</td><td className={td}>{formatMoney(row.sales)}</td><td className={td}>{formatMoney(row.serviceFee)}</td><td className={td}>{formatMoney(row.total)}</td></tr>)}</tbody></table></div>{waiters.length === 0 && <p className="text-sm text-slate-400">Sem pedidos concluídos no período.</p>}</section>

    <section className={panelClass}><h2 className="mb-1 text-lg font-semibold">Distribuição da taxa de serviço</h2><p className="mb-3 text-sm text-slate-400">A parte do atendente usa o percentual definido na unidade; o restante forma o fundo a ser distribuído pelas regras do restaurante.</p><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-400"><tr><th className={th}>Atendente</th><th className={th}>Taxa arrecadada</th><th className={th}>Parte do atendente</th><th className={th}>Fundo</th><th className={th}>Comissão</th></tr></thead><tbody>{distribution?.items.map(row => <tr key={row.userId ?? 'none'} className="border-t border-slate-800"><td className={td}>{row.name}</td><td className={td}>{formatMoney(row.serviceFeeCollected)}</td><td className={td}>{formatMoney(row.waiterAmount)}</td><td className={td}>{formatMoney(row.poolAmount)}</td><td className={td}>{formatMoney(row.commission)}</td></tr>)}</tbody>{distribution && distribution.items.length > 0 && <tfoot><tr className="border-t-2 border-slate-700 font-semibold"><td className={td}>Total</td><td className={td}>{formatMoney(distribution.totals.serviceFeeCollected)}</td><td className={td}>{formatMoney(distribution.totals.waiterAmount)}</td><td className={td}>{formatMoney(distribution.totals.poolAmount)}</td><td className={td}>{formatMoney(distribution.totals.commission)}</td></tr></tfoot>}</table></div>{distribution && distribution.items.length === 0 && <p className="text-sm text-slate-400">Sem taxa de serviço no período.</p>}</section>
  </AppShell>;
}
