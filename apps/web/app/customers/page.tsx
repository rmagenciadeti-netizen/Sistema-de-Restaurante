'use client';

import { useState } from 'react';
import Link from '../../components/nav-link';
import { api, Customer, errorMessage, formatDateTime, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';

const PAGE_SIZE = 25;
const emptyForm = { name: '', phone: '', email: '', document: '', address: '', notes: '', birthDate: '', marketingConsent: false };

export default function CustomersPage() {
  const [items, setItems] = useState<Customer[]>([]); const [total, setTotal] = useState(0); const [page, setPage] = useState(1); const [search, setSearch] = useState('');
  const [form, setForm] = useState(emptyForm); const [editingId, setEditingId] = useState<string | null>(null); const [detail, setDetail] = useState<Customer | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(nextPage = page, term = search) {
    try {
      const data = await api<ListResponse<Customer>>(`/customers?page=${nextPage}&pageSize=${PAGE_SIZE}${term.trim() ? `&search=${encodeURIComponent(term.trim())}` : ''}`);
      setItems(data.items); setTotal(data.total); setPage(nextPage);
    } catch (e) { fail(e, 'Erro ao carregar clientes'); }
  }
  useAutoLoad(() => load());

  async function openDetail(id: string) {
    try { setDetail(await api<Customer>(`/customers/${id}`)); } catch (e) { fail(e, 'Erro ao carregar cliente'); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const common = { name: form.name, email: form.email || undefined, address: form.address || undefined, notes: form.notes || undefined, marketingConsent: form.marketingConsent, ...(editingId ? { birthDate: form.birthDate || null } : form.birthDate ? { birthDate: form.birthDate } : {}) };
    try {
      if (editingId) await api(`/customers/${editingId}`, { method: 'PATCH', body: JSON.stringify(common) });
      else await api('/customers', { method: 'POST', body: JSON.stringify({ ...common, phone: form.phone, document: form.document || undefined }) });
      ok(editingId ? 'Cliente atualizado.' : 'Cliente cadastrado.');
      const id = editingId; setEditingId(null); setForm(emptyForm); await load(); if (id && detail?.id === id) await openDetail(id);
    } catch (e) { fail(e, 'Erro ao salvar cliente'); }
  }
  function startEdit(customer: Customer) {
    setEditingId(customer.id);
    setForm({ name: customer.name, phone: customer.phone, email: customer.email ?? '', document: customer.document ?? '', address: customer.address ?? '', notes: customer.notes ?? '', birthDate: customer.birthDate?.slice(0, 10) ?? '', marketingConsent: customer.marketingConsent });
  }
  async function exportData(customer: Customer) {
    try {
      const data = await api<unknown>(`/customers/${customer.id}/export`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `cliente-${customer.id}.json`; link.click(); URL.revokeObjectURL(url);
      ok('Exportação LGPD gerada.');
    } catch (e) { fail(e, 'Erro ao exportar dados'); }
  }
  async function anonymize(customer: Customer) {
    if (!window.confirm(`Anonimizar ${customer.name}? Os dados pessoais serão apagados de forma irreversível; os pedidos permanecem sem identificação.`)) return;
    try { await api(`/customers/${customer.id}/anonymize`, { method: 'POST' }); ok('Cliente anonimizado.'); setDetail(null); setEditingId(null); setForm(emptyForm); await load(); } catch (e) { fail(e, 'Erro ao anonimizar cliente'); }
  }
  function submitSearch(event: React.FormEvent) { event.preventDefault(); void load(1, search); }
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return <AppShell title="Clientes (CRM)">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">{editingId ? 'Editar cliente' : 'Novo cliente'}</h2>
      <form onSubmit={save} className="grid gap-4 md:grid-cols-3">
        <Field label="Nome" required minLength={2} maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="Telefone" required={!editingId} disabled={!!editingId} minLength={8} maxLength={30} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        <Field label="E-mail" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
        {!editingId && <Field label="Documento" maxLength={20} value={form.document} onChange={e => setForm({ ...form, document: e.target.value })} />}
        <Field label="Endereço" maxLength={500} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
        <Field label="Observações" maxLength={1000} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        <Field label="Data de aniversário" type="date" max={new Date().toISOString().slice(0, 10)} value={form.birthDate} onChange={e => setForm({ ...form, birthDate: e.target.value })} />
        <div className="flex flex-wrap items-center gap-4 md:col-span-3"><Check label="Cliente consentiu receber marketing (LGPD)" checked={form.marketingConsent} onChange={e => setForm({ ...form, marketingConsent: e.target.checked })} /><button className={buttonClass}>{editingId ? 'Salvar cliente' : 'Adicionar cliente'}</button>{editingId && <button type="button" className={secondaryButtonClass} onClick={() => { setEditingId(null); setForm(emptyForm); }}>Cancelar edição</button>}</div>
      </form></section>

    {detail && <section className={`${panelClass} mb-6`}>
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{detail.name}</h2><p className="mt-1 text-sm text-slate-400">{detail.phone}{detail.email ? ` · ${detail.email}` : ''}</p><p className="mt-1 text-sm text-slate-300">{detail.address || 'Endereço não informado'}</p>{detail.notes && <p className="mt-1 text-sm text-slate-400">Obs.: {detail.notes}</p>}<p className="mt-2 text-sm">Pontos de fidelidade: <strong className="text-blue-300">{detail.loyaltyPoints}</strong> · Marketing: {detail.marketingConsent ? 'consentido' : 'não consentido'}</p></div>
        <div className="flex flex-wrap gap-2"><button className={secondaryButtonClass} onClick={() => startEdit(detail)}>Editar</button><button className={secondaryButtonClass} onClick={() => void exportData(detail)}>Exportar dados (LGPD)</button><button className="rounded-lg border border-red-500/50 px-3 py-1.5 text-sm text-red-200 hover:bg-red-500/10" onClick={() => void anonymize(detail)}>Anonimizar</button><button className={secondaryButtonClass} onClick={() => setDetail(null)}>Fechar</button></div></div>
      <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-200">Últimos pedidos</h3>
      <div className="grid gap-2">{(detail.orders ?? []).map(order => <div key={order.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-3 py-3 text-sm"><span className="font-medium">{order.code} · {order.channel} · {order.status}</span><span className="text-slate-500">{formatDateTime(order.createdAt)} · {formatMoney(order.total)}</span>{order.status !== 'CANCELLED' && <Link href={`/cash?orderId=${encodeURIComponent(order.id)}#pagamento`} className={secondaryButtonClass}>Pagamento</Link>}</div>)}{(detail.orders ?? []).length === 0 && <p className="text-sm text-slate-400">Sem pedidos.</p>}</div>
    </section>}

    <section className={panelClass}>
      <form onSubmit={submitSearch} className="mb-4 flex flex-wrap items-end gap-3"><div className="min-w-64 flex-1"><Field label="Buscar por nome ou telefone" value={search} onChange={e => setSearch(e.target.value)} /></div><button className={buttonClass}>Buscar</button></form>
      <h2 className="mb-3 text-lg font-semibold">Clientes ({total})</h2>
      <div className="grid gap-3 md:grid-cols-2">{items.map(customer => <article key={customer.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 p-4"><div><h3 className="font-semibold">{customer.name}</h3><p className="mt-1 text-sm text-slate-400">{customer.phone}{customer.email ? ` · ${customer.email}` : ''}</p><p className="mt-1 text-xs text-slate-500">{customer.loyaltyPoints} pontos{customer.marketingConsent ? ' · marketing consentido' : ''}</p></div><button className={secondaryButtonClass} onClick={() => void openDetail(customer.id)}>Detalhes</button></article>)}</div>
      {items.length === 0 && <p className="text-slate-400">Nenhum cliente encontrado.</p>}
      <div className="mt-4 flex items-center justify-between text-sm text-slate-400"><span>Página {page} de {lastPage}</span><div className="flex gap-2"><button className={secondaryButtonClass} disabled={page <= 1} onClick={() => void load(page - 1)}>Anterior</button><button className={secondaryButtonClass} disabled={page >= lastPage} onClick={() => void load(page + 1)}>Próxima</button></div></div>
    </section>
  </AppShell>;
}
