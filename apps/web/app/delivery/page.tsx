'use client';

import { useState } from 'react';
import { api, DeliveryJob, DeliveryZone, errorMessage, formatDateTime, formatMoney, ListResponse, Order } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const statusLabel: Record<string, string> = { PENDING: 'Pendente', ASSIGNED: 'Entregador definido', PICKED_UP: 'Saiu para entrega', DELIVERED: 'Entregue', CANCELLED: 'Cancelada' };
const transitions: Record<string, string[]> = { PENDING: ['ASSIGNED', 'PICKED_UP', 'CANCELLED'], ASSIGNED: ['PICKED_UP', 'CANCELLED'], PICKED_UP: ['DELIVERED', 'CANCELLED'], DELIVERED: [], CANCELLED: [] };
const actionLabel: Record<string, string> = { ASSIGNED: 'Atribuir', PICKED_UP: 'Saiu para entrega', DELIVERED: 'Entregue', CANCELLED: 'Cancelar' };
const emptyJob = { orderId: '', courierName: '', courierPhone: '', address: '', provider: '' };
const emptyZone = { name: '', fee: '', minOrder: '' };

export default function DeliveryPage() {
  const [jobs, setJobs] = useState<DeliveryJob[]>([]); const [orders, setOrders] = useState<Order[]>([]); const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [jobForm, setJobForm] = useState(emptyJob); const [zoneForm, setZoneForm] = useState(emptyZone); const [fees, setFees] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [j, o, z] = await Promise.all([api<ListResponse<DeliveryJob>>('/delivery'), api<ListResponse<Order>>('/orders?pageSize=100'), api<ListResponse<DeliveryZone>>('/delivery/zones')]);
      setJobs(j.items); setOrders(o.items.filter(order => order.channel === 'DELIVERY' && order.status !== 'CANCELLED')); setZones(z.items);
    } catch (e) { fail(e, 'Erro ao carregar entregas'); }
  }
  useAutoLoad(load);

  const availableOrders = orders.filter(order => !jobs.some(job => job.orderId === order.id));
  async function createJob(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const body = { orderId: jobForm.orderId, courierName: jobForm.courierName || undefined, courierPhone: jobForm.courierPhone || undefined, address: jobForm.address || undefined, provider: jobForm.provider || undefined };
    try { await api('/delivery', { method: 'POST', body: JSON.stringify(body) }); ok('Entrega criada.'); setJobForm(emptyJob); await load(); } catch (e) { fail(e, 'Erro ao criar entrega'); }
  }
  async function setStatus(job: DeliveryJob, status: string) {
    try { await api(`/delivery/${job.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar entrega'); }
  }
  async function createZone(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try { await api('/delivery/zones', { method: 'POST', body: JSON.stringify({ name: zoneForm.name, fee: Number(zoneForm.fee), minOrder: zoneForm.minOrder ? Number(zoneForm.minOrder) : undefined }) }); ok('Zona de entrega criada.'); setZoneForm(emptyZone); await load(); } catch (e) { fail(e, 'Erro ao criar zona'); }
  }
  async function patchZone(zone: DeliveryZone, body: { fee?: number; active?: boolean }) {
    try { await api(`/delivery/zones/${zone.id}`, { method: 'PATCH', body: JSON.stringify(body) }); setFees(current => { const next = { ...current }; delete next[zone.id]; return next; }); ok(`Zona ${zone.name} atualizada.`); await load(); } catch (e) { fail(e, 'Erro ao atualizar zona'); }
  }

  return <AppShell title="Entregas">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Nova entrega</h2>
      <form onSubmit={createJob} className="grid gap-4 md:grid-cols-3">
        <Select label="Pedido de delivery" required value={jobForm.orderId} onChange={e => setJobForm({ ...jobForm, orderId: e.target.value })}><option value="">Selecione</option>{availableOrders.map(order => <option key={order.id} value={order.id}>{order.code} — {order.customerName || 'Sem cliente'} — {formatMoney(order.total)}</option>)}</Select>
        <Field label="Entregador" maxLength={160} value={jobForm.courierName} onChange={e => setJobForm({ ...jobForm, courierName: e.target.value })} />
        <Field label="Telefone do entregador" maxLength={30} value={jobForm.courierPhone} onChange={e => setJobForm({ ...jobForm, courierPhone: e.target.value })} />
        <Field label="Endereço de entrega" maxLength={500} value={jobForm.address} onChange={e => setJobForm({ ...jobForm, address: e.target.value })} />
        <Field label="Parceiro/plataforma" maxLength={80} value={jobForm.provider} onChange={e => setJobForm({ ...jobForm, provider: e.target.value })} />
        <div className="flex items-end"><button className={buttonClass} disabled={availableOrders.length === 0}>Criar entrega</button></div>
      </form>{availableOrders.length === 0 && <p className="mt-3 text-sm text-slate-400">Nenhum pedido de delivery sem entrega associada.</p>}</section>

    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Entregas ({jobs.length})</h2><div className="grid gap-3">{jobs.map(job => <article key={job.id} className="rounded-lg border border-slate-800 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{job.order?.code ?? 'Pedido'} <span className="text-xs font-normal text-blue-300">{statusLabel[job.status]}</span></h3><p className="mt-1 text-sm text-slate-400">{job.order?.customerName || 'Sem cliente'} · {job.address || 'Endereço não informado'}</p><p className="mt-1 text-sm text-slate-400">Entregador: {job.courierName || 'não definido'}{job.courierPhone ? ` (${job.courierPhone})` : ''}{job.provider ? ` · ${job.provider}` : ''} · {formatDateTime(job.createdAt)}</p>{job.order && <p className="mt-1 text-sm text-slate-300">{job.order.items.map(line => `${line.quantity}× ${line.product.name}`).join(', ')} · {formatMoney(job.order.total)}</p>}</div><div className="flex flex-wrap gap-2">{transitions[job.status]?.map(status => <button key={status} className={status === 'CANCELLED' ? secondaryButtonClass : buttonClass} onClick={() => void setStatus(job, status)}>{actionLabel[status]}</button>)}</div></div></article>)}</div>{jobs.length === 0 && <p className="text-slate-400">Nenhuma entrega registrada.</p>}</section>

    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Zonas de entrega ({zones.length})</h2>
      <form onSubmit={createZone} className="mb-4 grid gap-4 md:grid-cols-4"><Field label="Nome" required minLength={2} maxLength={100} value={zoneForm.name} onChange={e => setZoneForm({ ...zoneForm, name: e.target.value })} /><Field label="Taxa (R$)" type="number" required min="0" step="0.01" value={zoneForm.fee} onChange={e => setZoneForm({ ...zoneForm, fee: e.target.value })} /><Field label="Pedido mínimo (R$)" type="number" min="0" step="0.01" value={zoneForm.minOrder} onChange={e => setZoneForm({ ...zoneForm, minOrder: e.target.value })} /><div className="flex items-end"><button className={buttonClass}>Adicionar zona</button></div></form>
      <div className="grid gap-3 md:grid-cols-2">{zones.map(zone => <article key={zone.id} className="rounded-lg border border-slate-800 p-4"><h3 className="font-semibold">{zone.name}</h3><p className="mt-1 text-sm text-slate-400">Taxa {formatMoney(zone.fee)}{zone.minOrder ? ` · mínimo ${formatMoney(zone.minOrder)}` : ''}</p><div className="mt-3 flex flex-wrap items-center gap-2"><input aria-label={`Nova taxa da zona ${zone.name}`} type="number" min="0" step="0.01" placeholder="Nova taxa" className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white" value={fees[zone.id] ?? ''} onChange={e => setFees({ ...fees, [zone.id]: e.target.value })} /><button className={secondaryButtonClass} disabled={!fees[zone.id]} onClick={() => void patchZone(zone, { fee: Number(fees[zone.id]) })}>Salvar taxa</button><button className={secondaryButtonClass} onClick={() => void patchZone(zone, { active: false })}>Desativar</button></div></article>)}</div>{zones.length === 0 && <p className="text-slate-400">Nenhuma zona ativa cadastrada.</p>}
    </section>
  </AppShell>;
}
