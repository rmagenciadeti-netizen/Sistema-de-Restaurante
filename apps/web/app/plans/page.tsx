'use client';

import { useCallback, useMemo, useState } from 'react';
import { useAutoLoad } from '../../lib/use-auto-load';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, textareaClass } from '../../components/ui';
import { periodLabels, ReasonDialog, Section, statusLabels, statusTone, type CatalogStatus, type ModuleRow, type Period, type PlanRow } from '../../components/commercial/common';

const periods = Object.keys(periodLabels) as Period[];
type Role = 'NONE' | 'INCLUDED' | 'OPTIONAL';
const fresh = () => ({
  key: '', name: '', headline: '', description: '', benefits: '', highlight: '', displayOrder: '0', status: 'DRAFT' as CatalogStatus, trialDays: '0', maxUnits: '', maxUsers: '',
  activationFee: '0', setupFee: '0', originalPrice: '', promoPrice: '', conditions: '', reason: '',
  roles: {} as Record<string, Role>, overrides: {} as Record<string, string>, prices: Object.fromEntries(periods.map(period => [period, ''])) as Record<Period, string>,
});
type Pending = { plan: PlanRow; status: CatalogStatus };
type Snapshot = { prices?: { period: Period; amount: string | number }[]; status?: string } | string | null;
type HistoryItem = { id: string; action: string; createdAt: string; actor: { name: string } | null; metadata: { before?: Snapshot; after?: Snapshot; reason?: string } | null };
const actionLabels: Record<string, string> = { SAAS_PLAN_CREATED: 'Plano criado', SAAS_PLAN_UPDATED: 'Plano alterado', SAAS_PLAN_STATUS_CHANGED: 'Situação alterada' };
const priceText = (snapshot?: Snapshot) => (snapshot && typeof snapshot === 'object' && snapshot.prices?.length ? snapshot.prices.map(price => `${periodLabels[price.period]} ${formatMoney(price.amount)}`).join(' · ') : '—');

