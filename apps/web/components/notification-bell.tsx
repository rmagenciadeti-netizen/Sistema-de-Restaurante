'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from './nav-link';
import { api } from '../lib/api';
import { useAutoLoad } from '../lib/use-auto-load';

type Item = { id: string; severity: string; title: string; body: string; href: string | null; readAt: string | null; createdAt: string };

// Bell with the automations center notifications (GET /notifications); the API already hides financial items from roles without access.
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try { const data = await api<{ items: Item[]; unread: number }>('/notifications'); setItems(data.items); setUnread(data.unread); } catch { /* the bell is optional; the app keeps working without it */ }
  }, []);
  useAutoLoad(load, 60_000);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  async function markAll() { try { await api('/notifications/read-all', { method: 'POST' }); await load(); } catch { /* retried on the next poll */ } }
  async function markOne(item: Item) { if (!item.readAt) { try { await api(`/notifications/${item.id}/read`, { method: 'POST' }); await load(); } catch { /* retried on the next poll */ } } }

  return <div ref={box} className="relative">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label={unread > 0 ? `Notificações (${unread} não lidas)` : 'Notificações'} className="relative grid h-10 w-10 place-items-center rounded-lg border border-white/15 text-brand-300 hover:bg-white/10">
      <span aria-hidden="true">🔔</span>
      {unread > 0 && <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-500 px-1 text-center text-[10px] font-bold leading-5 text-white">{unread > 99 ? '99+' : unread}</span>}
    </button>
    {open && <div className="absolute right-0 z-50 mt-2 w-80 max-w-[90vw] rounded-xl border border-white/15 bg-neutral-950 p-2 text-sm text-white shadow-xl">
      <div className="flex items-center justify-between px-2 py-1"><strong>Notificações</strong>{unread > 0 && <button type="button" onClick={() => void markAll()} className="text-xs text-brand-300 hover:underline">Marcar todas como lidas</button>}</div>
      <ul className="max-h-96 overflow-y-auto">
        {items.length === 0 && <li className="px-2 py-4 text-center text-xs text-neutral-400">Nenhuma notificação.</li>}
        {items.map(item => <li key={item.id} className={`rounded-lg px-2 py-2 ${item.readAt ? 'opacity-60' : 'bg-white/5'}`}>
          <Link href={item.href ?? '/dashboard'} onClick={() => { void markOne(item); setOpen(false); }} className="block">
            <span className={`text-xs font-semibold ${item.severity === 'CRITICAL' ? 'text-red-300' : item.severity === 'WARNING' ? 'text-amber-300' : 'text-brand-300'}`}>{item.title}</span>
            <span className="mt-0.5 block text-xs text-neutral-300">{item.body}</span>
            <span className="mt-0.5 block text-[10px] text-neutral-500">{new Date(item.createdAt).toLocaleString('pt-BR')}</span>
          </Link>
        </li>)}
      </ul>
    </div>}
  </div>;
}
