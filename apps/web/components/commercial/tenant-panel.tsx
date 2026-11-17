'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { buttonClass, Check, Field, Notice, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable, EmptyState, StatCard } from '../ui';
import { fromDateInput, ReasonDialog, Section, statusLabels, statusTone, toDateInput, type ModuleRow } from './common';

type TenantModuleRow = { id: string; moduleKey: string; name: string; source: string; unitPrice: string | number | null; discountPercent: string | number | null; free: boolean; blocked: boolean; startsAt: string | null; endsAt: string | null; notes: string | null; active: boolean };
type Ficha = {
  tenant: { id: string; name: string; slug: string; status: string; createdAt: string; users: number; units: number };
  license: { status: string; validUntil: string | null; graceDays: number; plan: { name: string } | null; billingPeriod: string | null; contractedPrice: string | number | null; discountPercent: string | number | null } | null;
  modules: TenantModuleRow[];
  invoices: { id: string; seq: number; reference: string; status: string; total: string | number; discount: string | number; dueDate: string; paidAt: string | null; paymentMethod: string | null }[];
  history: { id: string; action: string; metadata: Record<string, unknown> | null; createdAt: string; actor: { name: string } | null }[];
  finance: { open: number; overdue: number; paid: number };
};
type AddonAction = 'ADD' | 'UPDATE' | 'REMOVE' | 'BLOCK' | 'UNBLOCK';
type Pending = { action: AddonAction | 'SUSPEND' | 'REACTIVATE'; module?: TenantModuleRow };
const emptyAddon = { moduleKey: '', unitPrice: '', discountPercent: '', free: false, startsAt: '', endsAt: '', notes: '' };
const titles: Record<string, string> = { ADD: 'Adicionar módulo', UPDATE: 'Alterar condições', REMOVE: 'Remover módulo', BLOCK: 'Bloquear módulo', UNBLOCK: 'Desbloquear módulo', SUSPEND: 'Suspender assinatura', REACTIVATE: 'Reativar assinatura' };

