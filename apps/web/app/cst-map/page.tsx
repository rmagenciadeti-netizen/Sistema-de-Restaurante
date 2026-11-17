'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { DataTable, EmptyState, PageHeader, Toggle } from '../../components/ui';
import { ActiveBadge, FormCard, SearchBar } from '../../components/registry-ui';
import type { CstCorrelation } from '../../lib/types-fiscal';

const emptyForm = { outCst: '', inCst: '', description: '', active: true };

export default function CstMapPage() {
  const [items, setItems] = useState<CstCorrelation[]>([]);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<CstCorrelation | 'new' | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false); const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; active?: string } = {}) {
    const params = new URLSearchParams();
    const query = (next.q ?? q).trim(); const status = next.active ?? active;
    if (query) params.set('q', query);
    if (status) params.set('active', status);
    try { setItems((await api<ListResponse<CstCorrelation>>(`/fiscal-registry/cst-map?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar correlações'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(item: CstCorrelation | 'new') {
    setNotice(null); setEditing(item);
    setForm(item === 'new' ? emptyForm : { outCst: item.outCst, inCst: item.inCst, description: item.description ?? '', active: item.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ ...form, description: form.description || null });
    try {
      if (editing === 'new') await api('/fiscal-registry/cst-map', { method: 'POST', body }); else await api(`/fiscal-registry/cst-map/${editing!.id}`, { method: 'PATCH', body });
      ok('Correlação salva.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar correlação'); } finally { setSaving(false); }
  }
  async function toggle(item: CstCorrelation) {
    try { await api(`/fiscal-registry/cst-map/${item.id}`, { method: 'PATCH', body: JSON.stringify({ active: !item.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar correlação'); }
  }
  async function remove(item: CstCorrelation) {
    if (!window.confirm(`Excluir a correlação CST ${item.outCst} → ${item.inCst}?`)) return;
    try { await api(`/fiscal-registry/cst-map/${item.id}`, { method: 'DELETE' }); ok('Correlação excluída.'); await load(); } catch (e) { fail(e, 'Erro ao excluir correlação'); }
  }
  const cstInput = (value: string) => value.replace(/\D/g, '').slice(0, 3);

  return <AppShell title="Correlação CST ICMS x Entrada">
    <PageHeader title="Correlação CST ICMS x Entrada" subtitle="Defina qual CST/CSOSN de entrada corresponde ao CST de saída do fornecedor. Apenas armazena a tabela de equivalência; o lançamento fiscal continua sendo conferido pelo contador." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? 'Nova correlação' : 'Editar correlação'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-4">
        <Field label="CST/CSOSN de saída (fornecedor)" required inputMode="numeric" pattern="\d{2,3}" value={form.outCst} onChange={e => setForm({ ...form, outCst: cstInput(e.target.value) })} />
        <Field label="CST/CSOSN de entrada" required inputMode="numeric" pattern="\d{2,3}" value={form.inCst} onChange={e => setForm({ ...form, inCst: cstInput(e.target.value) })} />
        <div className="md:col-span-2"><Field label="Observações" maxLength={255} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
      </div>
      <Toggle label="Ativa" checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="CST ou observação" />
    {loaded && items.length === 0 ? <EmptyState icon="🔁" title="Não há registros" hint="Adicione a primeira correlação (ex.: saída 00 → entrada 90)." /> :
      <DataTable columns={[{ label: 'CST de saída' }, { label: 'CST de entrada' }, { label: 'Observações' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(item => <tr key={item.id}>
          <td className="font-medium text-slate-900">{item.outCst}</td><td>{item.inCst}</td><td>{item.description || '—'}</td><td><ActiveBadge active={item.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(item)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(item)}>{item.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(item)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
