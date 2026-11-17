'use client';

import { useState } from 'react';
import { api, errorMessage, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, Select, Check, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Toggle } from '../../components/ui';
import { ActiveBadge, deleteMessage, FormCard, SearchBar } from '../../components/registry-ui';
import { paymentEquivalentLabels, type DeleteResult, type PaymentEquivalent, type PaymentMethodConfig } from '../../lib/types-registry';

const emptyForm = { name: '', equivalent: 'OTHER' as PaymentEquivalent, active: true, showLocal: true, showStore: true, showApp: true, allowChange: false, requireDocument: false, sortOrder: '0' };

export default function PaymentMethodsPage() {
  const [items, setItems] = useState<PaymentMethodConfig[]>([]);
  const [q, setQ] = useState(''); const [active, setActive] = useState('');
  const [editing, setEditing] = useState<PaymentMethodConfig | 'new' | null>(null);
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
    try { setItems((await api<ListResponse<PaymentMethodConfig>>(`/payment-methods?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar formas de pagamento'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  function open(method: PaymentMethodConfig | 'new') {
    setNotice(null); setEditing(method);
    setForm(method === 'new' ? emptyForm : { name: method.name, equivalent: method.equivalent, active: method.active, showLocal: method.showLocal, showStore: method.showStore, showApp: method.showApp, allowChange: method.allowChange, requireDocument: method.requireDocument, sortOrder: String(method.sortOrder) });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setSaving(true);
    const body = JSON.stringify({ ...form, sortOrder: Number(form.sortOrder) || 0 });
    try {
      if (editing === 'new') await api('/payment-methods', { method: 'POST', body }); else await api(`/payment-methods/${editing!.id}`, { method: 'PATCH', body });
      ok('Forma de pagamento salva.'); setEditing(null); await load();
    } catch (e) { fail(e, 'Erro ao salvar forma de pagamento'); } finally { setSaving(false); }
  }
  async function toggle(method: PaymentMethodConfig) {
    try { await api(`/payment-methods/${method.id}`, { method: 'PATCH', body: JSON.stringify({ active: !method.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar forma de pagamento'); }
  }
  async function remove(method: PaymentMethodConfig) {
    if (!window.confirm(`Excluir a forma de pagamento ${method.name}? Pagamentos já registrados não são afetados.`)) return;
    try { ok(deleteMessage(await api<DeleteResult>(`/payment-methods/${method.id}`, { method: 'DELETE' }), 'Forma de pagamento')); await load(); } catch (e) { fail(e, 'Erro ao excluir forma de pagamento'); }
  }
  async function createDefaults() {
    try { const result = await api<{ created: number }>('/payment-methods/defaults', { method: 'POST' }); ok(`${result.created} forma(s) padrão cadastrada(s).`); await load(); } catch (e) { fail(e, 'Erro ao cadastrar formas padrão'); }
  }

  return <AppShell title="Formas de pagamento">
    <PageHeader title="Formas de pagamento" subtitle="Defina os nomes exibidos no caixa, na loja e no app. A forma equivalente indica como o pagamento é registrado." actions={<button className={buttonClass} onClick={() => open('new')}>Adicionar</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {editing && <FormCard title={editing === 'new' ? 'Nova forma de pagamento' : 'Editar forma de pagamento'} onSubmit={save} onCancel={() => setEditing(null)} saving={saving}>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Nome" required minLength={2} maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Select label="Forma equivalente" value={form.equivalent} onChange={e => setForm({ ...form, equivalent: e.target.value as PaymentEquivalent })}>{Object.entries(paymentEquivalentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Field label="Ordem de exibição" type="number" min="0" max="9999" step="1" value={form.sortOrder} onChange={e => setForm({ ...form, sortOrder: e.target.value })} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Toggle label="Ativo" checked={form.active} onChange={value => setForm({ ...form, active: value })} />
        <Toggle label="Mostrar no atendimento local" hint="Caixa, mesas e comandas." checked={form.showLocal} onChange={value => setForm({ ...form, showLocal: value })} />
        <Toggle label="Mostrar na loja" hint="Cardápio online / loja virtual." checked={form.showStore} onChange={value => setForm({ ...form, showStore: value })} />
        <Toggle label="Mostrar no app" checked={form.showApp} onChange={value => setForm({ ...form, showApp: value })} />
      </div>
      <div className="flex flex-wrap gap-6">
        <Check label="Permitir troco" checked={form.allowChange} onChange={e => setForm({ ...form, allowChange: e.target.checked })} />
        <Check label="Obrigar CPF/CNPJ" checked={form.requireDocument} onChange={e => setForm({ ...form, requireDocument: e.target.checked })} />
      </div>
    </FormCard>}
    <SearchBar q={q} onQ={setQ} active={active} onActive={value => { setActive(value); void load({ active: value }); }} onSubmit={() => void load()} placeholder="Nome da forma de pagamento" />
    {loaded && items.length === 0 ? <EmptyState icon="💳" title="Não há registros" hint="Sem cadastro, o sistema usa as formas padrão (Dinheiro, PIX, cartões, Vale e Outro). Cadastre-as para personalizar nomes e visibilidade." action={<button className={buttonClass} onClick={() => void createDefaults()}>Cadastrar formas padrão</button>} /> :
      <DataTable columns={[{ label: 'Nome' }, { label: 'Equivalente' }, { label: 'Exibição' }, { label: 'Opções' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} registro(s)`}>
        {items.map(method => <tr key={method.id}>
          <td className="font-medium text-slate-900">{method.name}</td><td>{paymentEquivalentLabels[method.equivalent]}</td>
          <td><div className="flex flex-wrap gap-1">{method.showLocal && <Badge tone="blue">Local</Badge>}{method.showStore && <Badge tone="blue">Loja</Badge>}{method.showApp && <Badge tone="blue">App</Badge>}{!method.showLocal && !method.showStore && !method.showApp && '—'}</div></td>
          <td><div className="flex flex-wrap gap-1">{method.allowChange && <Badge tone="gold">Troco</Badge>}{method.requireDocument && <Badge tone="amber">CPF/CNPJ</Badge>}{!method.allowChange && !method.requireDocument && '—'}</div></td>
          <td><ActiveBadge active={method.active} /></td>
          <td><div className="flex flex-wrap justify-end gap-2"><button className={secondaryButtonClass} onClick={() => open(method)}>Editar</button><button className={secondaryButtonClass} onClick={() => void toggle(method)}>{method.active ? 'Desativar' : 'Ativar'}</button><button className={secondaryButtonClass} onClick={() => void remove(method)}>Excluir</button></div></td>
        </tr>)}
      </DataTable>}
  </AppShell>;
}