// Commercial record of a customer: reuses Tenant/TenantLicense/TenantModule, adding add-on modules, billing, financial standing and history.
export function TenantCommercialPanel({ tenantId, onChanged }: { tenantId: string; onChanged?: () => void }) {
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [catalog, setCatalog] = useState<ModuleRow[]>([]);
  const [addon, setAddon] = useState(emptyAddon);
  const [editing, setEditing] = useState<TenantModuleRow | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    try {
      const [data, modules] = await Promise.all([api<Ficha>(`/commercial/tenants/${tenantId}`), api<{ items: ModuleRow[] }>('/commercial/modules')]);
      setFicha(data); setCatalog(modules.items);
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao carregar a ficha comercial')); }
  }, [tenantId]);
  useEffect(() => { void load(); }, [load]);

  const owned = new Set(ficha?.modules.map(item => item.moduleKey));
  const available = catalog.filter(item => item.featureLinked && item.standalone && item.status === 'ACTIVE' && !owned.has(item.key));

  function startEdit(module: TenantModuleRow) {
    setEditing(module);
    setAddon({ moduleKey: module.moduleKey, unitPrice: module.unitPrice === null ? '' : String(module.unitPrice), discountPercent: module.discountPercent === null ? '' : String(module.discountPercent), free: module.free, startsAt: toDateInput(module.startsAt), endsAt: toDateInput(module.endsAt), notes: module.notes ?? '' });
  }
  async function run(reason: string) {
    if (!pending) return;
    try {
      if (pending.action === 'SUSPEND' || pending.action === 'REACTIVATE') await api(`/commercial/tenants/${tenantId}/access`, { method: 'POST', body: JSON.stringify({ action: pending.action, reason }) });
      else {
        const target = pending.module?.moduleKey ?? addon.moduleKey;
        const withFields = pending.action === 'ADD' || pending.action === 'UPDATE';
        await api(`/commercial/tenants/${tenantId}/addons`, { method: 'PUT', body: JSON.stringify({
          moduleKey: target, action: pending.action, reason,
          ...(withFields ? { unitPrice: addon.unitPrice === '' ? null : Number(addon.unitPrice), discountPercent: addon.discountPercent === '' ? null : Number(addon.discountPercent), free: addon.free, startsAt: fromDateInput(addon.startsAt), endsAt: fromDateInput(addon.endsAt), notes: addon.notes || null } : {}),
        }) });
      }
      setSuccess(true); setMessage(`${titles[pending.action]}: concluído e registrado no histórico.`); setPending(null); setAddon(emptyAddon); setEditing(null); await load(); onChanged?.();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha na operação')); setPending(null); }
  }

  if (!ficha) return message ? <Notice message={message} /> : <p className="text-sm text-slate-500">Carregando ficha comercial…</p>;
  const license = ficha.license;
  return <div className="mt-6">
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard tone="dark" label="Situação da assinatura" value={license ? license.status : 'Sem licença'} hint={license ? `${license.plan?.name ?? 'Plano personalizado'} · vence ${license.validUntil ? formatDateTime(license.validUntil) : 'sem data'}${license.graceDays ? ` (+${license.graceDays}d de carência)` : ''}` : 'Acesso irrestrito (anterior ao licenciamento)'} />
      <StatCard label="Em aberto" value={formatMoney(ficha.finance.open)} hint={ficha.finance.overdue > 0 ? `Vencido: ${formatMoney(ficha.finance.overdue)}` : 'Sem pendências vencidas'} />
      <StatCard label="Total pago" value={formatMoney(ficha.finance.paid)} hint="Últimas 24 cobranças" />
      <StatCard label="Uso" value={`${ficha.tenant.units} unid. · ${ficha.tenant.users} usuários`} hint={`Cliente desde ${formatDateTime(ficha.tenant.createdAt)}`} />
    </div>
    {license && <div className="mb-4 flex flex-wrap gap-2">
      {license.status === 'ACTIVE' ? <button type="button" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100" onClick={() => setPending({ action: 'SUSPEND' })}>Suspender assinatura</button> : <button type="button" className={buttonClass} onClick={() => setPending({ action: 'REACTIVATE' })}>Reativar assinatura</button>}
    </div>}

    <Section title="Módulos contratados e módulos avulsos">
      {ficha.modules.length === 0 ? <EmptyState title="Nenhum módulo concedido" /> : <DataTable columns={[{ label: 'Módulo' }, { label: 'Origem' }, { label: 'Condição' }, { label: 'Vigência' }, { label: 'Situação' }, { label: 'Ações' }]}>
        {ficha.modules.map(module => <tr key={module.id} className="align-top">
          <td>{module.name}<div className="text-xs text-slate-500">{module.moduleKey}</div></td>
          <td>{module.source === 'ADDON' ? 'Avulso' : 'Plano'}</td>
          <td className="text-xs">{module.free ? 'Gratuito' : module.unitPrice !== null ? `${formatMoney(module.unitPrice)}/mês` : 'Preço do catálogo'}{module.discountPercent !== null && ` · ${Number(module.discountPercent)}% off`}</td>
          <td className="text-xs">{module.startsAt ? formatDateTime(module.startsAt) : 'Imediato'}<br />{module.endsAt ? `até ${formatDateTime(module.endsAt)}` : 'sem término'}</td>
          <td><Badge tone={module.blocked ? 'red' : module.active ? 'green' : 'neutral'}>{module.blocked ? 'Bloqueado' : module.active ? 'Ativo' : 'Fora da vigência'}</Badge></td>
          <td><div className="flex flex-wrap gap-1">
            {module.source === 'ADDON' && <button type="button" className={secondaryButtonClass} onClick={() => startEdit(module)}>Condições</button>}
            <button type="button" className={secondaryButtonClass} onClick={() => setPending({ action: module.blocked ? 'UNBLOCK' : 'BLOCK', module })}>{module.blocked ? 'Desbloquear' : 'Bloquear'}</button>
            <button type="button" className={secondaryButtonClass} onClick={() => setPending({ action: 'REMOVE', module })}>Remover</button>
          </div></td>
        </tr>)}
      </DataTable>}
      <form className="mt-4 space-y-3 rounded-xl border border-slate-200 p-4" onSubmit={event => { event.preventDefault(); setPending({ action: editing ? 'UPDATE' : 'ADD', module: editing ?? undefined }); }}>
        <h3 className="text-sm font-bold">{editing ? `Condições de ${editing.name}` : 'Contratar módulo avulso'}</h3>
        <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {!editing && <Select label="Módulo" required value={addon.moduleKey} onChange={event => setAddon({ ...addon, moduleKey: event.target.value })}><option value="">Selecione</option>{available.map(item => <option key={item.key} value={item.key}>{item.name}</option>)}</Select>}
          <Field label="Valor mensal especial (R$)" type="number" min={0} step="0.01" value={addon.unitPrice} onChange={event => setAddon({ ...addon, unitPrice: event.target.value })} />
          <Field label="Desconto (%)" type="number" min={0} max={100} step="0.01" value={addon.discountPercent} onChange={event => setAddon({ ...addon, discountPercent: event.target.value })} />
          <Field label="Início" type="datetime-local" value={addon.startsAt} onChange={event => setAddon({ ...addon, startsAt: event.target.value })} />
          <Field label="Término (temporário)" type="datetime-local" value={addon.endsAt} onChange={event => setAddon({ ...addon, endsAt: event.target.value })} />
          <Field label="Observações" maxLength={300} value={addon.notes} onChange={event => setAddon({ ...addon, notes: event.target.value })} />
        </div>
        <Check label="Liberar gratuitamente" checked={addon.free} onChange={event => setAddon({ ...addon, free: event.target.checked })} />
        <div className="flex gap-2"><button className={buttonClass} disabled={!editing && !addon.moduleKey}>{editing ? 'Salvar condições' : 'Adicionar módulo'}</button>{editing && <button type="button" className={secondaryButtonClass} onClick={() => { setEditing(null); setAddon(emptyAddon); }}>Cancelar</button>}</div>
        <p className="text-xs text-slate-500">O módulo avulso é somado à próxima cobrança. Módulos já incluídos no plano nunca são cobrados em duplicidade.</p>
      </form>
    </Section>

    <Section title="Cobranças">
      {ficha.invoices.length === 0 ? <EmptyState icon="🧾" title="Nenhuma cobrança" hint="Emita cobranças na aba Cobranças da Gestão comercial." /> : <DataTable columns={[{ label: 'Nº' }, { label: 'Competência' }, { label: 'Total' }, { label: 'Vencimento' }, { label: 'Situação' }]}>
        {ficha.invoices.map(invoice => { const state = invoice.status === 'OPEN' && new Date(invoice.dueDate) < new Date() ? 'OVERDUE' : invoice.status; return <tr key={invoice.id}><td>#{invoice.seq}</td><td>{invoice.reference}</td><td>{formatMoney(invoice.total)}{Number(invoice.discount) > 0 && <span className="text-xs text-emerald-700"> (−{formatMoney(invoice.discount)})</span>}</td><td>{formatDateTime(invoice.dueDate)}</td><td><Badge tone={statusTone(state)}>{statusLabels[state]}</Badge>{invoice.paidAt && <span className="ml-2 text-xs text-slate-500">{formatDateTime(invoice.paidAt)} · {invoice.paymentMethod}</span>}</td></tr>; })}
      </DataTable>}
    </Section>

    <Section title="Histórico comercial">
      {ficha.history.length === 0 ? <EmptyState title="Sem alterações registradas" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Ação' }, { label: 'Responsável' }, { label: 'Motivo / detalhes' }]}>
        {ficha.history.map(entry => <tr key={entry.id} className="align-top"><td className="whitespace-nowrap text-xs">{formatDateTime(entry.createdAt)}</td><td className="text-xs font-semibold">{entry.action}</td><td>{entry.actor?.name ?? '—'}</td><td className="max-w-md break-words text-xs text-slate-500">{typeof entry.metadata?.reason === 'string' && entry.metadata.reason ? `${entry.metadata.reason} · ` : ''}{JSON.stringify(entry.metadata ?? {}).slice(0, 200)}</td></tr>)}
      </DataTable>}
    </Section>
    {pending && <ReasonDialog title={`${titles[pending.action]}${pending.module ? `: ${pending.module.name}` : addon.moduleKey ? `: ${catalog.find(item => item.key === addon.moduleKey)?.name ?? ''}` : ''}`} danger={['BLOCK', 'REMOVE', 'SUSPEND'].includes(pending.action)} onCancel={() => setPending(null)} onConfirm={run}>
      {pending.action === 'SUSPEND' && <p className="text-sm text-red-700">O cliente perde o acesso imediatamente. Nenhum dado é apagado e a reativação restaura tudo.</p>}
    </ReasonDialog>}
  </div>;
}
