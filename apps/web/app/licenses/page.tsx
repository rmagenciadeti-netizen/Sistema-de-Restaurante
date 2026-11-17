'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, Tenant } from '../../lib/api';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { TenantCommercialPanel } from '../../components/commercial/tenant-panel';

type CatalogItem = { key: string; name: string };
type CommercialPlan = { id: string; name: string; active: boolean; maxUnits: number | null; maxUsers: number | null; activationFee: string | number; setupFee: string | number; modules: string[]; prices: { period: string; amount: string | number }[] };
type License = { status: string; validUntil: string | null; maxUnits: number | null; maxUsers: number | null; notes: string | null; updatedAt: string; planId: string | null; billingPeriod: string | null; contractedPrice: string | number | null; activationFee: string | number | null; setupFee: string | number | null; discountPercent: string | number | null };
type LicenseView = { license: License | null; modules: string[]; usage: { units: number; users: number }; restricted: boolean };
const statuses = [['PENDING', 'Pendente'], ['ACTIVE', 'Ativa'], ['SUSPENDED', 'Suspensa'], ['REVOKED', 'Revogada'], ['CANCELLED', 'Cancelada']];
const emptyForm = { reason: '', graceDays: '0', status: 'ACTIVE', planId: '', billingPeriod: 'MONTHLY', contractedPrice: '', activationFee: '', setupFee: '', discountPercent: '0', validUntil: '', maxUnits: '', maxUsers: '', notes: '', modules: [] as string[] };
const billingPeriods = [['MONTHLY', 'Mensal'], ['QUARTERLY', 'Trimestral'], ['SEMIANNUAL', 'Semestral'], ['ANNUAL', 'Anual']];

