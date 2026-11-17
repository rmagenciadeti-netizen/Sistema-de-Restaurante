'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, errorMessage, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, Tabs, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import type { DeleteResult, FinancialCategory, FinancialCategoryType } from '../../lib/types-registry';

const tabs: { key: FinancialCategoryType; label: string }[] = [{ key: 'EXPENSE', label: 'Contas a pagar' }, { key: 'INCOME', label: 'Contas a receber' }];
const emptyForm = { name: '', active: true };

function FinancialCategoriesContent() {
  const typeParam = useSearchParams().get('type');
  const [items, setItems] = useState<FinancialCategory[]>([]);
  const [type, setType] = useState<FinancialCategoryType>(typeParam === 'INCOME' ? 'INCOME' : 'EXPENSE');
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<FinancialCategory | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; active?: string; type?: FinancialCategoryType } = {}) {
    const params = new URLSearchParams({ type: next.type ?? type });
    const query = (next.q ?? q).trim(); const status = next.active ?? active;
    if (query) params.set('q', query);
    if (status) params.set('active', status);
    try { setItems((await api<ListResponse<FinancialCategory>>(`/financial-categories?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar categorias'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(category: FinancialCategory | 'new') {
    setNotice(null); setEditing(category);
    setForm(category === 'new' ? emptyForm : { name: category.name, active: category.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    try {
      if (editing === 'new') await api('/financial-categories', { method: 'POST', body: JSON.stringify({ ...form, type }) });
      else await api(`/financial-categories/${editing!.id}`, { method: 'PATCH', body: JSON.stringify(form) });
      ok('Categoria salva.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar categoria'); } finally { setSaving(false); }
  }
  async function toggle(category: FinancialCategory) {
    try { await api(`/financial-categories/${category.id}`, { method: 'PATCH', body: JSON.stringify({ active: !category.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar categoria'); }
  }
  async function remove(category: FinancialCategory) {
    if (!window.confirm(`Excluir a categoria ${category.name}? Se houver lançamentos nela, será apenas desativada.`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/financial-categories/${category.id}`, { method: 'DELETE' }), 'Categoria')); await load(); } catch (e) { fail(e, 'Erro ao excluir categoria'); }
  }
  function changeType(next: FinancialCategoryType) { setType(next); setEditing(null); setNotice(null); void load({ type: next }); }

  const title = type === 'EXPENSE' ? 'contas a pagar' : 'contas a receber';
  return <AppShell title="Categorias de contas">
    <PageHeader title="Categorias de contas" subtitle="Organize os lançamentos do financeiro. Ao lançar uma conta com o nome de uma categoria cadastrada, o nome oficial é usado." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    <Tabs tabs={tabs} value={type} onChange={changeType} label="Tipo de conta" />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? `Nova categoria de ${title}` : 'Editar categoria'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <Field label="Nome" required minLength={2} maxLength={100} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <Toggle label="Ativo" checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Nome da categoria" />
    {loaded && items.length === 0 ? <EmptyState icon="🗂️" title="Não há registros" hint={`Adicione categorias de ${title}.`} /> :
      <DataTable columns={[{ label: 'Nome' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(category => <tr key={category.id}>
          <td className="font-medium text-slate-900">{category.name}</td><td><ActiveBadge active={category.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(category)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(category)}>{category.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(category)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}

export default function FinancialCategoriesPage() {
  return <Suspense fallback={null}><FinancialCategoriesContent /></Suspense>;
}
