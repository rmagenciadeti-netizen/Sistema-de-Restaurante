'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable, EmptyState, textareaClass } from '../ui';
import { fromDateInput, MultiPick, num, ReasonDialog, Section, statusLabels, statusTone, toDateInput, type ModuleRow, type PlanRow } from './common';

type Promotion = {
  id: string; name: string; code?: string; description: string | null; discountType: 'PERCENT' | 'FIXED'; discountValue: string | number; planIds: string[]; moduleKeys: string[];
  startsAt: string | null; endsAt?: string; validUntil?: string | null; maxUses: number | null; perTenantLimit: number | null; audience: 'NEW' | 'EXISTING' | 'BOTH'; cycles: number;
  conditions?: string | null; minAmount?: string | number | null; status: string; phase?: string; uses: number; discountGiven: string | number;
};
type Redemption = { id: string; amount: string | number; createdAt: string; tenant: { name: string }; invoice: { seq: number; reference: string; status: string } };
const audienceLabels = { NEW: 'Novos clientes', EXISTING: 'Clientes atuais', BOTH: 'Todos' };
const blank = (kind: 'campaigns' | 'coupons') => ({ name: '', code: '', description: '', discountType: 'PERCENT' as 'PERCENT' | 'FIXED', discountValue: '10', planIds: [] as string[], moduleKeys: [] as string[], startsAt: '', endsAt: '', maxUses: '', perTenantLimit: '', audience: 'BOTH' as Promotion['audience'], cycles: '1', conditions: '', minAmount: '', status: kind === 'campaigns' ? 'DRAFT' : 'ACTIVE' });

