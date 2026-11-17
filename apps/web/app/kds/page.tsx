'use client';

import { useRef, useState } from 'react';
import { api, errorMessage, KdsItem, ListResponse, ProductionSector } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, Notice, secondaryButtonClass, Select } from '../../components/app-shell';

const columns: { status: KdsItem['status']; label: string; tone: string; next?: { status: string; label: string } }[] = [
  { status: 'PENDING', label: 'Pendentes', tone: 'bg-amber-700', next: { status: 'PREPARING', label: 'Iniciar preparo' } },
  { status: 'PREPARING', label: 'Em preparo', tone: 'bg-sky-700', next: { status: 'READY', label: 'Marcar pronto' } },
  { status: 'READY', label: 'Prontos', tone: 'bg-emerald-700', next: { status: 'PREPARING', label: 'Voltar ao preparo' } },
];

export default function KdsPage() {
  const [sectors, setSectors] = useState<ProductionSector[]>([]); const [sectorId, setSectorId] = useState(''); const [items, setItems] = useState<KdsItem[]>([]);
  const [message, setMessage] = useState(''); const [now, setNow] = useState(0); const [updatedAt, setUpdatedAt] = useState('');
  const inflight = useRef(false);

  async function loadItems(sector = sectorId) {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const data = await api<ListResponse<KdsItem>>(`/production/kds${sector ? `?sectorId=${sector}` : ''}`);
      setItems(data.items); setNow(Date.now()); setUpdatedAt(new Date().toLocaleTimeString('pt-BR')); setMessage('');
    } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar a cozinha')); } finally { inflight.current = false; }
  }
  async function loadSectors() {
    try { const data = await api<ListResponse<ProductionSector>>('/production/sectors'); setSectors(data.items.filter(sector => sector.active && sector.showOnKds)); } catch (e) { setMessage(errorMessage(e, 'Erro ao carregar setores')); }
  }
  useAutoLoad(loadSectors);
  useAutoLoad(() => loadItems(), 10000);

  async function advance(item: KdsItem, status: string) {
    try { await api(`/production/items/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }); inflight.current = false; await loadItems(); } catch (e) { setMessage(errorMessage(e, 'Erro ao atualizar item')); }
  }
  function changeSector(value: string) { setSectorId(value); inflight.current = false; void loadItems(value); }
  const minutes = (iso: string) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));

  return <AppShell title="Cozinha (KDS)">
    {message && <Notice message={message} />}
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div className="w-full max-w-xs"><Select label="Setor" value={sectorId} onChange={e => changeSector(e.target.value)}><option value="">Todos os setores</option>{sectors.map(sector => <option key={sector.id} value={sector.id}>{sector.name}</option>)}</Select></div><div className="flex items-center gap-3 text-xs text-slate-400"><span>Atualiza a cada 10 s{updatedAt ? ` · última às ${updatedAt}` : ''}</span><button className={secondaryButtonClass} onClick={() => void loadItems()}>Atualizar agora</button></div></div>
    <div className="grid gap-4 lg:grid-cols-3">{columns.map(column => {
      const list = items.filter(item => item.status === column.status);
      return <section key={column.status} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className={`px-4 py-3 text-center text-sm font-semibold text-white ${column.tone}`}>{column.label} ({list.length})</h2><div className="grid min-h-40 content-start gap-3 p-3">{list.map(item => <article key={item.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex items-start justify-between gap-2"><div><p className="text-lg font-semibold">{item.quantity}× {item.product.name}</p>{item.modifiers && item.modifiers.length > 0 && <ul className="mt-1 text-sm text-slate-700">{item.modifiers.map(modifier => <li key={modifier.id}>+ {modifier.name} x{modifier.quantity}</li>)}</ul>}{item.parentItem && <p className="mt-1 text-sm text-purple-700">do combo: {item.parentItem.product.name}</p>}{item.notes && <p className="mt-1 text-sm text-amber-800">Obs.: {item.notes}</p>}<p className="mt-2 text-xs text-slate-600">{item.order.code} · {item.order.tableLabel ? `Mesa ${item.order.tableLabel}` : item.order.channel}{item.product.sector ? ` · ${item.product.sector.name}` : ''}</p></div><span className={`text-xs ${minutes(item.createdAt) >= 15 ? 'font-semibold text-red-700' : 'text-slate-600'}`}>{minutes(item.createdAt)} min</span></div>{column.next && <button className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2.5 text-sm font-semibold text-neutral-950 transition hover:bg-brand-400" onClick={() => void advance(item, column.next!.status)}>{column.next.label}</button>}</article>)}{list.length === 0 && <p className="py-4 text-center text-sm text-slate-500">Nenhum item.</p>}</div></section>;
    })}</div>
  </AppShell>;
}
