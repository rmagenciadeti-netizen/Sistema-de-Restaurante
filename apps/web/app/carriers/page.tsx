'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, textareaClass, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import { formatDocument, type Carrier, type DeleteResult } from '../../lib/types-registry';

const emptyForm = { name: '', document: '', phone: '', email: '', notes: '', active: true };

export default function CarriersPage() {
  const [items, setItems] = useState<Carrier[]>([]);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<Carrier | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; active?: string } = {}) {
    const params = new URLSearchParams();
    const query = (next.q ?? q).trim(); const status = next.active ?? active;
    if (query) params.set('q', query);
    if (status) params.set('active', status);
    try { setItems((await api<ListResponse<Carrier>>(`/carriers?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar transportadoras'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(carrier: Carrier | 'new') {
    setNotice(null); setEditing(carrier);
    setForm(carrier === 'new' ? emptyForm : { name: carrier.name, document: formatDocument(carrier.document), phone: carrier.phone ?? '', email: carrier.email ?? '', notes: carrier.notes ?? '', active: carrier.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const digits = form.document.replace(/\D/g, '');
    if (digits && digits.length !== 11 && digits.length !== 14) { setNotice({ text: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido.', kind: 'error' }); return; }
    setSaving(true);
    const body = JSON.stringify({ name: form.name, document: digits || null, phone: form.phone || null, email: form.email || null, notes: form.notes || null, active: form.active });
    try {
      if (editing === 'new') await api('/carriers', { method: 'POST', body }); else await api(`/carriers/${editing!.id}`, { method: 'PATCH', body });
      ok('Transportadora salva.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar transportadora'); } finally { setSaving(false); }
  }
  async function toggle(carrier: Carrier) {
    try { await api(`/carriers/${carrier.id}`, { method: 'PATCH', body: JSON.stringify({ active: !carrier.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar transportadora'); }
  }
  async function remove(carrier: Carrier) {
    if (!window.confirm(`Excluir a transportadora ${carrier.name}?`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/carriers/${carrier.id}`, { method: 'DELETE' }), 'Transportadora')); await load(); } catch (e) { fail(e, 'Erro ao excluir transportadora'); }
  }

  return <AppShell title="Transportadoras">
    <PageHeader title="Transportadoras" subtitle="Empresas que transportam mercadorias para o seu estabelecimento." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? 'Nova transportadora' : 'Editar transportadora'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Nome" required minLength={2} maxLength={160} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="CPF/CNPJ" inputMode="numeric" maxLength={18} placeholder="Somente números ou formatado" value={form.document} onChange={e => setForm({ ...form, document: e.target.value })} />
        <Field label="Telefone" type="tel" maxLength={30} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
        <Field label="E-mail" type="email" maxLength={160} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
      </div>
      <label className="block text-sm font-medium text-slate-700">Observações<textarea className={textareaClass} rows={3} maxLength={500} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
      <Toggle label="Ativo" checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Nome, documento, telefone ou e-mail" />
    {loaded && items.length === 0 ? <EmptyState icon="🚚" title="Não há registros" hint="Adicione a primeira transportadora." /> :
      <DataTable columns={[{ label: 'Nome' }, { label: 'CPF/CNPJ' }, { label: 'Contato' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(carrier => <tr key={carrier.id}>
          <td className="font-medium text-slate-900">{carrier.name}</td><td>{formatDocument(carrier.document) || '—'}</td><td>{[carrier.phone, carrier.email].filter(Boolean).join(' · ') || '—'}</td><td><ActiveBadge active={carrier.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(carrier)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(carrier)}>{carrier.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(carrier)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