// One manager for both campaigns (time-boxed promotions) and coupons (codes) since they share the same discount, audience and limit rules.
export function PromotionManager({ kind }: { kind: 'campaigns' | 'coupons' }) {
  const isCoupon = kind === 'coupons';
  const [items, setItems] = useState<Promotion[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [form, setForm] = useState(() => blank(kind));
  const [editing, setEditing] = useState<string | null>(null);
  const [closing, setClosing] = useState<Promotion | null>(null);
  const [uses, setUses] = useState<{ title: string; items: Redemption[] } | null>(null);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, planList, moduleList] = await Promise.all([api<{ items: Promotion[] }>(`/commercial/${kind}`), api<{ items: PlanRow[] }>('/plans'), api<{ items: ModuleRow[] }>('/commercial/modules')]);
      setItems(list.items); setPlans(planList.items); setModules(moduleList.items);
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao carregar')); }
  }, [kind]);
  useEffect(() => { void load(); }, [load]);

  const reset = () => { setEditing(null); setForm(blank(kind)); };
  function edit(item: Promotion) {
    setEditing(item.id);
    setForm({ name: item.name, code: item.code ?? '', description: item.description ?? '', discountType: item.discountType, discountValue: String(item.discountValue), planIds: item.planIds, moduleKeys: item.moduleKeys, startsAt: toDateInput(item.startsAt), endsAt: toDateInput(item.endsAt ?? item.validUntil), maxUses: item.maxUses?.toString() ?? '', perTenantLimit: item.perTenantLimit?.toString() ?? '', audience: item.audience, cycles: String(item.cycles), conditions: item.conditions ?? '', minAmount: item.minAmount?.toString() ?? '', status: item.status });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const common = { name: form.name, description: form.description || null, discountType: form.discountType, discountValue: Number(form.discountValue), planIds: form.planIds, moduleKeys: form.moduleKeys, maxUses: num(form.maxUses), perTenantLimit: num(form.perTenantLimit), audience: form.audience, cycles: Number(form.cycles), startsAt: fromDateInput(form.startsAt) };
    const body = isCoupon ? { ...common, code: form.code, validUntil: fromDateInput(form.endsAt), minAmount: num(form.minAmount), status: form.status } : { ...common, endsAt: fromDateInput(form.endsAt), conditions: form.conditions || null };
    try {
      await api(editing ? `/commercial/${kind}/${editing}` : `/commercial/${kind}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setSuccess(true); setMessage(isCoupon ? 'Cupom salvo.' : 'Promoção salva. Ative-a para que passe a valer.'); reset(); await load();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao salvar')); } finally { setBusy(false); }
  }
  async function setStatus(item: Promotion, status: string, reason?: string) {
    try {
      if (isCoupon) await api(`/commercial/coupons/${item.id}`, { method: 'PUT', body: JSON.stringify({ code: item.code, name: item.name, description: item.description, discountType: item.discountType, discountValue: Number(item.discountValue), planIds: item.planIds, moduleKeys: item.moduleKeys, startsAt: item.startsAt, validUntil: item.validUntil ?? null, maxUses: item.maxUses, perTenantLimit: item.perTenantLimit, audience: item.audience, cycles: item.cycles, minAmount: item.minAmount == null ? null : Number(item.minAmount), status }) });
      else await api(`/commercial/campaigns/${item.id}/status`, { method: 'PATCH', body: JSON.stringify({ status, reason }) });
      setSuccess(true); setMessage('Situação atualizada.'); setClosing(null); await load();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao atualizar')); setClosing(null); }
  }
  async function showUses(item: Promotion) {
    try { setUses({ title: item.code ?? item.name, items: (await api<{ items: Redemption[] }>(`/commercial/coupons/${item.id}/redemptions`)).items }); } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao carregar utilizações')); }
  }

  return <>
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <form onSubmit={save} className={`${panelClass} mb-6 space-y-4`}>
      <div className="flex items-center justify-between"><h2 className="text-base font-bold">{editing ? 'Editar' : isCoupon ? 'Novo cupom' : 'Nova promoção / campanha'}</h2>{editing && <button type="button" className={secondaryButtonClass} onClick={reset}>Cancelar edição</button>}</div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {isCoupon && <Field label="Código" required disabled={Boolean(editing)} value={form.code} onChange={event => setForm({ ...form, code: event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '') })} />}
        <Field label="Nome" required value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
        <Select label="Tipo de desconto" value={form.discountType} onChange={event => setForm({ ...form, discountType: event.target.value as 'PERCENT' | 'FIXED' })}><option value="PERCENT">Percentual (%)</option><option value="FIXED">Valor fixo (R$)</option></Select>
        <Field label={form.discountType === 'PERCENT' ? 'Desconto (%)' : 'Desconto (R$)'} required type="number" min={0} max={form.discountType === 'PERCENT' ? 100 : undefined} step="0.01" value={form.discountValue} onChange={event => setForm({ ...form, discountValue: event.target.value })} />
        <Field label={isCoupon ? 'Válido a partir de (opcional)' : 'Início'} required={!isCoupon} type="datetime-local" value={form.startsAt} onChange={event => setForm({ ...form, startsAt: event.target.value })} />
        <Field label={isCoupon ? 'Validade (opcional)' : 'Término'} required={!isCoupon} type="datetime-local" value={form.endsAt} onChange={event => setForm({ ...form, endsAt: event.target.value })} />
        <Select label="Público" value={form.audience} onChange={event => setForm({ ...form, audience: event.target.value as Promotion['audience'] })}>{Object.entries(audienceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
        <Field label="Ciclos de cobrança com desconto" type="number" min={1} max={60} value={form.cycles} onChange={event => setForm({ ...form, cycles: event.target.value })} />
        <Field label="Limite total de usos" type="number" min={1} value={form.maxUses} onChange={event => setForm({ ...form, maxUses: event.target.value })} />
        <Field label="Limite por cliente" type="number" min={1} value={form.perTenantLimit} onChange={event => setForm({ ...form, perTenantLimit: event.target.value })} />
        {isCoupon && <Field label="Valor mínimo da assinatura (R$)" type="number" min={0} step="0.01" value={form.minAmount} onChange={event => setForm({ ...form, minAmount: event.target.value })} />}
        {isCoupon && <Select label="Situação" value={form.status} onChange={event => setForm({ ...form, status: event.target.value })}><option value="ACTIVE">Ativo</option><option value="INACTIVE">Inativo</option></Select>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <MultiPick label="Planos participantes" options={plans.map(plan => ({ key: plan.id, name: plan.name }))} value={form.planIds} onChange={planIds => setForm({ ...form, planIds })} />
        <MultiPick label="Módulos participantes" options={modules.map(module => ({ key: module.key, name: module.name }))} value={form.moduleKeys} onChange={moduleKeys => setForm({ ...form, moduleKeys })} />
      </div>
      <label className="block text-sm font-medium text-slate-700">{isCoupon ? 'Descrição' : 'Condições e restrições'}<textarea className={textareaClass} rows={2} maxLength={1000} value={isCoupon ? form.description : form.conditions} onChange={event => setForm(isCoupon ? { ...form, description: event.target.value } : { ...form, conditions: event.target.value })} /></label>
      <p className="text-xs text-slate-500">Ao terminar a vigência, a cobrança volta automaticamente ao valor contratado. O desconto vale por no máximo o número de ciclos informado, por cliente.</p>
      <button className={buttonClass} disabled={busy}>{busy ? 'Salvando...' : editing ? 'Salvar alterações' : isCoupon ? 'Criar cupom' : 'Criar promoção'}</button>
    </form>
    <Section title={isCoupon ? `Cupons (${items.length})` : `Promoções e campanhas (${items.length})`}>
      {items.length === 0 ? <EmptyState icon="🏷️" title={isCoupon ? 'Nenhum cupom criado' : 'Nenhuma promoção criada'} /> : <DataTable columns={[{ label: isCoupon ? 'Cupom' : 'Promoção' }, { label: 'Desconto' }, { label: 'Vigência' }, { label: 'Usos' }, { label: 'Situação' }, { label: 'Ações' }]}>
        {items.map(item => {
          const state = item.phase ?? item.status;
          return <tr key={item.id} className="align-top">
            <td><strong>{item.code ?? item.name}</strong><div className="text-xs text-slate-500">{isCoupon ? item.name : audienceLabels[item.audience]}</div></td>
            <td>{item.discountType === 'PERCENT' ? `${Number(item.discountValue)}%` : formatMoney(item.discountValue)}<div className="text-xs text-slate-500">{item.cycles} ciclo(s) · {item.planIds.length || 'todos'} plano(s)</div></td>
            <td className="text-xs">{item.startsAt ? formatDateTime(item.startsAt) : 'Imediato'}<br />até {(item.endsAt ?? item.validUntil) ? formatDateTime(item.endsAt ?? item.validUntil) : 'sem validade'}</td>
            <td className="text-xs">{item.uses}{item.maxUses ? ` / ${item.maxUses}` : ''}<div>Descontos: {formatMoney(item.discountGiven)}</div></td>
            <td><Badge tone={statusTone(state)}>{statusLabels[state] ?? state}</Badge></td>
            <td><div className="flex flex-wrap gap-1">
              <button type="button" className={secondaryButtonClass} onClick={() => edit(item)}>Editar</button>
              {isCoupon && <button type="button" className={secondaryButtonClass} onClick={() => void showUses(item)}>Utilizações</button>}
              {isCoupon && <button type="button" className={secondaryButtonClass} onClick={() => void setStatus(item, item.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')}>{item.status === 'ACTIVE' ? 'Desativar' : 'Ativar'}</button>}
              {!isCoupon && item.status !== 'ACTIVE' && item.status !== 'CANCELLED' && <button type="button" className={secondaryButtonClass} onClick={() => void setStatus(item, 'ACTIVE')}>Ativar</button>}
              {!isCoupon && item.status !== 'CANCELLED' && <button type="button" className={secondaryButtonClass} onClick={() => setClosing(item)}>Encerrar</button>}
            </div></td>
          </tr>;
        })}
      </DataTable>}
    </Section>
    {uses && <Section title={`Utilizações — ${uses.title}`} actions={<button type="button" className={secondaryButtonClass} onClick={() => setUses(null)}>Fechar</button>}>
      {uses.items.length === 0 ? <EmptyState title="Nenhuma utilização registrada" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Cliente' }, { label: 'Cobrança' }, { label: 'Desconto' }]}>{uses.items.map(use => <tr key={use.id}><td>{formatDateTime(use.createdAt)}</td><td>{use.tenant.name}</td><td>#{use.invoice.seq} · {use.invoice.reference}</td><td>{formatMoney(use.amount)}</td></tr>)}</DataTable>}
    </Section>}
    {closing && <ReasonDialog title={`Encerrar promoção: ${closing.name}`} danger confirmLabel="Encerrar" onCancel={() => setClosing(null)} onConfirm={reason => setStatus(closing, 'CANCELLED', reason)} />}
  </>;
}
