'use client';

import { useState } from 'react';
import { api, Coupon, errorMessage, formatDateTime, formatMoney, ListResponse, toIso } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const emptyForm = { code: '', type: 'PERCENT', value: '', minOrder: '', maxUses: '', validFrom: '', validUntil: '' };

export default function CouponsPage() {
  const [items, setItems] = useState<Coupon[]>([]); const [form, setForm] = useState(emptyForm);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try { setItems((await api<ListResponse<Coupon>>('/coupons')).items); } catch (e) { fail(e, 'Erro ao carregar cupons'); }
  }
  useAutoLoad(load);

  async function create(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const body = { code: form.code.trim(), type: form.type, value: Number(form.value), minOrder: form.minOrder ? Number(form.minOrder) : undefined, maxUses: form.maxUses ? Number(form.maxUses) : undefined, validFrom: toIso(form.validFrom), validUntil: toIso(form.validUntil) };
    try { await api('/coupons', { method: 'POST', body: JSON.stringify(body) }); setNotice({ text: 'Cupom criado.', kind: 'success' }); setForm(emptyForm); await load(); } catch (e) { fail(e, 'Erro ao criar cupom'); }
  }
  async function toggle(coupon: Coupon) {
    try { await api(`/coupons/${coupon.id}`, { method: 'PATCH', body: JSON.stringify({ active: !coupon.active }) }); await load(); } catch (e) { fail(e, 'Erro ao atualizar cupom'); }
  }

  return <AppShell title="Cupons e promoções">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Novo cupom</h2>
      <form onSubmit={create} className="grid gap-4 md:grid-cols-3">
        <Field label="Código" required minLength={3} maxLength={40} pattern="[A-Za-z0-9_\-]+" title="Letras, números, _ e -" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
        <Select label="Tipo" value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}><option value="PERCENT">Percentual (%)</option><option value="FIXED">Valor fixo (R$)</option></Select>
        <Field label={form.type === 'PERCENT' ? 'Desconto (%)' : 'Desconto (R$)'} type="number" required min="0.01" max={form.type === 'PERCENT' ? '100' : undefined} step="0.01" value={form.value} onChange={e => setForm({ ...form, value: e.target.value })} />
        <Field label="Pedido mínimo (R$)" type="number" min="0" step="0.01" value={form.minOrder} onChange={e => setForm({ ...form, minOrder: e.target.value })} />
        <Field label="Máximo de usos" type="number" min="1" step="1" value={form.maxUses} onChange={e => setForm({ ...form, maxUses: e.target.value })} />
        <div />
        <Field label="Válido a partir de" type="datetime-local" value={form.validFrom} onChange={e => setForm({ ...form, validFrom: e.target.value })} />
        <Field label="Válido até" type="datetime-local" min={form.validFrom || undefined} value={form.validUntil} onChange={e => setForm({ ...form, validUntil: e.target.value })} />
        <div className="flex items-end"><button className={buttonClass}>Criar cupom</button></div>
      </form></section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Cupons ({items.length})</h2><div className="grid gap-3 md:grid-cols-2">{items.map(coupon => <article key={coupon.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-800 p-4"><div><h3 className="font-semibold">{coupon.code} <span className={`text-xs ${coupon.active ? 'text-emerald-300' : 'text-red-300'}`}>{coupon.active ? 'ativo' : 'inativo'}</span></h3><p className="mt-1 text-sm text-slate-300">{coupon.type === 'PERCENT' ? `${Number(coupon.value)}% de desconto` : `${formatMoney(coupon.value)} de desconto`}{coupon.minOrder ? ` · mínimo ${formatMoney(coupon.minOrder)}` : ''}</p><p className="mt-1 text-sm text-slate-400">Usos: {coupon.usedCount}{coupon.maxUses ? ` / ${coupon.maxUses}` : ''}</p><p className="mt-1 text-xs text-slate-500">{coupon.validFrom ? `De ${formatDateTime(coupon.validFrom)}` : 'Sem início'} · {coupon.validUntil ? `até ${formatDateTime(coupon.validUntil)}` : 'sem validade'}</p></div><button className={secondaryButtonClass} onClick={() => void toggle(coupon)}>{coupon.active ? 'Desativar' : 'Ativar'}</button></article>)}</div>{items.length === 0 && <p className="text-slate-400">Nenhum cupom cadastrado.</p>}</section>
  </AppShell>;
}
