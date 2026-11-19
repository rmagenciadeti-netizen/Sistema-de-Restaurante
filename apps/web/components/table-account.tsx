'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, formatMoney, publicApi } from '../lib/api';

type Account = {
  table: string; accountTotal: string; requests: ('WAITER' | 'BILL')[];
  orders: { id: string; code: string; status: 'OPEN' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED'; awaitingConfirmation: boolean; refused: boolean; total: string | number; createdAt: string; items: { name: string; quantity: string | number; status: string }[] }[];
};
const itemLabel: Record<string, string> = { PENDING: 'Recebido', PREPARING: 'Em preparo', READY: 'Pronto', DELIVERED: 'Entregue', CANCELLED: 'Cancelado' };
const POLL_MS = 8000;

// The customer's view of the table: open orders with their live status, the running account and the two calls (waiter, bill).
export function TableAccount({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<'WAITER' | 'BILL' | null>(null);
  const load = useCallback(async () => {
    try { setAccount(await publicApi<Account>(`/public/tables/${encodeURIComponent(token)}/orders`)); } catch { /* the menu itself reports an invalid table */ }
  }, [token]);
  useEffect(() => {
    void load();
    // Refresh while the page is visible; background tabs do not poll.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  async function call(type: 'WAITER' | 'BILL') {
    setBusy(type); setMessage('');
    try {
      const result = await publicApi<{ duplicate: boolean }>(`/public/tables/${encodeURIComponent(token)}/requests`, { method: 'POST', body: JSON.stringify({ type }) });
      setMessage(result.duplicate ? 'Seu chamado já foi enviado. Em instantes alguém virá até você.' : type === 'WAITER' ? 'Garçom chamado. Já estamos a caminho!' : 'Conta solicitada. Já vamos trazer.');
      await load();
    } catch (cause) { setMessage(cause instanceof ApiError && cause.status === 429 ? 'Muitos chamados seguidos. Aguarde um instante.' : 'Não foi possível enviar o chamado. Chame um atendente.'); } finally { setBusy(null); }
  }
  const waiting = account?.requests ?? [];
  return <section aria-label="Sua mesa" className="rm-surface mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-base font-bold text-slate-900">Sua conta</h2>{account && Number(account.accountTotal) > 0 && <span className="text-sm font-semibold text-brand-700">Total em aberto: {formatMoney(account.accountTotal)}</span>}</div>
    <div className="mt-3 grid grid-cols-2 gap-2">
      <button type="button" disabled={busy !== null || waiting.includes('WAITER')} onClick={() => void call('WAITER')} className="rounded-xl border border-brand-500/60 px-3 py-3 text-sm font-semibold text-slate-900 transition hover:bg-brand-50 disabled:opacity-60">{waiting.includes('WAITER') ? '🔔 Garçom chamado' : '🔔 Chamar garçom'}</button>
      <button type="button" disabled={busy !== null || waiting.includes('BILL')} onClick={() => void call('BILL')} className="rounded-xl border border-brand-500/60 px-3 py-3 text-sm font-semibold text-slate-900 transition hover:bg-brand-50 disabled:opacity-60">{waiting.includes('BILL') ? '🧾 Conta solicitada' : '🧾 Pedir a conta'}</button>
    </div>
    {message && <p role="status" className="mt-3 rounded-xl bg-brand-50 px-3 py-2 text-sm text-slate-800">{message}</p>}
    {account && account.orders.length > 0 && <ul className="mt-4 grid gap-3">{account.orders.map(order => <li key={order.id} className="rounded-xl border border-slate-200 p-3 text-sm">
      <div className="flex items-center justify-between gap-2"><strong>Pedido {order.code}</strong><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${order.refused ? 'bg-red-100 text-red-800' : order.awaitingConfirmation ? 'bg-amber-100 text-amber-800' : order.status === 'READY' ? 'bg-emerald-100 text-emerald-800' : 'bg-sky-100 text-sky-800'}`}>{order.refused ? 'Recusado pelo restaurante' : order.awaitingConfirmation ? 'Aguardando confirmação' : order.status === 'READY' ? 'Pronto' : order.status === 'PREPARING' ? 'Em preparo' : 'Recebido'}</span></div>
      <ul className="mt-2 grid gap-0.5 text-slate-600">{order.items.map((item, index) => <li key={index} className="flex justify-between gap-2"><span>{Number(item.quantity)}× {item.name}</span><span className="text-xs text-slate-500">{order.refused || order.awaitingConfirmation ? '' : itemLabel[item.status] ?? item.status}</span></li>)}</ul>
      {order.refused && <p className="mt-2 text-xs text-red-700">Este pedido não foi aceito. Fale com um atendente ou faça um novo pedido.</p>}
    </li>)}</ul>}
  </section>;
}
