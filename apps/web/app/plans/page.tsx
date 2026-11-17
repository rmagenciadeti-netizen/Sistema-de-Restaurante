'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../lib/api';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';

type Module = { key: string; name: string };
type Price = { period: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUAL' | 'ANNUAL'; amount: number | string };
type Plan = { id: string; key: string; name: string; description: string | null; active: boolean; trialDays: number; maxUnits: number | null; maxUsers: number | null; activationFee: number | string; setupFee: number | string; modules: string[]; prices: Price[] };
const periods: { key: Price['period']; label: string }[] = [
  { key: 'MONTHLY', label: 'Mensal' }, { key: 'QUARTERLY', label: 'Trimestral' },
  { key: 'SEMIANNUAL', label: 'Semestral' }, { key: 'ANNUAL', label: 'Anual' },
];
const fresh = () => ({ key: '', name: '', description: '', active: true, trialDays: '0', maxUnits: '', maxUsers: '', activationFee: '0', setupFee: '0', modules: [] as string[], prices: Object.fromEntries(periods.map(period => [period.key, ''])) as Record<Price['period'], string> });

export default function PlansPage() {
  const [items, setItems] = useState<Plan[]>([]);
  const [catalog, setCatalog] = useState<Module[]>([]);
  const [form, setForm] = useState(fresh);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const load = useCallback(async () => {
    try {
      const [plans, modules] = await Promise.all([api<{ items: Plan[] }>('/plans'), api<{ items: Module[] }>('/tenants/modules/catalog')]);
      setItems(plans.items); setCatalog(modules.items);
    } catch (error) { setMessage(errorMessage(error, 'Falha ao carregar os planos')); }
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([api<{ items: Plan[] }>('/plans'), api<{ items: Module[] }>('/tenants/modules/catalog')])
      .then(([plans, modules]) => { if (active) { setItems(plans.items); setCatalog(modules.items); } })
      .catch(error => { if (active) setMessage(errorMessage(error, 'Falha ao carregar os planos')); });
    return () => { active = false; };
  }, []);

  function edit(plan: Plan) {
    setEditing(plan.id);
    setForm({
      key: plan.key, name: plan.name, description: plan.description ?? '', active: plan.active, trialDays: String(plan.trialDays),
      maxUnits: plan.maxUnits?.toString() ?? '', maxUsers: plan.maxUsers?.toString() ?? '',
      activationFee: String(plan.activationFee), setupFee: String(plan.setupFee), modules: plan.modules,
      prices: Object.fromEntries(periods.map(period => [period.key, String(plan.prices.find(price => price.period === period.key)?.amount ?? '')])) as Record<Price['period'], string>,
    });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const body = {
      ...form, trialDays: Number(form.trialDays), maxUnits: form.maxUnits ? Number(form.maxUnits) : null,
      maxUsers: form.maxUsers ? Number(form.maxUsers) : null, activationFee: Number(form.activationFee), setupFee: Number(form.setupFee),
      modules: form.modules, prices: periods.filter(period => form.prices[period.key] !== '').map(period => ({ period: period.key, amount: Number(form.prices[period.key]) })),
    };
    try {
      await api(editing ? `/plans/${editing}` : '/plans', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setSuccess(true); setMessage('Plano salvo. Contratos já vinculados não são alterados retroativamente.');
      setEditing(null); setForm(fresh()); await load();
    } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Falha ao salvar o plano')); }
    finally { setBusy(false); }
  }
  async function duplicate(plan: Plan) {
    const key = `${plan.key}-copy`;
    try {
      await api(`/plans/${plan.id}/duplicate`, { method: 'POST', body: JSON.stringify({ key, name: `${plan.name} (cópia)` }) });
      setSuccess(true); setMessage(`Cópia inativa criada com a chave "${key}".`); await load();
    } catch (error) { setSuccess(false); setMessage(errorMessage(error, 'Falha ao duplicar o plano')); }
  }
  const toggle = (key: string) => setForm(current => ({ ...current, modules: current.modules.includes(key) ? current.modules.filter(item => item !== key) : [...current.modules, key] }));

  return <AppShell title="Planos e preços SaaS">
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <form onSubmit={save} className={`${panelClass} mb-6 space-y-5`}>
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">{editing ? 'Editar plano' : 'Novo plano comercial'}</h2>{editing && <button type="button" className={secondaryButtonClass} onClick={() => { setEditing(null); setForm(fresh()); }}>Cancelar edição</button>}</div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Chave única" required value={form.key} onChange={event => setForm({ ...form, key: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
        <Field label="Nome" required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
        <Field label="Dias de teste" type="number" min={0} value={form.trialDays} onChange={event => setForm({ ...form, trialDays: event.target.value })} />
        <Field label="Limite de unidades (vazio = ilimitado)" type="number" min={1} value={form.maxUnits} onChange={event => setForm({ ...form, maxUnits: event.target.value })} />
        <Field label="Limite de usuários (vazio = ilimitado)" type="number" min={1} value={form.maxUsers} onChange={event => setForm({ ...form, maxUsers: event.target.value })} />
        <Field label="Taxa de ativação (R$)" type="number" min={0} step="0.01" value={form.activationFee} onChange={event => setForm({ ...form, activationFee: event.target.value })} />
        <Field label="Taxa de implantação (R$)" type="number" min={0} step="0.01" value={form.setupFee} onChange={event => setForm({ ...form, setupFee: event.target.value })} />
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-slate-700"><input type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} /> Disponível para contratação</label>
      </div>
      <Field label="Descrição" value={form.description} maxLength={1000} onChange={event => setForm({ ...form, description: event.target.value })} />
      <fieldset><legend className="mb-2 text-sm font-semibold">Preços recorrentes (R$)</legend><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {periods.map(period => <Field key={period.key} label={period.label} type="number" min={0} step="0.01" value={form.prices[period.key]} onChange={event => setForm({ ...form, prices: { ...form.prices, [period.key]: event.target.value } })} />)}
      </div></fieldset>
      <fieldset><legend className="mb-2 text-sm font-semibold">Módulos incluídos</legend><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{catalog.map(module => <Check key={module.key} label={module.name} checked={form.modules.includes(module.key)} onChange={() => toggle(module.key)} />)}</div></fieldset>
      <button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : editing ? 'Salvar alterações' : 'Criar plano'}</button>
    </form>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Planos cadastrados ({items.length})</h2><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr>{['Plano', 'Estado', 'Unidades', 'Usuários', 'Módulos', 'Preços', 'Ações'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>
      {items.map(plan => <tr key={plan.id} className="border-t border-slate-200 align-top"><td className="p-3"><strong>{plan.name}</strong><div className="text-xs text-slate-500">{plan.key}</div></td><td className="p-3">{plan.active ? 'Ativo' : 'Inativo'}</td><td className="p-3">{plan.maxUnits ?? 'Ilimitado'}</td><td className="p-3">{plan.maxUsers ?? 'Ilimitado'}</td><td className="p-3">{plan.modules.length}</td><td className="p-3">{plan.prices.map(price => <div key={price.period}>{periods.find(item => item.key === price.period)?.label}: R$ {Number(price.amount).toFixed(2)}</div>)}</td><td className="space-x-2 whitespace-nowrap p-3"><button className={secondaryButtonClass} onClick={() => edit(plan)}>Editar</button><button className={secondaryButtonClass} onClick={() => void duplicate(plan)}>Duplicar</button></td></tr>)}
      {items.length === 0 && <tr><td className="p-4 text-slate-500" colSpan={7}>Nenhum plano criado.</td></tr>}
    </tbody></table></div></section>
  </AppShell>;
}
