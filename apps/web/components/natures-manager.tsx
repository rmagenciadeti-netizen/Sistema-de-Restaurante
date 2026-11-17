'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse } from '../lib/api';
import { useAutoLoad } from '../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, secondaryButtonClass, Select } from './app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Toggle } from './ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from './registry-ui';
import type { DeleteResult } from '../lib/types-registry';
import { destinationLabel, directionLabel, finalityLabel, operationLabel, type NatureDestination, type NatureOperation, type OperationNature } from '../lib/types-fiscal';
import type { TaxRule } from '../lib/types-registry';

const emptyForm = { name: '', cfop: '', direction: 'OUT', finality: 'NORMAL', description: '', active: true, operation: 'SALE' as NatureOperation, destination: 'ANY' as NatureDestination, ufOrigin: '', ufDestination: '', taxRegime: '', taxRuleId: '' };
const regimes = { SIMPLES_NACIONAL: 'Simples Nacional', SIMPLES_EXCESSO: 'Simples — excesso de sublimite', NORMAL: 'Regime Normal', MEI: 'MEI' };

// Operation natures with their CFOP application rules. Used by /natures and by Configurações → Fiscais.
export function NaturesManager({ embedded = false }: { embedded?: boolean }) {
  const [items, setItems] = useState<OperationNature[]>([]);
  const [rules, setRules] = useState<TaxRule[]>([]);
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
  useAutoLoad(async () => { await load(); try { setRules((await api<ListResponse<TaxRule>>('/tax-rules')).items.filter(rule => rule.active)); } catch { setRules([]); } });

  function open(nature: OperationNature | 'new') {
    setNotice(null); setEditing(nature);
    setForm(nature === 'new' ? emptyForm : { name: nature.name, cfop: nature.cfop, direction: nature.direction, finality: nature.finality, description: nature.description ?? '', active: nature.active, operation: nature.operation ?? 'SALE', destination: nature.destination ?? 'ANY', ufOrigin: nature.ufOrigin ?? '', ufDestination: nature.ufDestination ?? '', taxRegime: nature.taxRegime ?? '', taxRuleId: nature.taxRuleId ?? '' });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ ...form, description: form.description || null, ufOrigin: form.ufOrigin || null, ufDestination: form.ufDestination || null, taxRegime: form.taxRegime || null, taxRuleId: form.taxRuleId || null });
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

  const content = <>
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
      <h4 className="mt-4 text-sm font-semibold text-slate-800">Regra de aplicação nas notas fiscais</h4>
      <p className="mb-2 text-xs text-slate-500">Na emissão, a natureza informada na nota só aplica este CFOP quando todos os critérios abaixo combinam com a operação (campos vazios não restringem).</p>
      <div className="grid gap-4 md:grid-cols-4">
        <Select label="Operação" value={form.operation} onChange={e => setForm({ ...form, operation: e.target.value as NatureOperation })}>{Object.entries(operationLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Select label="Destino" value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value as NatureDestination })}>{Object.entries(destinationLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <Field label="UF do emitente" maxLength={2} placeholder="MT" value={form.ufOrigin} onChange={e => setForm({ ...form, ufOrigin: e.target.value.toUpperCase() })} />
        <Field label="UF do destinatário" maxLength={2} placeholder="SP" value={form.ufDestination} onChange={e => setForm({ ...form, ufDestination: e.target.value.toUpperCase() })} />
        <Select label="Regime tributário" value={form.taxRegime} onChange={e => setForm({ ...form, taxRegime: e.target.value })}><option value="">Qualquer</option>{Object.entries(regimes).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
        <div className="md:col-span-3"><Select label="Regra tributária da natureza" value={form.taxRuleId} onChange={e => setForm({ ...form, taxRuleId: e.target.value })}><option value="">Nenhuma</option>{rules.map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</Select></div>
      </div>
      <Toggle label="Ativa" hint="Naturezas inativas não aparecem na entrada de notas." checked={form.active} onChange={value => setForm({ ...form, active: value })} />
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Descrição ou CFOP" />
    {loaded && items.length === 0 ? <EmptyState icon="📑" title="Não há registros" hint="Adicione a primeira natureza de operação (ex.: Compra para revenda — CFOP 1102)." /> :
      <DataTable columns={[{ label: 'Natureza' }, { label: 'CFOP' }, { label: 'Tipo' }, { label: 'Finalidade' }, { label: 'Aplicação' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(nature => <tr key={nature.id}>
          <td className="font-medium text-slate-900">{nature.name}{nature.description && <span className="block text-xs font-normal text-slate-500">{nature.description}</span>}</td>
          <td>{nature.cfop}</td><td><Badge tone={nature.direction === 'IN' ? 'blue' : 'neutral'}>{directionLabel[nature.direction]}</Badge></td><td>{finalityLabel[nature.finality]}</td><td className="text-xs text-slate-600">{operationLabel[nature.operation ?? 'SALE']} · {destinationLabel[nature.destination ?? 'ANY']}{nature.ufDestination ? ` · ${nature.ufDestination}` : ''}</td><td><ActiveBadge active={nature.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(nature)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(nature)}>{nature.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(nature)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </>;
  return embedded ? content : <AppShell title="Naturezas de operação">{content}</AppShell>;
}
