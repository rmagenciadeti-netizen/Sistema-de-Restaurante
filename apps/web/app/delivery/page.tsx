'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, DeliveryJob, DeliveryZone, errorMessage, formatDateTime, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import type { Courier } from '../../lib/types-registry';
import { DataTable, PageHeader, StatCard } from '../../components/ui';

type Summary = { openNow: number; total: number; delivered: number; cancelled: number; averageMinutes: number | null; feesCollected: number; deliveredRevenue: number; byCourier: { id: string; name: string; active: boolean; assigned: number; delivered: number; averageMinutes: number | null; paymentPerDelivery: number | null; amountDue: number | null }[] };

const statusLabel: Record<string, string> = { PENDING: 'Pendente', ASSIGNED: 'Entregador definido', PICKED_UP: 'Saiu para entrega', DELIVERED: 'Entregue', CANCELLED: 'Cancelada' };
const transitions: Record<string, string[]> = { PENDING: ['ASSIGNED', 'PICKED_UP', 'CANCELLED'], ASSIGNED: ['PICKED_UP', 'CANCELLED'], PICKED_UP: ['DELIVERED', 'CANCELLED'], DELIVERED: [], CANCELLED: [] };
const actionLabel: Record<string, string> = { ASSIGNED: 'Atribuir', PICKED_UP: 'Saiu para entrega', DELIVERED: 'Entregue', CANCELLED: 'Cancelar' };
const emptyZone = { name: '', fee: '', minOrder: '', minutes: '' };

