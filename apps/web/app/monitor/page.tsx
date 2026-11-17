'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, formatDateTime, formatMoney, ListResponse, storedUser } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Notice, secondaryButtonClass } from '../../components/app-shell';
import { OpsNav } from '../../components/ops-nav';
import { PasswordReleaseDialog } from '../../components/password-release';
import { Badge, EmptyState } from '../../components/ui';
import { channelLabels, elapsedLabel, isHeld, lineText, opsError, orderTitle, paidTotal, type OpsOrder } from '../../lib/types-ops';

type Column = 'ACCEPTED' | 'READY' | 'OUT';
type Filter = 'ALL' | 'LOCAL' | 'DELIVERY';

const columns: { key: Column; title: string; hint: string; bar: string; head: string }[] = [
  { key: 'ACCEPTED', title: 'Aceito', hint: 'Na fila ou em preparo', bar: 'border-sky-500', head: 'bg-sky-600' },
  { key: 'READY', title: 'Pronto', hint: 'Aguardando retirada ou despacho', bar: 'border-emerald-500', head: 'bg-emerald-600' },
  { key: 'OUT', title: 'Saiu para entrega', hint: 'Entregador em rota', bar: 'border-brand-500', head: 'bg-brand-600' },
];
const filters: { key: Filter; label: string }[] = [{ key: 'ALL', label: 'Todos' }, { key: 'LOCAL', label: 'Retirada / Consumo' }, { key: 'DELIVERY', label: 'Entrega' }];

// A delivery order leaves the counter when its delivery job is picked up by the courier.
function columnOf(order: OpsOrder): Column {
  if (order.channel === 'DELIVERY' && order.deliveryJob?.status === 'PICKED_UP' && order.status === 'READY') return 'OUT';
  return order.status === 'READY' ? 'READY' : 'ACCEPTED';
}

async function loadActive() {
  const items: OpsOrder[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const result = await api<ListResponse<OpsOrder>>(`/orders?scope=active&pageSize=100&page=${page}`);
    items.push(...result.items);
    if (items.length >= result.total || result.items.length === 0) break;
  }
  return items;
}