export default function PlansPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [catalog, setCatalog] = useState<ModuleRow[]>([]);
  const [form, setForm] = useState(fresh);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [view, setView] = useState<'list' | 'compare'>('list');
  const [history, setHistory] = useState<{ plan: PlanRow; items: HistoryItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    try {
      const [planList, moduleList] = await Promise.all([api<{ items: PlanRow[] }>('/plans'), api<{ items: ModuleRow[] }>('/commercial/modules')]);
      setPlans(planList.items); setCatalog(moduleList.items);
    } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Falha ao carregar os planos')); }
  }, []);
  useAutoLoad(load);

  const sellable = useMemo(() => catalog.filter(item => item.featureLinked && item.status !== 'ARCHIVED'), [catalog]);
  const byKey = useMemo(() => new Map(catalog.map(item => [item.key, item])), [catalog]);
  const included = sellable.filter(item => form.roles[item.key] === 'INCLUDED');
  const optional = sellable.filter(item => form.roles[item.key] === 'OPTIONAL');
  const optionalPrice = (item: ModuleRow) => (form.overrides[item.key] !== undefined && form.overrides[item.key] !== '' ? Number(form.overrides[item.key]) : Number(item.monthlyPrice));
  const dependencyProblems = included.flatMap(item => item.dependsOn.filter(key => form.roles[key] !== 'INCLUDED').map(key => `${item.name} depende de ${byKey.get(key)?.name ?? key}`));

  function edit(plan: PlanRow) {
    setEditing(plan.id);
    setForm({
      key: plan.key, name: plan.name, headline: plan.headline ?? '', description: plan.description ?? '', benefits: plan.benefits.join('\n'), highlight: plan.highlight ?? '', displayOrder: String(plan.displayOrder), status: plan.status,
      trialDays: String(plan.trialDays), maxUnits: plan.maxUnits?.toString() ?? '', maxUsers: plan.maxUsers?.toString() ?? '', activationFee: String(plan.activationFee), setupFee: String(plan.setupFee),
      originalPrice: plan.originalPrice === null ? '' : String(plan.originalPrice), promoPrice: plan.promoPrice === null ? '' : String(plan.promoPrice), conditions: plan.conditions ?? '', reason: '',
      roles: { ...Object.fromEntries(plan.modules.map(key => [key, 'INCLUDED'])), ...Object.fromEntries(plan.optionalModules.map(item => [item.key, 'OPTIONAL'])) } as Record<string, Role>,
      overrides: Object.fromEntries(plan.optionalModules.filter(item => item.priceOverride !== null).map(item => [item.key, String(item.priceOverride)])),
      prices: Object.fromEntries(periods.map(period => [period, String(plan.prices.find(price => price.period === period)?.amount ?? '')])) as Record<Period, string>,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function save(event: React.FormEvent, status?: CatalogStatus) {
    event.preventDefault(); setBusy(true); setMessage('');
    const body = {
      key: form.key, name: form.name, headline: form.headline || null, description: form.description || null, benefits: form.benefits.split('\n').map(line => line.trim()).filter(Boolean),
      highlight: form.highlight || null, displayOrder: Number(form.displayOrder), status: status ?? form.status, trialDays: Number(form.trialDays),
      maxUnits: form.maxUnits ? Number(form.maxUnits) : null, maxUsers: form.maxUsers ? Number(form.maxUsers) : null, activationFee: Number(form.activationFee), setupFee: Number(form.setupFee),
      originalPrice: form.originalPrice ? Number(form.originalPrice) : null, promoPrice: form.promoPrice ? Number(form.promoPrice) : null, conditions: form.conditions || null, reason: form.reason || undefined,
      modules: included.map(item => item.key),
      optionalModules: optional.map(item => ({ key: item.key, priceOverride: form.overrides[item.key] ? Number(form.overrides[item.key]) : null })),
      prices: periods.filter(period => form.prices[period] !== '').map(period => ({ period, amount: Number(form.prices[period]) })),
    };
    try {
      await api(editing ? `/plans/${editing}` : '/plans', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setSuccess(true); setMessage(`Plano ${body.status === 'ACTIVE' ? 'publicado' : 'salvo'}. Contratos já vinculados não são alterados retroativamente.`);
      setEditing(null); setForm(fresh()); await load();
    } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Falha ao salvar o plano')); } finally { setBusy(false); }
  }
  async function openHistory(plan: PlanRow) {
    try { const result = await api<{ items: HistoryItem[] }>(`/plans/${plan.id}/history`); setHistory({ plan, items: result.items }); } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao carregar o histórico')); }
  }
  async function duplicate(plan: PlanRow) {
    const key = `${plan.key}-copia-${Date.now().toString(36).slice(-4)}`;
    try { await api(`/plans/${plan.id}/duplicate`, { method: 'POST', body: JSON.stringify({ key, name: `${plan.name} (cópia)` }) }); setSuccess(true); setMessage(`Cópia em rascunho criada: ${key}.`); await load(); } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Falha ao duplicar o plano')); }
  }
  async function changeStatus(reason: string) {
    if (!pending) return;
    try { await api(`/plans/${pending.plan.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: pending.status, reason }) }); setSuccess(true); setMessage(`Plano ${pending.plan.name}: ${statusLabels[pending.status].toLowerCase()}.`); } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Falha ao alterar o plano')); }
    setPending(null); await load();
  }

  const monthly = form.prices.MONTHLY ? Number(form.prices.MONTHLY) : null;
  const shown = [...plans].sort((a, b) => a.displayOrder - b.displayOrder);
  return <AppShell title="Planos e montador">
    <PageHeader title="Planos comerciais" subtitle="Monte cada plano escolhendo módulos incluídos e opcionais, limites e preços. Nomes, preços e limites ficam no banco, sem alterar código." />
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_340px]">
      <form onSubmit={event => void save(event)} className={`${panelClass} space-y-5`}>
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{editing ? 'Editar plano' : 'Novo plano comercial'}</h2>{editing && <button type="button" className={secondaryButtonClass} onClick={() => { setEditing(null); setForm(fresh()); }}>Cancelar edição</button>}</div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Identificador interno" required disabled={Boolean(editing)} value={form.key} onChange={event => setForm({ ...form, key: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
          <Field label="Nome comercial" required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
          <Select label="Situação" value={form.status} onChange={event => setForm({ ...form, status: event.target.value as CatalogStatus })}>{(['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const).map(value => <option key={value} value={value}>{statusLabels[value]}</option>)}</Select>
          <Field label="Destaque (ex.: Mais vendido)" maxLength={40} value={form.highlight} onChange={event => setForm({ ...form, highlight: event.target.value })} />
          <Field label="Texto de apresentação" maxLength={200} value={form.headline} onChange={event => setForm({ ...form, headline: event.target.value })} />
          <Field label="Ordem de exibição" type="number" min={0} value={form.displayOrder} onChange={event => setForm({ ...form, displayOrder: event.target.value })} />
          <Field label="Dias de teste gratuito" type="number" min={0} value={form.trialDays} onChange={event => setForm({ ...form, trialDays: event.target.value })} />
          <Field label="Limite de unidades (vazio = ilimitado)" type="number" min={1} value={form.maxUnits} onChange={event => setForm({ ...form, maxUnits: event.target.value })} />
          <Field label="Limite de usuários (vazio = ilimitado)" type="number" min={1} value={form.maxUsers} onChange={event => setForm({ ...form, maxUsers: event.target.value })} />
          <Field label="Taxa de ativação (R$)" type="number" min={0} step="0.01" value={form.activationFee} onChange={event => setForm({ ...form, activationFee: event.target.value })} />
          <Field label="Taxa de implantação (R$)" type="number" min={0} step="0.01" value={form.setupFee} onChange={event => setForm({ ...form, setupFee: event.target.value })} />
          <Field label="Preço original de vitrine (R$)" type="number" min={0} step="0.01" value={form.originalPrice} onChange={event => setForm({ ...form, originalPrice: event.target.value })} />
          <Field label="Preço promocional de vitrine (R$)" type="number" min={0} step="0.01" value={form.promoPrice} onChange={event => setForm({ ...form, promoPrice: event.target.value })} />
        </div>
        <label className="block text-sm font-medium text-slate-700">Descrição<textarea className={textareaClass} rows={2} maxLength={1000} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></label>
        <label className="block text-sm font-medium text-slate-700">Benefícios e diferenciais (um por linha)<textarea className={textareaClass} rows={3} value={form.benefits} onChange={event => setForm({ ...form, benefits: event.target.value })} /></label>
        <label className="block text-sm font-medium text-slate-700">Regras e condições especiais<textarea className={textareaClass} rows={2} maxLength={1000} value={form.conditions} onChange={event => setForm({ ...form, conditions: event.target.value })} /></label>
        <fieldset><legend className="mb-2 text-sm font-semibold">Preços recorrentes (R$) — vazio = periodicidade indisponível</legend><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {periods.map(period => <Field key={period} label={periodLabels[period]} type="number" min={0} step="0.01" value={form.prices[period]} onChange={event => setForm({ ...form, prices: { ...form.prices, [period]: event.target.value } })} />)}
        </div></fieldset>
        <fieldset>
          <legend className="mb-2 text-sm font-semibold">Módulos do plano</legend>
          <div className="grid gap-2 lg:grid-cols-2">
            {catalog.filter(item => item.status !== 'ARCHIVED').map(item => <div key={item.key} className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-sm ${item.featureLinked ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50 opacity-70'}`}>
              <span className="min-w-0"><span className="font-medium">{item.icon} {item.name}</span>{!item.featureLinked && <span className="block text-xs text-slate-500">Não implementado — indisponível para venda</span>}{item.blocked && <span className="block text-xs text-red-700">Bloqueado globalmente</span>}</span>
              <span className="flex shrink-0 items-center gap-2">
                {form.roles[item.key] === 'OPTIONAL' && <input aria-label={`Preço do módulo ${item.name} neste plano`} title="Preço neste plano (vazio = preço do catálogo; 0 = gratuito)" type="number" min={0} step="0.01" placeholder={String(item.monthlyPrice)} className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-xs" value={form.overrides[item.key] ?? ''} onChange={event => setForm({ ...form, overrides: { ...form.overrides, [item.key]: event.target.value } })} />}
                <select disabled={!item.featureLinked} aria-label={`Papel do módulo ${item.name}`} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={form.roles[item.key] ?? 'NONE'} onChange={event => setForm({ ...form, roles: { ...form.roles, [item.key]: event.target.value as Role } })}><option value="NONE">Fora</option><option value="INCLUDED">Incluído</option><option value="OPTIONAL">Opcional</option></select>
              </span>
            </div>)}
          </div>
          {dependencyProblems.length > 0 && <p role="alert" className="mt-2 text-sm text-red-700">Dependências ausentes: {dependencyProblems.join('; ')}.</p>}
        </fieldset>
        <Field label="Motivo da alteração (auditoria, opcional)" value={form.reason} maxLength={300} onChange={event => setForm({ ...form, reason: event.target.value })} />
        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} disabled={busy || !form.key || !form.name} onClick={event => void save(event as unknown as React.FormEvent, 'DRAFT')}>Salvar como rascunho</button>
          <button className={buttonClass} disabled={busy || dependencyProblems.length > 0}>{busy ? 'Salvando...' : editing ? 'Salvar alterações' : 'Criar plano'}</button>
          <button type="button" className={buttonClass} disabled={busy || dependencyProblems.length > 0 || monthly === null && !periods.some(period => form.prices[period])} onClick={event => void save(event as unknown as React.FormEvent, 'ACTIVE')}>Publicar</button>
        </div>
      </form>
      <aside className="rm-surface h-fit rounded-2xl border border-neutral-800 bg-neutral-950 p-5 text-white shadow-lg xl:sticky xl:top-20" aria-label="Prévia do plano">
        <p className="text-[10px] uppercase tracking-[0.2em] text-brand-300">Prévia antes de publicar</p>
        <div className="mt-3 flex items-center gap-2"><h3 className="font-serif text-2xl font-bold text-brand-300">{form.name || 'Nome do plano'}</h3>{form.highlight && <span className="rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-neutral-950">{form.highlight}</span>}</div>
        {form.headline && <p className="mt-1 text-sm text-neutral-300">{form.headline}</p>}
        <p className="mt-4 text-3xl font-bold">{monthly === null ? '—' : formatMoney(form.promoPrice ? Number(form.promoPrice) : monthly)}<span className="text-sm font-normal text-neutral-400">/mês</span></p>
        {(form.originalPrice || (form.promoPrice && monthly !== null)) && <p className="text-sm text-neutral-400 line-through">{formatMoney(form.originalPrice || monthly)}</p>}
        <div className="mt-1 space-y-0.5 text-xs text-neutral-400">{periods.filter(period => period !== 'MONTHLY' && form.prices[period]).map(period => <p key={period}>{periodLabels[period]}: {formatMoney(form.prices[period])}</p>)}</div>
        <p className="mt-3 text-xs text-neutral-300">Limites: {form.maxUnits || '∞'} unidade(s) · {form.maxUsers || '∞'} usuário(s) · teste de {form.trialDays || 0} dia(s)</p>
        <h4 className="mt-4 text-xs font-semibold uppercase tracking-wider text-brand-300">Incluídos ({included.length})</h4>
        <ul className="mt-1 space-y-0.5 text-sm">{included.map(item => <li key={item.key}>✓ {item.name}</li>)}{included.length === 0 && <li className="text-neutral-500">Nenhum módulo selecionado</li>}</ul>
        {optional.length > 0 && <><h4 className="mt-4 text-xs font-semibold uppercase tracking-wider text-brand-300">Opcionais</h4><ul className="mt-1 space-y-0.5 text-sm">{optional.map(item => <li key={item.key}>+ {item.name} — {optionalPrice(item) === 0 ? 'gratuito' : `${formatMoney(optionalPrice(item))}/mês`}</li>)}</ul></>}
        {form.benefits.trim() && <ul className="mt-4 space-y-0.5 border-t border-white/10 pt-3 text-sm text-neutral-300">{form.benefits.split('\n').filter(Boolean).map((line, index) => <li key={index}>• {line}</li>)}</ul>}
      </aside>
    </div>
    <Section title={`Planos cadastrados (${plans.length})`} actions={<><button type="button" className={secondaryButtonClass} aria-pressed={view === 'list'} onClick={() => setView('list')}>Lista</button><button type="button" className={secondaryButtonClass} aria-pressed={view === 'compare'} onClick={() => setView('compare')}>Comparar planos</button></>}>
      {plans.length === 0 ? <EmptyState icon="💎" title="Nenhum plano criado" /> : view === 'list'
        ? <DataTable columns={[{ label: 'Plano' }, { label: 'Situação' }, { label: 'Limites' }, { label: 'Preços' }, { label: 'Módulos' }, { label: 'Clientes' }, { label: 'Ações' }]}>
          {shown.map(plan => <tr key={plan.id} className="align-top">
            <td><strong>{plan.name}</strong>{plan.highlight && <span className="ml-2"><Badge tone="gold">{plan.highlight}</Badge></span>}<div className="text-xs text-slate-500">{plan.key}</div></td>
            <td><Badge tone={statusTone(plan.status)}>{statusLabels[plan.status]}</Badge></td>
            <td className="text-xs">{plan.maxUnits ?? '∞'} unid. · {plan.maxUsers ?? '∞'} usuários<div>Teste: {plan.trialDays} dia(s)</div></td>
            <td className="text-xs">{plan.prices.length === 0 ? 'Sem preço' : plan.prices.map(price => <div key={price.period}>{periodLabels[price.period]}: {formatMoney(price.amount)}</div>)}</td>
            <td className="text-xs">{plan.modules.length} incluídos{plan.optionalModules.length > 0 && ` · ${plan.optionalModules.length} opcionais`}</td>
            <td>{plan._count?.licenses ?? 0}</td>
            <td><div className="flex flex-wrap gap-1">
              <button type="button" className={secondaryButtonClass} onClick={() => edit(plan)}>Editar</button>
              <button type="button" className={secondaryButtonClass} onClick={() => void duplicate(plan)}>Duplicar</button>
              <button type="button" className={secondaryButtonClass} onClick={() => void openHistory(plan)}>Histórico</button>
              {plan.status !== 'ACTIVE' && plan.status !== 'ARCHIVED' && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ plan, status: 'ACTIVE' })}>Publicar</button>}
              {plan.status === 'ACTIVE' && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ plan, status: 'INACTIVE' })}>Desativar</button>}
              {plan.status !== 'ARCHIVED' && <button type="button" className={secondaryButtonClass} onClick={() => setPending({ plan, status: 'ARCHIVED' })}>Arquivar</button>}
            </div></td>
          </tr>)}
        </DataTable>
        : <DataTable columns={[{ label: 'Módulo' }, ...shown.map(plan => ({ label: plan.name }))]}>
          <tr><td className="font-semibold">Preço mensal</td>{shown.map(plan => <td key={plan.id}>{plan.prices.find(price => price.period === 'MONTHLY') ? formatMoney(plan.prices.find(price => price.period === 'MONTHLY')!.amount) : '—'}</td>)}</tr>
          {sellable.map(item => <tr key={item.key}><td>{item.name}</td>{shown.map(plan => <td key={plan.id}>{plan.modules.includes(item.key) ? '✓ Incluído' : plan.optionalModules.some(option => option.key === item.key) ? '+ Opcional' : '—'}</td>)}</tr>)}
        </DataTable>}
    </Section>
    {history && <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4" onClick={() => setHistory(null)}>
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={event => event.stopPropagation()}>
        <h2 className="text-lg font-bold">Histórico de versões: {history.plan.name}</h2>
        <p className="text-xs text-slate-500">Contratos existentes mantêm o preço e os módulos contratados; alterações valem para novas contratações.</p>
        {history.items.length === 0 && <p className="mt-3 text-sm text-slate-500">Sem alterações registradas.</p>}
        <ul className="mt-3 space-y-3">{history.items.map(item => <li key={item.id} className="rounded-xl border border-slate-200 p-3 text-sm">
          <div className="flex justify-between gap-2"><strong>{actionLabels[item.action] ?? item.action}</strong><span className="text-xs text-slate-500">{formatDateTime(item.createdAt)} · {item.actor?.name ?? 'Sistema'}</span></div>
          {item.metadata?.reason && <div className="text-xs text-slate-600">Motivo: {item.metadata.reason}</div>}
          {item.action === 'SAAS_PLAN_UPDATED' && <div className="mt-1 text-xs"><div>Antes: {priceText(item.metadata?.before)}</div><div>Depois: {priceText(item.metadata?.after)}</div></div>}
        </li>)}</ul>
        <button type="button" className={`${secondaryButtonClass} mt-4`} onClick={() => setHistory(null)}>Fechar</button>
      </div>
    </div>}
    {pending && <ReasonDialog title={`${statusLabels[pending.status]}: ${pending.plan.name}`} danger={pending.status === 'ARCHIVED'} onCancel={() => setPending(null)} onConfirm={changeStatus}>
      <p className="text-sm text-slate-600">{pending.status === 'ACTIVE' ? 'O plano passa a ser oferecido para novas contratações.' : 'O plano deixa de ser oferecido; assinaturas e histórico existentes são preservados.'}</p>
    </ReasonDialog>}
  </AppShell>;
}