export default function LicensesPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [plans, setPlans] = useState<CommercialPlan[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [view, setView] = useState<LicenseView | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api<{ items: Tenant[] }>('/tenants'), api<{ items: CatalogItem[] }>('/tenants/modules/catalog'), api<{ items: CommercialPlan[] }>('/plans')])
      .then(([list, modules, commercialPlans]) => { setTenants(list.items); setCatalog(modules.items); setPlans(commercialPlans.items.filter(plan => plan.active)); })
      .catch(cause => setMessage(errorMessage(cause, 'Erro ao carregar licenças')));
  }, []);

  const loadLicense = useCallback(async (id: string) => {
    setMessage(''); setView(null);
    if (!id) return;
    try {
      const result = await api<LicenseView>(`/tenants/${id}/license`);
      setView(result);
      setForm(result.license ? {
        reason: '', graceDays: String((result.license as { graceDays?: number }).graceDays ?? 0), status: result.license.status, planId: result.license.planId ?? '', billingPeriod: result.license.billingPeriod ?? 'MONTHLY',
        contractedPrice: result.license.contractedPrice?.toString() ?? '', activationFee: result.license.activationFee?.toString() ?? '',
        setupFee: result.license.setupFee?.toString() ?? '', discountPercent: result.license.discountPercent?.toString() ?? '0',
        validUntil: result.license.validUntil ? result.license.validUntil.slice(0, 10) : '',
        maxUnits: result.license.maxUnits?.toString() ?? '', maxUsers: result.license.maxUsers?.toString() ?? '', notes: result.license.notes ?? '', modules: result.modules,
      } : { ...emptyForm, modules: catalog.map(item => item.key) });
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Erro ao consultar licença')); }
  }, [catalog]);

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await api(`/tenants/${tenantId}/license`, { method: 'PUT', body: JSON.stringify({
        status: form.status, planId: form.planId || null, billingPeriod: form.billingPeriod || null,
        contractedPrice: form.contractedPrice ? Number(form.contractedPrice) : null,
        activationFee: form.activationFee ? Number(form.activationFee) : null, setupFee: form.setupFee ? Number(form.setupFee) : null,
        discountPercent: form.discountPercent === '' ? null : Number(form.discountPercent),
        validUntil: form.validUntil ? new Date(`${form.validUntil}T23:59:59`).toISOString() : null, graceDays: Number(form.graceDays || 0), reason: form.reason || undefined,
        maxUnits: form.maxUnits ? Number(form.maxUnits) : null, maxUsers: form.maxUsers ? Number(form.maxUsers) : null, notes: form.notes || null, modules: form.modules,
      }) });
      await loadLicense(tenantId);
      setSuccess(true); setMessage('Licença gravada. A restrição é aplicada pela API imediatamente.');
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Erro ao gravar licença')); }
    finally { setBusy(false); }
  }

  const toggle = (key: string) => setForm(current => ({ ...current, modules: current.modules.includes(key) ? current.modules.filter(item => item !== key) : [...current.modules, key] }));
  function choosePlan(planId: string) {
    const plan = plans.find(item => item.id === planId);
    const price = plan?.prices.find(item => item.period === 'MONTHLY') ?? plan?.prices[0];
    setForm(current => ({ ...current, planId, ...(plan ? {
      modules: plan.modules, maxUnits: plan.maxUnits?.toString() ?? '', maxUsers: plan.maxUsers?.toString() ?? '',
      billingPeriod: price?.period ?? 'MONTHLY', contractedPrice: price?.amount.toString() ?? '',
      activationFee: String(plan.activationFee), setupFee: String(plan.setupFee), discountPercent: '0',
    } : {}) }));
  }
  function choosePeriod(billingPeriod: string) {
    const price = plans.find(plan => plan.id === form.planId)?.prices.find(item => item.period === billingPeriod);
    setForm(current => ({ ...current, billingPeriod, ...(price ? { contractedPrice: String(price.amount) } : {}) }));
  }

  return <AppShell title="Clientes e assinaturas">
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <section className={`${panelClass} mb-6`}>
      <Select label="Empresa" value={tenantId} onChange={event => { setTenantId(event.target.value); void loadLicense(event.target.value); }}>
        <option value="">Selecione uma empresa</option>
        {tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.status})</option>)}
      </Select>
    </section>
    {view && <form onSubmit={save} className={`${panelClass} space-y-5`}>
      <p className="text-sm text-slate-600">
        {view.restricted ? `Última atualização: ${formatDateTime(view.license?.updatedAt)}.` : 'Esta empresa ainda não possui licença: todos os módulos permanecem liberados (ambiente anterior ao licenciamento). Ao gravar, somente os módulos marcados ficam disponíveis.'}
        {' '}Uso atual: {view.usage.units} unidade(s), {view.usage.users} usuário(s).
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Select label="Plano comercial base" value={form.planId} onChange={event => choosePlan(event.target.value)}><option value="">Personalizado</option>{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</Select>
        <Select label="Periodicidade" value={form.billingPeriod} onChange={event => choosePeriod(event.target.value)}>{billingPeriods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Select label="Situação" value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Field label="Validade (vazio = sem vencimento)" type="date" value={form.validUntil} onChange={event => setForm({ ...form, validUntil: event.target.value })} />
        <Field label="Carência após o vencimento (dias)" type="number" min={0} max={120} value={form.graceDays} onChange={event => setForm({ ...form, graceDays: event.target.value })} />
        <Field label="Limite de unidades" type="number" min={1} value={form.maxUnits} onChange={event => setForm({ ...form, maxUnits: event.target.value })} />
        <Field label="Limite de usuários ativos" type="number" min={1} value={form.maxUsers} onChange={event => setForm({ ...form, maxUsers: event.target.value })} />
        <Field label="Preço recorrente contratado (R$)" type="number" min={0} step="0.01" value={form.contractedPrice} onChange={event => setForm({ ...form, contractedPrice: event.target.value })} />
        <Field label="Desconto (%)" type="number" min={0} max={100} step="0.01" value={form.discountPercent} onChange={event => setForm({ ...form, discountPercent: event.target.value })} />
        <Field label="Taxa de ativação contratada (R$)" type="number" min={0} step="0.01" value={form.activationFee} onChange={event => setForm({ ...form, activationFee: event.target.value })} />
        <Field label="Taxa de implantação contratada (R$)" type="number" min={0} step="0.01" value={form.setupFee} onChange={event => setForm({ ...form, setupFee: event.target.value })} />
      </div>
      <Field label="Motivo da alteração (registrado na auditoria; obrigatório ao trocar de plano para histórico de upgrade/downgrade)" maxLength={300} value={form.reason} onChange={event => setForm({ ...form, reason: event.target.value })} />
      <Field label="Observações" maxLength={500} value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} />
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-slate-900">Módulos contratados</legend>
        <div className="mb-2 flex justify-end">
          <button type="button" className={secondaryButtonClass} disabled={catalog.length === 0} onClick={() => setForm(current => ({ ...current, modules: catalog.every(item => current.modules.includes(item.key)) ? [] : catalog.map(item => item.key) }))}>
            {catalog.length > 0 && catalog.every(item => form.modules.includes(item.key)) ? 'Desmarcar todos' : 'Selecionar todos'}
          </button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{catalog.map(item => <Check key={item.key} label={item.name} checked={form.modules.includes(item.key)} onChange={() => toggle(item.key)} />)}</div>
      </fieldset>
      <button className={buttonClass} disabled={busy}>{busy ? 'Gravando...' : 'Gravar licença'}</button>
    </form>}
    {tenantId && <TenantCommercialPanel key={tenantId} tenantId={tenantId} onChanged={() => void loadLicense(tenantId)} />}
  </AppShell>;
}