export default function MonitorPage() {
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [filter, setFilter] = useState<Filter>('ALL');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');
  const [busyId, setBusyId] = useState('');
  const [cancelTarget, setCancelTarget] = useState<OpsOrder | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string>('');
  const [now, setNow] = useState(0);

  async function load() {
    try {
      setOrders(await loadActive());
      setUpdatedAt(new Date().toISOString()); setNow(Date.now()); setMessage('');
    } catch (error) { setMessage(opsError(error, 'Erro ao carregar pedidos')); }
  }
  useAutoLoad(load, 15000);

  async function changeStatus(order: OpsOrder, status: string, afterDelivered = false) {
    setBusyId(order.id); setMessage(''); setSuccess('');
    try {
      if (afterDelivered && order.deliveryJob) await api(`/delivery/${order.deliveryJob.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'DELIVERED' }) }).catch(() => undefined);
      await api(`/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      setSuccess(`Pedido ${orderTitle(order)} atualizado.`);
      await load();
    } catch (error) { setMessage(opsError(error, 'Erro ao atualizar pedido')); }
    finally { setBusyId(''); }
  }
  function requestCancel(order: OpsOrder) {
    const role = storedUser().role;
    if (role === 'ADMIN' || role === 'MANAGER') { if (window.confirm(`Cancelar o pedido ${orderTitle(order)}?`)) void changeStatus(order, 'CANCELLED'); return; }
    setCancelTarget(order);
  }

  const visible = orders.filter(order => !isHeld(order) && (filter === 'ALL' || (filter === 'DELIVERY' ? order.channel === 'DELIVERY' : order.channel !== 'DELIVERY')));
  const counts: Record<Filter, number> = { ALL: orders.filter(order => !isHeld(order)).length, LOCAL: orders.filter(order => !isHeld(order) && order.channel !== 'DELIVERY').length, DELIVERY: orders.filter(order => !isHeld(order) && order.channel === 'DELIVERY').length };

  function actions(order: OpsOrder, column: Column) {
    const busy = busyId === order.id;
    const main = column === 'OUT'
      ? <button type="button" disabled={busy} onClick={() => void changeStatus(order, 'COMPLETED', true)} className={`${buttonClass} min-h-11 flex-1`}>Confirmar entrega</button>
      : order.status === 'OPEN' ? <button type="button" disabled={busy} onClick={() => void changeStatus(order, 'PREPARING')} className={`${buttonClass} min-h-11 flex-1`}>Iniciar preparo</button>
        : order.status === 'PREPARING' ? <button type="button" disabled={busy} onClick={() => void changeStatus(order, 'READY')} className={`${buttonClass} min-h-11 flex-1`}>Marcar pronto</button>
          : <button type="button" disabled={busy} onClick={() => void changeStatus(order, 'COMPLETED')} className={`${buttonClass} min-h-11 flex-1`}>{order.channel === 'DELIVERY' ? 'Finalizar' : 'Entregar / finalizar'}</button>;
    return <div className="mt-3 flex flex-wrap gap-2">
      {main}
      {order.channel === 'DELIVERY' && column === 'READY' && <Link href={`/delivery?orderId=${encodeURIComponent(order.id)}#nova-entrega`} className={`${secondaryButtonClass} flex min-h-11 items-center`}>Despachar</Link>}
      <button type="button" disabled={busy} onClick={() => requestCancel(order)} className="min-h-11 rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50">Cancelar</button>
    </div>;
  }

  return <AppShell title="Pedidos">
    <OpsNav />
    {message && <Notice message={message} />}
    {success && <Notice message={success} kind="success" />}
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
      <span>Atualiza sozinho a cada 15 segundos{updatedAt ? ` · última leitura ${formatDateTime(updatedAt)}` : ''}</span>
      <Link href="/scheduled" className="font-semibold text-brand-700 hover:text-brand-600">Pedidos agendados retidos aparecem em Vendas agendadas ›</Link>
    </div>
    <div className="grid items-start gap-4 pb-24 lg:grid-cols-3">
      {columns.map(column => {
        const list = visible.filter(order => columnOf(order) === column.key);
        return <section key={column.key} aria-label={column.title} className={`overflow-hidden rounded-2xl border-t-4 bg-white shadow-sm ring-1 ring-slate-200 ${column.bar}`}>
          <header className={`flex items-center justify-between gap-2 px-4 py-3 text-white ${column.head}`}>
            <div><h2 className="text-base font-bold">{column.title}</h2><p className="text-[11px] text-white/80">{column.hint}</p></div>
            <span className="grid h-8 min-w-8 place-items-center rounded-full bg-white/20 px-2 text-sm font-bold">{list.length}</span>
          </header>
          <div className="grid max-h-[70vh] gap-3 overflow-y-auto bg-slate-50 p-3">
            {list.map(order => <article key={order.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0"><h3 className="text-2xl font-black tracking-tight text-slate-900">{orderTitle(order)}</h3><p className="truncate text-[11px] text-slate-500">{order.code}</p></div>
                <div className="flex flex-wrap justify-end gap-1"><Badge tone={order.channel === 'DELIVERY' ? 'gold' : 'blue'}>{channelLabels[order.channel] ?? order.channel}</Badge>{order.scheduledFor && <Badge tone="amber">Agendado {new Date(order.scheduledFor).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Badge>}</div>
              </div>
              <p className="mt-1 text-sm font-medium text-slate-700">{order.tableLabel ? `Mesa/comanda ${order.tableLabel}` : order.customerName || order.customer?.name || 'Sem cliente informado'}{order.tableLabel && order.customerName ? ` · ${order.customerName}` : ''}</p>
              <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
                {order.items.filter(item => !item.parentItemId).slice(0, 6).map(item => <li key={item.id}>{lineText(item)}{item.notes ? <span className="block text-xs text-amber-700">Obs.: {item.notes}</span> : null}</li>)}
                {order.items.filter(item => !item.parentItemId).length > 6 && <li className="text-xs text-slate-500">+ {order.items.filter(item => !item.parentItemId).length - 6} itens</li>}
              </ul>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-2 text-sm">
                <span className="font-bold text-slate-900">{formatMoney(order.total)}</span>
                <span className="flex items-center gap-2">{paidTotal(order) >= Number(order.total) ? <Badge tone="green">Pago</Badge> : <Badge>A receber</Badge>}<span title={`Aberto em ${formatDateTime(order.createdAt)}`} className="text-xs font-semibold text-slate-500">⏱ {elapsedLabel(order.createdAt, now || undefined)}</span></span>
              </div>
              {order.deliveryJob?.courierName && <p className="mt-1 text-xs text-slate-500">Entregador: {order.deliveryJob.courierName}</p>}
              {actions(order, column.key)}
            </article>)}
            {list.length === 0 && <EmptyState icon="✅" title="Nada por aqui" hint="Os pedidos aparecem automaticamente nesta coluna." />}
          </div>
        </section>;
      })}
    </div>
    <div role="group" aria-label="Filtrar pedidos" className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 gap-1 rounded-full bg-neutral-950 p-1.5 shadow-xl ring-1 ring-white/10 print:hidden">
      {filters.map(item => <button key={item.key} type="button" aria-pressed={filter === item.key} onClick={() => setFilter(item.key)} className={`min-h-11 whitespace-nowrap rounded-full px-4 text-sm font-semibold transition ${filter === item.key ? 'bg-brand-500 text-neutral-950' : 'text-neutral-200 hover:bg-white/10'}`}>{item.label} <span className="ml-1 opacity-70">{counts[item.key]}</span></button>)}
    </div>
    <PasswordReleaseDialog open={Boolean(cancelTarget)} action="CANCEL_ORDER" orderId={cancelTarget?.id} onCancel={() => setCancelTarget(null)} onAuthorized={() => { const target = cancelTarget; setCancelTarget(null); if (target) void changeStatus(target, 'CANCELLED'); }} />
  </AppShell>;
}
