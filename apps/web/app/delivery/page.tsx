'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { api, DeliveryJob, DeliveryZone, errorMessage, formatDateTime, formatMoney, ListResponse, Order } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import type { Courier } from '../../lib/types-registry';

const statusLabel: Record<string, string> = { PENDING: 'Pendente', ASSIGNED: 'Entregador definido', PICKED_UP: 'Saiu para entrega', DELIVERED: 'Entregue', CANCELLED: 'Cancelada' };
const transitions: Record<string, string[]> = { PENDING: ['ASSIGNED', 'PICKED_UP', 'CANCELLED'], ASSIGNED: ['PICKED_UP', 'CANCELLED'], PICKED_UP: ['DELIVERED', 'CANCELLED'], DELIVERED: [], CANCELLED: [] };
const actionLabel: Record<string, string> = { ASSIGNED: 'Atribuir', PICKED_UP: 'Saiu para entrega', DELIVERED: 'Entregue', CANCELLED: 'Cancelar' };
const emptyJob = { orderId: '', courierId: '', courierName: '', courierPhone: '', address: '', provider: '' };
const MANUAL_COURIER = 'manual';
const emptyZone = { name: '', fee: '', minOrder: '' };

export default function DeliveryPage() {
  const [jobs, setJobs] = useState<DeliveryJob[]>([]); const [orders, setOrders] = useState<Order[]>([]); const [zones, setZones] = useState<DeliveryZone[]>([]);
  const [jobForm, setJobForm] = useState(emptyJob); const [zoneForm, setZoneForm] = useState(emptyZone); const [fees, setFees] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const requestedOrderHandled = useRef(false);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [j, o, z, c] = await Promise.all([api<ListResponse<DeliveryJob>>('/delivery'), api<ListResponse<Order>>('/orders?pageSize=100'), api<ListResponse<DeliveryZone>>('/delivery/zones'), api<ListResponse<Courier>>('/couriers?active=true').catch(() => ({ items: [] as Courier[] }))]);
      setJobs(j.items); setCouriers(c.items); setOrders(o.items.filter(order => order.channel === 'DELIVERY' && order.status !== 'CANCELLED')); setZones(z.items);
      if (!requestedOrderHandled.current) {
        requestedOrderHandled.current = true;
        const requestedOrder = new URLSearchParams(window.location.search).get('orderId');
        if (requestedOrder) {
          const order = o.items.find(item => item.id === requestedOrder && item.channel === 'DELIVERY' && item.status !== 'CANCELLED');
          if (order && !j.items.some(job => job.orderId === order.id)) setJobForm(current => ({ ...current, orderId: order.id }));
          else setNotice({ text: 'Pedido indisponível nesta lista ou já possui entrega. Confira o quadro de entregas.', kind: 'error' });
        }
      }
    } catch (e) { fail(e, 'Erro ao carregar entregas'); }
  }
  useAutoLoad(load);

  const availableOrders = orders.filter(order => !jobs.some(job => job.orderId === order.id));
  async function createJob(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const registered = jobForm.courierId && jobForm.courierId !== MANUAL_COURIER ? jobForm.courierId : undefined;
    const body = { orderId: jobForm.orderId, courierId: registered, courierName: registered ? undefined : jobForm.courierName || undefined, courierPhone: registered ? undefined : jobForm.courierPhone || undefined, address: jobForm.address || undefined, provider: jobForm.provider || undefined };
    try { await api('/delivery', { method: 'POST', body: JSON.stringify(body) }); ok('Entrega criada.'); setJobForm(emptyJob); await load(); } catch (e) { fail(e, 'Erro ao criar entrega'); }
  }
  async function assignCourier(job: DeliveryJob, courierId: string) {
    try { await api(`/delivery/${job.id}/courier`, { method: 'PATCH', body: JSON.stringify({ courierId: courierId || null }) }); ok('Entregador atualizado.'); await load(); } catch (e) { fail(e, 'Erro ao definir entregador'); }
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
    <section id="nova-entrega" className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Nova entrega</h2>
      <form onSubmit={createJob} className="grid gap-4 md:grid-cols-3">
        <Select label="Pedido de delivery" required value={jobForm.orderId} onChange={e => setJobForm({ ...jobForm, orderId: e.target.value })}><option value="">Selecione</option>{availableOrders.map(order => <option key={order.id} value={order.id}>{order.code} — {order.customerName || 'Sem cliente'} — {formatMoney(order.total)}</option>)}</Select>
        {couriers.length > 0 && <Select label="Entregador cadastrado" value={jobForm.courierId} onChange={e => setJobForm({ ...jobForm, courierId: e.target.value })}><option value="">Definir depois</option>{couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}{courier.phone ? ` — ${courier.phone}` : ''}</option>)}<option value={MANUAL_COURIER}>Digitar manualmente…</option></Select>}
        {(couriers.length === 0 || jobForm.courierId === MANUAL_COURIER) && <>
          <Field label="Entregador" maxLength={160} value={jobForm.courierName} onChange={e => setJobForm({ ...jobForm, courierName: e.target.value })} />
          <Field label="Telefone do entregador" maxLength={30} value={jobForm.courierPhone} onChange={e => setJobForm({ ...jobForm, courierPhone: e.target.value })} />
        </>}
        <Field label="Endereço de entrega" maxLength={500} value={jobForm.address} onChange={e => setJobForm({ ...jobForm, address: e.target.value })} />
        <Field label="Parceiro/plataforma" maxLength={80} value={jobForm.provider} onChange={e => setJobForm({ ...jobForm, provider: e.target.value })} />
        <div className="flex items-end"><button className={buttonClass} disabled={availableOrders.length === 0}>Criar entrega</button></div>
      </form>{availableOrders.length === 0 && <p className="mt-3 text-sm text-slate-400">Nenhum pedido de delivery sem entrega associada.</p>}</section>

    <section className={`${panelClass} mb-6`}><div className="mb-4 flex flex-wrap items-end justify-between gap-2"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Acompanhamento</p><h2 className="mt-1 text-lg font-semibold">Quadro de entregas ({jobs.length})</h2></div><Link href="/orders" className={secondaryButtonClass}>Ir para pedidos</Link></div>
      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-5">{Object.keys(statusLabel).map(status => {
        const column = jobs.filter(job => job.status === status);
        return <section key={status} className="min-w-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50"><h3 className="border-b border-slate-200 bg-brand-50 px-3 py-3 text-sm font-semibold text-brand-700">{statusLabel[status]} ({column.length})</h3><div className="grid content-start gap-3 p-3">{column.map(job => <article key={job.id} className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"><h4 className="font-semibold">{job.order?.code ?? 'Pedido'}</h4><p className="mt-1 text-sm text-slate-600">{job.order?.customerName || 'Sem cliente'} · {job.address || 'Endereço não informado'}</p><p className="mt-2 text-xs text-slate-500">Entregador: {job.courierName || 'não definido'}{job.courierPhone ? ` (${job.courierPhone})` : ''}{job.provider ? ` · ${job.provider}` : ''} · {formatDateTime(job.createdAt)}</p>{couriers.length > 0 && transitions[job.status]?.length > 0 && <label className="mt-2 block text-xs text-slate-500">Entregador<select className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900" value={(job as DeliveryJob & { courierId?: string | null }).courierId ?? ''} onChange={e => void assignCourier(job, e.target.value)}><option value="">{job.courierName ? `${job.courierName} (manual)` : 'Não definido'}</option>{couriers.map(courier => <option key={courier.id} value={courier.id}>{courier.name}</option>)}</select></label>}{job.order && <p className="mt-2 text-sm text-slate-600">{job.order.items.map(line => `${line.quantity}× ${line.product.name}`).join(', ')} · {formatMoney(job.order.total)}</p>}<div className="mt-3 flex flex-wrap gap-2">{job.order && job.order.status !== 'CANCELLED' && <Link href={`/cash?orderId=${encodeURIComponent(job.orderId)}#pagamento`} className={secondaryButtonClass}>Pagamento</Link>}{transitions[job.status]?.map(next => <button key={next} className={next === 'CANCELLED' ? secondaryButtonClass : buttonClass} onClick={() => void setStatus(job, next)}>{actionLabel[next]}</button>)}</div></article>)}{column.length === 0 && <p className="py-3 text-center text-xs text-slate-500">Nenhuma entrega.</p>}</div></section>;
      })}</div>
    </section>

    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Zonas de entrega ({zones.length})</h2>
      <form onSubmit={createZone} className="mb-4 grid gap-4 md:grid-cols-4"><Field label="Nome" required minLength={2} maxLength={100} value={zoneForm.name} onChange={e => setZoneForm({ ...zoneForm, name: e.target.value })} /><Field label="Taxa (R$)" type="number" required min="0" step="0.01" value={zoneForm.fee} onChange={e => setZoneForm({ ...zoneForm, fee: e.target.value })} /><Field label="Pedido mínimo (R$)" type="number" min="0" step="0.01" value={zoneForm.minOrder} onChange={e => setZoneForm({ ...zoneForm, minOrder: e.target.value })} /><div className="flex items-end"><button className={buttonClass}>Adicionar zona</button></div></form>
      <div className="grid gap-3 md:grid-cols-2">{zones.map(zone => <article key={zone.id} className="rounded-lg border border-slate-800 p-4"><h3 className="font-semibold">{zone.name}</h3><p className="mt-1 text-sm text-slate-400">Taxa {formatMoney(zone.fee)}{zone.minOrder ? ` · mínimo ${formatMoney(zone.minOrder)}` : ''}</p><div className="mt-3 flex flex-wrap items-center gap-2"><input aria-label={`Nova taxa da zona ${zone.name}`} type="number" min="0" step="0.01" placeholder="Nova taxa" className="w-28 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-white" value={fees[zone.id] ?? ''} onChange={e => setFees({ ...fees, [zone.id]: e.target.value })} /><button className={secondaryButtonClass} disabled={!fees[zone.id]} onClick={() => void patchZone(zone, { fee: Number(fees[zone.id]) })}>Salvar taxa</button><button className={secondaryButtonClass} onClick={() => void patchZone(zone, { active: false })}>Desativar</button></div></article>)}</div>{zones.length === 0 && <p className="text-slate-400">Nenhuma zona ativa cadastrada.</p>}
    </section>
  </AppShell>;
}
