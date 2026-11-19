'use client';

import { useCallback, useState } from 'react';
import { useAutoLoad } from '../../lib/use-auto-load';
import { api, errorMessage, formatMoney } from '../../lib/api';
import { buttonClass, Notice, panelClass, secondaryButtonClass } from '../app-shell';

type Request = { id: string; type: 'WAITER' | 'BILL'; table: string; note: string | null; waitingMinutes: number };
type Pending = { id: string; code: string; tableLabel: string | null; customerName: string | null; total: string | number; createdAt: string; items: { name: string; quantity: string | number; notes: string | null }[] };
const POLL_MS = 10000;

// Calls from the QR menu (waiter / bill) and QR orders waiting for acceptance. Refreshes by itself while the screen is visible.
export function TableRequestsPanel() {
  const [requests, setRequests] = useState<Request[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      const [calls, orders] = await Promise.all([api<{ items: Request[] }>('/table-requests'), api<{ items: Pending[] }>('/table-requests/pending-orders')]);
      setRequests(calls.items); setPending(orders.items); setError('');
    } catch (cause) { setError(errorMessage(cause, 'Falha ao carregar as solicitações das mesas')); }
  }, []);
  useAutoLoad(load, POLL_MS);

  async function run(key: string, action: () => Promise<unknown>, failure: string) {
    setBusy(key);
    try { await action(); await load(); } catch (cause) { setError(errorMessage(cause, failure)); } finally { setBusy(''); }
  }
  if (!error && requests.length === 0 && pending.length === 0) return null;
  return <section aria-label="Solicitações das mesas" className={`${panelClass} mb-6 print:hidden`}>
    <h2 className="mb-3 text-lg font-semibold">🔔 Solicitações das mesas <span className="text-sm font-normal text-slate-500">({requests.length + pending.length})</span></h2>
    {error && <Notice message={error} />}
    {pending.length > 0 && <div className="mb-4 grid gap-3 md:grid-cols-2">{pending.map(order => <article key={order.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2"><strong>Pedido {order.code} · {order.tableLabel ?? 'Mesa'}</strong><span>{formatMoney(order.total)}</span></div>
      <ul className="my-2 grid gap-0.5">{order.items.map((item, index) => <li key={index}>{Number(item.quantity)}× {item.name}{item.notes ? <em className="text-slate-600"> — {item.notes}</em> : null}</li>)}</ul>
      {order.customerName && <p className="text-xs text-slate-600">Cliente: {order.customerName}</p>}
      <div className="mt-2 flex gap-2"><button type="button" className={buttonClass} disabled={busy === order.id} onClick={() => void run(order.id, () => api(`/orders/${order.id}/release`, { method: 'POST' }), 'Não foi possível aceitar o pedido')}>Aceitar e enviar à cozinha</button>
        <button type="button" className={secondaryButtonClass} disabled={busy === order.id} onClick={() => { const reason = window.prompt('Motivo da recusa (opcional):') ?? undefined; void run(order.id, () => api(`/table-requests/pending-orders/${order.id}/refuse`, { method: 'POST', body: JSON.stringify({ reason: reason || undefined }) }), 'Não foi possível recusar o pedido'); }}>Recusar</button></div>
    </article>)}</div>}
    {requests.length > 0 && <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{requests.map(request => <li key={request.id} className="flex items-center justify-between gap-3 rounded-xl border border-brand-500/40 p-3 text-sm">
      <span><strong>{request.table}</strong> · {request.type === 'BILL' ? '🧾 pediu a conta' : '🔔 chamou o garçom'}<span className="block text-xs text-slate-500">há {request.waitingMinutes} min{request.note ? ` · ${request.note}` : ''}</span></span>
      <button type="button" className={secondaryButtonClass} disabled={busy === request.id} onClick={() => void run(request.id, () => api(`/table-requests/${request.id}/done`, { method: 'POST' }), 'Não foi possível marcar como atendido')}>Atendido</button>
    </li>)}</ul>}
  </section>;
}
