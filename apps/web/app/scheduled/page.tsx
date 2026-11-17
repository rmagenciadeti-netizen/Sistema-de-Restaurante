'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, formatMoney, ListResponse, storedUser, toIso } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { OpsNav } from '../../components/ops-nav';
import { PasswordReleaseDialog } from '../../components/password-release';
import { Badge, EmptyState } from '../../components/ui';
import { channelLabels, dayKey, dayTitle, isHeld, lineText, opsError, orderTitle, statusLabels, timeOf, toLocalInput, type OpsOrder } from '../../lib/types-ops';

const PAGE_SIZE = 50;

export default function ScheduledPage() {
  const [orders, setOrders] = useState<OpsOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(() => toLocalInput(new Date()).slice(0, 10));
  const [to, setTo] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState('');
  const [busyId, setBusyId] = useState('');
  const [rescheduling, setRescheduling] = useState<{ id: string; value: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<OpsOrder | null>(null);

  async function load(nextPage = page) {
    try {
      const params = new URLSearchParams({ scope: 'scheduled', page: String(nextPage), pageSize: String(PAGE_SIZE) });
      if (q.trim()) params.set('q', q.trim());
      if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set('to', new Date(`${to}T23:59:59.999`).toISOString());
      const result = await api<ListResponse<OpsOrder>>(`/orders?${params}`);
      setOrders(result.items); setTotal(result.total); setPage(nextPage);
    } catch (error) { setMessage(opsError(error, 'Erro ao carregar vendas agendadas')); }
  }
  useAutoLoad(() => load(), 30000);

  async function run(order: OpsOrder, action: () => Promise<unknown>, done: string) {
    setBusyId(order.id); setMessage(''); setSuccess('');
    try { await action(); setSuccess(done); setRescheduling(null); await load(); }
    catch (error) { setMessage(opsError(error, 'Não foi possível concluir a ação')); }
    finally { setBusyId(''); }
  }
  const release = (order: OpsOrder) => run(order, () => api(`/orders/${order.id}/release`, { method: 'POST' }), `Pedido ${orderTitle(order)} liberado para produção.`);
  const reschedule = (order: OpsOrder, value: string) => run(order, () => api(`/orders/${order.id}/schedule`, { method: 'PATCH', body: JSON.stringify({ scheduledFor: toIso(value) }) }), `Pedido ${orderTitle(order)} reagendado.`);
  const cancel = (order: OpsOrder) => run(order, () => api(`/orders/${order.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'CANCELLED' }) }), `Pedido ${orderTitle(order)} cancelado.`);
  function requestCancel(order: OpsOrder) {
    const role = storedUser().role;
    if (role === 'ADMIN' || role === 'MANAGER') { if (window.confirm(`Cancelar o pedido agendado ${orderTitle(order)}?`)) void cancel(order); return; }
    setCancelTarget(order);
  }

  const days = new Map<string, OpsOrder[]>();
  for (const order of orders) { if (!order.scheduledFor) continue; const key = dayKey(order.scheduledFor); days.set(key, [...(days.get(key) ?? []), order]); }
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return <AppShell title="Vendas agendadas">
    <OpsNav />
    {message && <Notice message={message} />}
    {success && <Notice message={success} kind="success" />}
    <form onSubmit={event => { event.preventDefault(); void load(1); }} className={`${panelClass} mb-4 grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-5`}>
      <div className="sm:col-span-2"><Field label="Buscar" type="search" placeholder="Nº, código, cliente" value={q} onChange={event => setQ(event.target.value)} /></div>
      <Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} />
      <Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} />
      <div className="flex gap-2"><button className={`${buttonClass} min-h-11`}>Filtrar</button><Link href="/schedule-settings" className={`${secondaryButtonClass} flex min-h-11 items-center`}>Configurar</Link></div>
    </form>

    {orders.length === 0
      ? <EmptyState icon="📅" title="Nenhuma venda agendada" hint="Pedidos com data e hora marcadas (criados no PDV ou na loja online) aparecem aqui, agrupados por dia." action={<Link href="/pdv" className={buttonClass}>Ir para o PDV</Link>} />
      : <div className="grid gap-5">
        {Array.from(days.entries()).map(([key, list]) => <section key={key} aria-label={dayTitle(key)}>
          <h2 className="mb-2 text-sm font-bold capitalize tracking-wide text-slate-700">{dayTitle(key)} <span className="font-normal text-slate-500">· {list.length} pedido(s)</span></h2>
          <div className="grid gap-3">
            {list.map(order => {
              const held = isHeld(order);
              const busy = busyId === order.id;
              const draft = rescheduling?.id === order.id ? rescheduling : null;
              return <article key={order.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-4">
                    <div className="rounded-xl bg-neutral-950 px-3 py-2 text-center text-brand-300"><span className="block text-xl font-black">{timeOf(order.scheduledFor)}</span><span className="text-[10px] uppercase tracking-wider">para</span></div>
                    <div>
                      <h3 className="font-bold text-slate-900">{orderTitle(order)} <span className="text-xs font-normal text-slate-500">· {channelLabels[order.channel] ?? order.channel}</span></h3>
                      <p className="text-sm text-slate-600">{order.customerName || order.customer?.name || 'Sem cliente informado'}{order.customer?.phone ? ` · ${order.customer.phone}` : ''}</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {order.status === 'CANCELLED' ? <Badge tone="red">Cancelado</Badge> : held ? <Badge tone="amber">Retido · libera às {timeOf(order.releaseAt)}</Badge> : <Badge tone="green">Liberado{order.releasedAt ? ` às ${timeOf(order.releasedAt)}` : ''}</Badge>}
                        {!held && order.status !== 'CANCELLED' && <Badge tone="blue">{statusLabels[order.status] ?? order.status}</Badge>}
                      </div>
                    </div>
                  </div>
                  <p className="text-xl font-bold text-slate-900">{formatMoney(order.total)}</p>
                </div>
                <p className="mt-2 text-sm text-slate-700">{order.items.filter(item => !item.parentItemId).map(lineText).join(' · ')}</p>
                {held && <div className="mt-3 flex flex-wrap items-end gap-2">
                  <button type="button" disabled={busy} onClick={() => void release(order)} className={`${buttonClass} min-h-11`}>Liberar agora</button>
                  {draft
                    ? <><label className="text-sm text-slate-700">Novo horário<input type="datetime-local" className="mt-1 block rounded-xl border border-slate-300 px-3 py-2" value={draft.value} onChange={event => setRescheduling({ id: order.id, value: event.target.value })} /></label><button type="button" disabled={busy || !draft.value} onClick={() => void reschedule(order, draft.value)} className={`${buttonClass} min-h-11`}>Salvar</button><button type="button" onClick={() => setRescheduling(null)} className={`${secondaryButtonClass} min-h-11`}>Voltar</button></>
                    : <button type="button" disabled={busy} onClick={() => setRescheduling({ id: order.id, value: toLocalInput(new Date(order.scheduledFor ?? Date.now())) })} className={`${secondaryButtonClass} min-h-11`}>Reagendar</button>}
                  <button type="button" disabled={busy} onClick={() => requestCancel(order)} className="min-h-11 rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">Cancelar</button>
                </div>}
              </article>;
            })}
          </div>
        </section>)}
        <div className="flex items-center justify-between">
          <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={page <= 1} onClick={() => void load(page - 1)}>‹ Anterior</button>
          <span className="text-sm text-slate-500">Página {page} de {pages} · {total} agendamento(s)</span>
          <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={page >= pages} onClick={() => void load(page + 1)}>Próxima ›</button>
        </div>
      </div>}
    <PasswordReleaseDialog open={Boolean(cancelTarget)} action="CANCEL_ORDER" orderId={cancelTarget?.id} onCancel={() => setCancelTarget(null)} onAuthorized={() => { const target = cancelTarget; setCancelTarget(null); if (target) void cancel(target); }} />
  </AppShell>;
}
