'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import type { DeleteResult } from '../../lib/types-registry';
import { directionLabel, finalityLabel, type OperationNature } from '../../lib/types-fiscal';

const emptyForm = { name: '', cfop: '', direction: 'OUT', finality: 'NORMAL', description: '', active: true };

export default function NaturesPage() {
  const [items, setItems] = useState<OperationNature[]>([]);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<OperationNature | 'new' | null>(null);
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
    try { setItems((await api<ListResponse<OperationNature>>(`/fiscal-registry/natures?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar naturezas de operação'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(nature: OperationNature | 'new') {
    setNotice(null); setEditing(nature);
    setForm(nature === 'new' ? emptyForm : { name: nature.name, cfop: nature.cfop, direction: nature.direction, finality: nature.finality, description: nature.description ?? '', active: nature.active });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ ...form, description: form.description || null });
    try {
      if (editing === 'new') await api('/fiscal-registry/natures', { method: 'POST', body }); else await api(`/fiscal-registry/natures/${editing!.id}`, { method: 'PATCH', body });
      ok('Natureza de operação salva.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar natureza de operação'); } finally { setSaving(false); }
  }
  async function toggle(nature: OperationNature) {
    try { await api(`/fiscal-registry/natures/${nature.id}`, { method: 'PATCH', body: JSON.stringify({ active: !nature.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar natureza'); }
  }
  async function remove(nature: OperationNature) {
    if (!window.confirm(`Excluir a natureza ${nature.name}? Se já estiver em notas, será apenas desativada.`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/fiscal-registry/natures/${nature.id}`, { method: 'DELETE' }), 'Natureza de operação')); await load(); } catch (e) { fail(e, 'Erro ao excluir natureza'); }
  }

  return <AppShell title="Naturezas de operação">
    <PageHeader title="Naturezas de operação" subtitle="Cadastre os tipos de operação (CFOP) usados nas notas de entrada e saída. Este cadastro apenas armazena parâmetros; não transmite nada à SEFAZ." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? 'Nova natureza de operação' : 'Editar natureza de operação'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="md:col-span-2"><Field label="Descrição da natureza" required minLength={2} maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></div>
        <Field label="CFOP" required inputMode="numeric" pattern="\d{4}" maxLength={4} placeholder="5102" value={form.cfop} onChange={e => setForm({ ...form, cfop: e.target.value.replace(/\D/g, '') })} />
        <Select label="Tipo" value={form.direction} onChange={e => setForm({ ...form, direction: e.target.value })}><option value="OUT">Saída</option><option value="IN">Entrada</option></Select>
        <Select label="Finalidade" value={form.finality} onChange={e => setForm({ ...form, finality: e.target.value })}>{Object.entries(finalityLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <div className="md:col-span-3"><Field label="Observações" maxLength={255} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
      </div>
      <Toggle label="Ativa" hint="Naturezas inativas não aparecem na entrada de notas." checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Descrição ou CFOP" />
    {loaded && items.length === 0 ? <EmptyState icon="📑" title="Não há registros" hint="Adicione a primeira natureza de operação (ex.: Compra para revenda — CFOP 1102)." /> :
      <DataTable columns={[{ label: 'Natureza' }, { label: 'CFOP' }, { label: 'Tipo' }, { label: 'Finalidade' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(nature => <tr key={nature.id}>
          <td className="font-medium text-slate-900">{nature.name}{nature.description && <span className="block text-xs font-normal text-slate-500">{nature.description}</span>}</td>
          <td>{nature.cfop}</td><td><Badge tone={nature.direction === 'IN' ? 'blue' : 'neutral'}>{directionLabel[nature.direction]}</Badge></td><td>{finalityLabel[nature.finality]}</td><td><ActiveBadge active={nature.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(nature)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(nature)}>{nature.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(nature)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
