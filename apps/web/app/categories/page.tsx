'use client';

import Link from '../../components/nav-link';
import { useState } from 'react';
import { api, errorMessage, ListResponse, ProductCategory } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';

export default function CategoriesPage() {
  const [items, setItems] = useState<ProductCategory[]>([]);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<ProductCategory | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setItems((await api<ListResponse<ProductCategory>>('/products/categories')).items); return true; }
    catch (error) { setNotice({ text: errorMessage(error, 'Erro ao carregar categorias'), kind: 'error' }); return false; }
  }
  useAutoLoad(async () => { await load(); });
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setNotice(null);
    try {
      await api(editing ? `/products/categories/${editing.id}` : '/products/categories', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify({ name: name.trim() }) });
      setName(''); setEditing(null);
      if (await load()) setNotice({ text: 'Categoria salva.', kind: 'success' });
      else setNotice({ text: 'Categoria salva, mas não foi possível atualizar a lista.', kind: 'error' });
    } catch (error) { setNotice({ text: errorMessage(error, 'Erro ao salvar categoria'), kind: 'error' }); }
    finally { setBusy(false); }
  }

  return <AppShell title="Categorias do cardápio">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-700">Organização do cardápio</p><h2 className="mt-1 text-lg font-semibold">{editing ? 'Editar categoria' : 'Nova categoria'}</h2><p className="mt-1 text-sm text-slate-500">As categorias agrupam os produtos no cardápio de mesa.</p></div><Link href="/products" className={secondaryButtonClass}>Ver produtos</Link></div>
      <form onSubmit={save} className="flex flex-wrap items-end gap-3"><div className="min-w-52 flex-1"><Field label="Nome" required minLength={2} maxLength={100} value={name} onChange={event => setName(event.target.value)} /></div><button className={buttonClass} disabled={busy}>{editing ? 'Salvar' : 'Adicionar categoria'}</button>{editing && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => { setEditing(null); setName(''); }}>Cancelar</button>}</form>
    </section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Categorias ({items.length})</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{items.map(item => <article key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4"><h3 className="font-semibold">{item.name}</h3><button type="button" className={secondaryButtonClass} onClick={() => { setEditing(item); setName(item.name); }}>Editar</button></article>)}</div>{items.length === 0 && <p className="text-sm text-slate-500">Nenhuma categoria cadastrada.</p>}</section>
  </AppShell>;
}
