'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorMessage, formatMoney } from '../../lib/api';
import { buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable, EmptyState, textareaClass } from '../ui';
import { fromDateInput, MultiPick, num, ReasonDialog, Section, statusLabels, statusTone, toDateInput, type ModuleRow } from './common';

const billingLabels = { MONTHLY: 'Mensal', ANNUAL: 'Anual', ONE_TIME: 'Valor único', FREE: 'Gratuito' } as const;
const blank = () => ({ key: '', name: '', description: '', category: 'Geral', icon: '', billing: 'MONTHLY' as ModuleRow['billing'], monthlyPrice: '0', annualPrice: '0', oneTimePrice: '0', promoPrice: '', promoStartsAt: '', promoEndsAt: '', standalone: true, dependsOn: [] as string[], status: 'ACTIVE' as ModuleRow['status'] });
type Pending = { module: ModuleRow; action: 'BLOCK' | 'UNBLOCK' | 'ACTIVATE' | 'DEACTIVATE' | 'ARCHIVE' };
const actionText = { BLOCK: 'Bloquear globalmente', UNBLOCK: 'Desbloquear', ACTIVATE: 'Ativar', DEACTIVATE: 'Desativar', ARCHIVE: 'Arquivar' };

export function ModuleCatalog() {
  const [items, setItems] = useState<ModuleRow[]>([]);
  const [form, setForm] = useState(blank);
  const [editing, setEditing] = useState<ModuleRow | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [query, setQuery] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems((await api<{ items: ModuleRow[] }>('/commercial/modules')).items); } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao carregar o catálogo')); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => items.filter(item => !query || `${item.name} ${item.key} ${item.category}`.toLowerCase().includes(query.toLowerCase())), [items, query]);
  const reset = () => { setEditing(null); setForm(blank()); };

  function edit(module: ModuleRow) {
    setEditing(module);
    setForm({ key: module.key, name: module.name, description: module.description ?? '', category: module.category, icon: module.icon ?? '', billing: module.billing, monthlyPrice: String(module.monthlyPrice), annualPrice: String(module.annualPrice), oneTimePrice: String(module.oneTimePrice), promoPrice: module.promoPrice === null ? '' : String(module.promoPrice), promoStartsAt: toDateInput(module.promoStartsAt), promoEndsAt: toDateInput(module.promoEndsAt), standalone: module.standalone, dependsOn: module.dependsOn, status: module.status });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const body = { ...form, description: form.description || null, icon: form.icon || null, monthlyPrice: Number(form.monthlyPrice), annualPrice: Number(form.annualPrice), oneTimePrice: Number(form.oneTimePrice), promoPrice: num(form.promoPrice), promoStartsAt: fromDateInput(form.promoStartsAt), promoEndsAt: fromDateInput(form.promoEndsAt) };
    try {
      await api(editing ? `/commercial/modules/${editing.id}` : '/commercial/modules', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setSuccess(true); setMessage('Módulo salvo.'); reset(); await load();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao salvar o módulo')); } finally { setBusy(false); }
  }
  async function confirm(reason: string) {
    if (!pending) return;
    try {
      await api(`/commercial/modules/${pending.module.id}/state`, { method: 'PATCH', body: JSON.stringify({ action: pending.action, reason }) });
      setSuccess(true); setMessage(`${actionText[pending.action]}: ${pending.module.name}.`); setPending(null); await load();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao alterar o módulo')); setPending(null); }
  }

  return <>
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <form onSubmit={save} className={`${panelClass} mb-6 space-y-4`}>
      <div className="flex items-center justify-between"><h2 className="text-base font-bold">{editing ? `Editar módulo — ${editing.name}` : 'Novo módulo no catálogo'}</h2>{editing && <button type="button" className={secondaryButtonClass} onClick={reset}>Cancelar edição</button>}</div>
      <p className="text-xs text-slate-500">A chave técnica precisa corresponder a uma funcionalidade real do sistema. Módulos sem funcionalidade vinculada são exibidos como “não implementado” e não podem ser vendidos em planos nem contratados.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Chave técnica" required disabled={Boolean(editing)} value={form.key} onChange={event => setForm({ ...form, key: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-') })} />
        <Field label="Nome" required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
        <Field label="Categoria" required value={form.category} onChange={event => setForm({ ...form, category: event.target.value })} />
        <Field label="Ícone (emoji)" maxLength={8} value={form.icon} onChange={event => setForm({ ...form, icon: event.target.value })} />
        <Select label="Cobrança" value={form.billing} onChange={event => setForm({ ...form, billing: event.target.value as ModuleRow['billing'] })}>{Object.entries(billingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Field label="Valor mensal (R$)" type="number" min={0} step="0.01" value={form.monthlyPrice} onChange={event => setForm({ ...form, monthlyPrice: event.target.value })} />
        <Field label="Valor anual (R$)" type="number" min={0} step="0.01" value={form.annualPrice} onChange={event => setForm({ ...form, annualPrice: event.target.value })} />
        <Field label="Valor único (R$)" type="number" min={0} step="0.01" value={form.oneTimePrice} onChange={event => setForm({ ...form, oneTimePrice: event.target.value })} />
        <Field label="Preço promocional mensal (R$)" type="number" min={0} step="0.01" value={form.promoPrice} onChange={event => setForm({ ...form, promoPrice: event.target.value })} />
        <Field label="Promoção início" type="datetime-local" value={form.promoStartsAt} onChange={event => setForm({ ...form, promoStartsAt: event.target.value })} />
        <Field label="Promoção término" type="datetime-local" value={form.promoEndsAt} onChange={event => setForm({ ...form, promoEndsAt: event.target.value })} />
        <Select label="Situação" value={form.status} onChange={event => setForm({ ...form, status: event.target.value as ModuleRow['status'] })}>{['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'].map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</Select>
      </div>
      <label className="block text-sm font-medium text-slate-700">Descrição<textarea className={textareaClass} rows={2} maxLength={500} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
      <Check label="Disponível para contratação avulsa" checked={form.standalone} onChange={event => setForm({ ...form, standalone: event.target.checked })} />
      <MultiPick label="Depende de outros módulos" options={items.filter(item => item.key !== form.key).map(item => ({ key: item.key, name: item.name }))} value={form.dependsOn} onChange={dependsOn => setForm({ ...form, dependsOn })} />
      <button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : editing ? 'Salvar módulo' : 'Criar módulo'}</button>
    </form>
    <Section title={`Catálogo de módulos (${visible.length})`} actions={<input type="search" placeholder="Buscar módulo…" value={query} onChange={event => setQuery(event.target.value)} className="rounded-xl border border-slate-300 px-3 py-2 text-sm" aria-label="Buscar módulo" />}>
      {visible.length === 0 ? <EmptyState title="Nenhum módulo encontrado" /> : <DataTable columns={[{ label: 'Módulo' }, { label: 'Situação' }, { label: 'Preço' }, { label: 'Planos' }, { label: 'Clientes' }, { label: 'Ações' }]}>
        {visible.map(module => <tr key={module.id} className="align-top">
          <td><strong>{module.icon} {module.name}</strong><div className="text-xs text-slate-500">{module.key} · {module.category}</div>{module.dependsOn.length > 0 && <div className="text-xs text-slate-500">Depende: {module.dependsOn.join(', ')}</div>}</td>
          <td className="space-y-1"><Badge tone={statusTone(module.status)}>{statusLabels[module.status]}</Badge>{module.blocked && <Badge tone="red">Bloqueado</Badge>}{!module.featureLinked && <Badge tone="neutral">Não implementado</Badge>}</td>
          <td className="text-xs">{billingLabels[module.billing]}<div>{formatMoney(module.monthlyPrice)}/mês · {formatMoney(module.annualPrice)}/ano</div>{module.promoPrice !== null && <div className="text-brand-700">Promo {formatMoney(module.promoPrice)}</div>}</td>
          <td className="text-xs">{module.plans.length === 0 ? '—' : module.plans.map(plan => `${plan.name}${plan.optional ? ' (opcional)' : ''}`).join(', ')}</td>
          <td>{module.tenants}</td>
          <td><div className="flex flex-wrap gap-1">
            <button type="button" className={secondaryButtonClass} onClick={() => edit(module)}>Editar</button>
            {module.featureLinked && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ module, action: module.blocked ? 'UNBLOCK' : 'BLOCK' })}>{module.blocked ? 'Desbloquear' : 'Bloquear'}</button>}
            {module.status !== 'ACTIVE' && module.status !== 'ARCHIVED' && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ module, action: 'ACTIVATE' })}>Ativar</button>}
            {module.status === 'ACTIVE' && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ module, action: 'DEACTIVATE' })}>Desativar</button>}
            {module.status !== 'ARCHIVED' && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ module, action: 'ARCHIVE' })}>Arquivar</button>}
          </div></td>
        </tr>)}
      </DataTable>}
    </Section>
    {pending && <ReasonDialog title={`${actionText[pending.action]}: ${pending.module.name}`} danger={pending.action === 'BLOCK' || pending.action === 'ARCHIVE'} onCancel={() => setPending(null)} onConfirm={confirm}>
      {pending.action === 'BLOCK' && <p className="text-sm text-red-700">O bloqueio global impede o acesso de todos os clientes a este módulo imediatamente. Nenhum dado é apagado.</p>}
      {(pending.action === 'DEACTIVATE' || pending.action === 'ARCHIVE') && <p className="text-sm text-slate-600">O módulo deixa de ser oferecido para novas contratações; clientes atuais mantêm o acesso e o histórico.</p>}
    </ReasonDialog>}
  </>;
}
