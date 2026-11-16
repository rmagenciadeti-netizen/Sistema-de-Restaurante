'use client';

import { useEffect, useState } from 'react';
import { api, ListResponse, Unit } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';

export default function UnitsPage() {
  const [items, setItems] = useState<Unit[]>([]); const [form, setForm] = useState({ name: '', code: '', address: '' }); const [message, setMessage] = useState('');
  async function load() { try { const data = await api<ListResponse<Unit>>('/units'); setItems(data.items); } catch (e) { setMessage(e instanceof Error ? e.message : 'Não foi possível carregar as unidades'); } }
  useEffect(() => { void load(); }, []);
  async function submit(event: React.FormEvent) { event.preventDefault(); setMessage(''); try { await api('/units', { method: 'POST', body: JSON.stringify(form) }); setForm({ name: '', code: '', address: '' }); setMessage('Unidade cadastrada.'); await load(); } catch (e) { setMessage(e instanceof Error ? e.message : 'Erro ao cadastrar unidade'); } }
  return <AppShell title="Unidades">
    {message && <Notice message={message} kind={message.includes('cadastrada') ? 'success' : 'error'} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Nova unidade</h2><form onSubmit={submit} className="grid gap-4 md:grid-cols-3"><Field label="Nome" required value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /><Field label="Código" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} /><Field label="Endereço" value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} /><div><button className={buttonClass}>Adicionar unidade</button></div></form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Unidades da empresa</h2><div className="grid gap-3 md:grid-cols-2">{items.map(item => <article key={item.id} className="rounded-lg border border-slate-800 p-4"><h3 className="font-semibold">{item.name}</h3><p className="mt-1 text-sm text-slate-400">{item.code || 'Sem código'} · {item.status}</p><p className="mt-2 text-sm text-slate-300">{item.address || 'Endereço não informado'}</p></article>)}</div>{items.length === 0 && <p className="text-slate-400">Nenhuma unidade encontrada.</p>}</section>
  </AppShell>;
}
