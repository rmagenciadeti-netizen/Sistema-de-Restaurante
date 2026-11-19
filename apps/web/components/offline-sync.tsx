'use client';

import { useCallback, useEffect, useState } from 'react';
import type { QueuedOrder } from '../lib/offline-queue';
import { discardOrder, pendingOrders, retryOrder, subscribeQueue, syncOrders } from '../lib/offline-pos';
import { secondaryButtonClass } from './app-shell';

const SYNC_EVERY_MS = 30000;

// Connection status of the PDV and the orders kept on this device. Syncs by itself when the connection comes back.
export function OfflineSyncBar() {
  const [online, setOnline] = useState(true);
  const [entries, setEntries] = useState<QueuedOrder[]>([]);
  const [info, setInfo] = useState('');
  const refresh = useCallback(async () => { setEntries(await pendingOrders().catch(() => [])); }, []);
  const sync = useCallback(async () => {
    const summary = await syncOrders();
    if (summary && summary.sent + summary.duplicates > 0) setInfo(`${summary.sent + summary.duplicates} venda(s) offline enviada(s) com sucesso.`);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); if (navigator.onLine) void sync(); };
    window.addEventListener('online', update); window.addEventListener('offline', update);
    const unsubscribe = subscribeQueue(() => void refresh());
    const timer = setInterval(() => { if (navigator.onLine) void sync(); }, SYNC_EVERY_MS);
    // initial state is read once the page is on the client (SSR has no navigator)
    queueMicrotask(() => { setOnline(navigator.onLine); void sync(); });
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); unsubscribe(); clearInterval(timer); };
  }, [refresh, sync]);

  const blocked = entries.filter(entry => entry.error);
  const waiting = entries.length - blocked.length;
  if (online && entries.length === 0 && !info) return null;
  return <div role="status" className={`mb-3 rounded-xl border px-4 py-3 text-sm ${online ? 'border-emerald-300 bg-emerald-50 text-emerald-900' : 'border-amber-300 bg-amber-50 text-amber-900'}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span>{online ? (waiting > 0 ? '🟡 Conectado, enviando' : '🟢 Conectado') : '🟠 Sem conexão — as vendas continuam e ficam guardadas neste aparelho'}{waiting > 0 ? ` · ${waiting} pedido(s) aguardando envio` : ''}{info ? ` · ${info}` : ''}</span>
      {online && waiting > 0 && <button type="button" className={secondaryButtonClass} onClick={() => void sync()}>Sincronizar agora</button>}
    </div>
    {(!online || waiting > 0) && <p className="mt-1 text-xs">Pedidos são guardados e enviados ao voltar a internet. Pagamento, TEF e nota fiscal exigem conexão: finalize-os no Caixa depois da sincronização.</p>}
    {blocked.length > 0 && <ul className="mt-2 grid gap-2">{blocked.map(entry => <li key={entry.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-900">
      <span><strong>{entry.label}</strong> não foi aceito pelo servidor: {entry.error}</span>
      <span className="flex gap-2"><button type="button" className={secondaryButtonClass} onClick={() => void retryOrder(entry.key).then(sync)}>Tentar de novo</button><button type="button" className={secondaryButtonClass} onClick={() => { if (window.confirm('Descartar este pedido? Ele não será enviado.')) void discardOrder(entry.key); }}>Descartar</button></span>
    </li>)}</ul>}
  </div>;
}