export default function DeliveryPage() {
  const [jobs, setJobs] = useState<DeliveryJob[]>([]); const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [zoneForm, setZoneForm] = useState(emptyZone); const [fees, setFees] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [couriers, setCouriers] = useState<Courier[]>([]); const [summary, setSummary] = useState<Summary | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [j, z, c] = await Promise.all([api<ListResponse<DeliveryJob>>('/delivery'), api<ListResponse<DeliveryZone>>('/delivery/zones'), api<ListResponse<Courier>>('/couriers?active=true').catch(() => ({ items: [] as Courier[] }))]);
      setJobs(j.items); setCouriers(c.items); setZones(z.items);
      api<Summary>('/delivery/summary').then(setSummary).catch(() => undefined);
    } catch (e) { fail(e, 'Erro ao carregar entregas'); }
  }
  useAutoLoad(load);

  async function assignCourier(job: DeliveryJob, courierId: string) {
    try { await api(`/delivery/${job.id}/courier`, { method: 'PATCH', body: JSON.stringify({ courierId: courierId || null }) }); ok('Entregador atualizado.'); await load(); } catch (e) { fail(e, 'Erro ao definir entregador'); }
  }
  async function setStatus(job: DeliveryJob, status: string) {
    try { await api(`/delivery/${job.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar entrega'); }
  }
  async function createZone(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try { await api('/delivery/zones', { method: 'POST', body: JSON.stringify({ name: zoneForm.name, fee: Number(zoneForm.fee), minOrder: zoneForm.minOrder ? Number(zoneForm.minOrder) : undefined, estimatedMinutes: zoneForm.minutes ? Number(zoneForm.minutes) : undefined }) }); ok('Zona de entrega criada.'); setZoneForm(emptyZone); await load(); } catch (e) { fail(e, 'Erro ao criar zona'); }
  }
  async function patchZone(zone: DeliveryZone, body: { fee?: number; active?: boolean }) {
    try { await api(`/delivery/zones/${zone.id}`, { method: 'PATCH', body: JSON.stringify(body) }); setFees(current => { const next = { ...current }; delete next[zone.id]; return next; }); ok(`Zona ${zone.name} atualizada.`); await load(); } catch (e) { fail(e, 'Erro ao atualizar zona'); }
  }

  return <AppShell title="RM Delivery — Central de Delivery">
    <PageHeader title="RM Delivery — Central de Delivery" subtitle="Pedidos de entrega, entregadores, regiões, taxas e tempo estimado em um só lugar." actions={<Link href="/couriers" className={secondaryButtonClass}>Entregadores</Link>} />
    {summary && <>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard tone="dark" icon="🛵" label="Em andamento" value={summary.openNow} hint="Pendentes, atribuídas ou em rota" />
        <StatCard icon="✅" label="Entregues hoje" value={summary.delivered} hint={`${summary.total} entrega(s) hoje · ${summary.cancelled} cancelada(s)`} />
        <StatCard icon="⏱️" label="Tempo médio de entrega" value={summary.averageMinutes === null ? '—' : `${summary.averageMinutes} min`} hint="Da saída até a entrega" />
        <StatCard icon="💵" label="Taxas cobradas hoje" value={formatMoney(summary.feesCollected)} />
        <StatCard tone="dark" icon="🧾" label="Vendido em entregas hoje" value={formatMoney(summary.deliveredRevenue)} />
      </div>
      {summary.byCourier.length > 0 && <section className="mb-6"><h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-brand-300">Desempenho dos entregadores (hoje)</h2>
        <DataTable columns={[{ label: 'Entregador' }, { label: 'Atribuídas' }, { label: 'Entregues' }, { label: 'Tempo médio' }, { label: 'Pagamento/entrega' }, { label: 'A pagar' }]}>
          {summary.byCourier.map(row => <tr key={row.id}><td className="font-semibold">{row.name}{!row.active && ' (inativo)'}</td><td>{row.assigned}</td><td>{row.delivered}</td><td>{row.averageMinutes === null ? '—' : `${row.averageMinutes} min`}</td><td>{row.paymentPerDelivery === null ? '—' : formatMoney(row.paymentPerDelivery)}</td><td>{row.amountDue === null ? '—' : formatMoney(row.amountDue)}</td></tr>)}
        </DataTable></section>}
    </>}
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Acompanhamento</p><h2 className="mt-1 text-lg font-semibold">Quadro de entregas ({jobs.length})</h2></div><Link href="/monitor" className={secondaryButtonClass}>Ir para pedidos</Link></div>
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-5">{Object.keys(statusLabel).map(status => {
        const column = jobs.filter(job => job.status === status);
        return <section key={status} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50"><h3 className="border-b border-slate-200 bg-brand-50 px-3 py-3 text-sm font-semibold text-brand-700">{statusLabel[status]} ({column.length})</h3><div className="grid content-start gap-3 p-3">{column.map(job => <article key={job.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><h4 className="font-semibold">{job.order?.code ?? 'Pedido'}</h4><p className="mt-1 text-sm text-slate-600">{job.order?.customerName || 'Sem cliente'} · {job.address || 'Endereço não informado'}</p><p className="mt-2 text-xs text-slate-500">Entregador: {job.courierName || 'não definido'}{job.courierPhone ? ` (${job.courierPhone})` : ''}{job.provider ? ` · ${job.provider}` : ''} · {formatDateTime(job.createdAt)}</p>{couriers.length > 0 && transitions[job.status]?.length > 0 && <label className="mt-2 block text-xs text-slate-500">Entregador<select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900" value={(job as DeliveryJob & { courierId?: string | null }).courierId ?? ''} onChange={e => void assignCourier(job, e.target.value)}><option value="">{job.courierName ? `${job.courierName} (manual)` : 'Não definido'}</option>{couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}</option>)}</select></label>}{job.order && <p className="mt-2 text-sm text-slate-600">{job.order.items.map(line => `${line.quantity}× ${line.product.name}`).join(', ')} · {formatMoney(job.order.total)}</p>}<div className="mt-3 flex flex-wrap gap-2">{job.order && job.order.status !== 'CANCELLED' && <Link href={`/cash?orderId=${encodeURIComponent(job.orderId)}#pagamento`} className={secondaryButtonClass}>Pagamento</Link>}{transitions[job.status]?.map(next => <button key={next} className={next === 'CANCELLED' ? secondaryButtonClass : buttonClass} onClick={() => void setStatus(job, next)}>{actionLabel[next]}</button>)}</div></article>)}{column.length === 0 && <p className="py-3 text-center text-xs text-slate-500">Nenhuma entrega.</p>}</div></section>;
      })}</div>
    </section>

    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Zonas de entrega ({zones.length})</h2>
      <form onSubmit={createZone} className="mb-4 grid gap-4 md:grid-cols-5"><Field label="Nome" required minLength={2} maxLength={100} value={zoneForm.name} onChange={e => setZoneForm({ ...zoneForm, name: e.target.value })} /><Field label="Taxa (R$)" type="number" required min="0" step="0.01" value={zoneForm.fee} onChange={e => setZoneForm({ ...zoneForm, fee: e.target.value })} /><Field label="Tempo estimado (min)" type="number" min="1" max="600" value={zoneForm.minutes} onChange={e => setZoneForm({ ...zoneForm, minutes: e.target.value })} /><Field label="Pedido mínimo (R$)" type="number" min="0" step="0.01" value={zoneForm.minOrder} onChange={e => setZoneForm({ ...zoneForm, minOrder: e.target.value })} /><div className="flex items-end"><button className={buttonClass}>Adicionar zona</button></div></form>
      <div className="grid gap-3 md:grid-cols-2">{zones.map(zone => <article key={zone.id} className="rounded-lg border border-slate-800 p-4"><h3 className="font-semibold">{zone.name}</h3><p className="mt-1 text-sm text-slate-400">Taxa {formatMoney(zone.fee)}{zone.minOrder ? ` · mínimo ${formatMoney(zone.minOrder)}` : ''}{zone.estimatedMinutes ? ` · ~${zone.estimatedMinutes} min` : ''}</p><div className="mt-3 flex flex-wrap items-center gap-2"><input aria-label={`Nova taxa da zona ${zone.name}`} type="number" min="0" step="0.01" placeholder="Nova taxa" className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white" value={fees[zone.id] ?? ''} onChange={e => setFees({ ...fees, [zone.id]: e.target.value })} /><button className={secondaryButtonClass} disabled={!fees[zone.id]} onClick={() => void patchZone(zone, { fee: Number(fees[zone.id]) })}>Salvar taxa</button><button className={secondaryButtonClass} onClick={() => void patchZone(zone, { active: false })}>Desativar</button></div></article>)}</div>{zones.length === 0 && <p className="text-slate-400">Nenhuma zona ativa cadastrada.</p>}
    </section>
  </AppShell>;
}
