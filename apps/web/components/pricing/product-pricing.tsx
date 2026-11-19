'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { buttonClass, Field, Notice, secondaryButtonClass } from '../app-shell';
import { Badge } from '../ui';
import { HISTORY_REASON, STATUS_LABEL, type Assessment, type PricingResult, type ProductPricingResponse } from '../../lib/types-pricing';

const text = (value: string | number | null | undefined) => (value === null || value === undefined ? '' : String(value));
const numberOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const pct = (value: string | null) => (value === null ? '—' : `${value.replace('.', ',')}%`);

function Metrics({ title, data }: { title: string; data: Assessment | null }) {
  if (!data) return null;
  const negative = Number(data.netResult) < 0;
  return <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
    <p className="font-semibold text-slate-800">{title}: {formatMoney(data.price)}</p>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700">
      <dt>ML (sobre o custo)</dt><dd className="text-right font-medium">{pct(data.ml)}</dd>
      <dt>MLA (após encargos)</dt><dd className={`text-right font-medium ${negative ? 'text-red-700' : ''}`}>{pct(data.mla)}</dd>
      <dt>Margem sobre a venda</dt><dd className="text-right font-medium">{pct(data.marginOnSale)}</dd>
      <dt>Markup</dt><dd className="text-right font-medium">{data.markup ?? '—'}</dd>
      <dt>Resultado líquido/un.</dt><dd className={`text-right font-medium ${negative ? 'text-red-700' : ''}`}>{formatMoney(data.netResult)}</dd>
    </dl>
  </div>;
}

export function ProductPricingTab({ productId, onSynced }: { productId: string; onSynced: (product: { price: number; cost: number | null }) => void }) {
  const [data, setData] = useState<ProductPricingResponse | null>(null);
  const [form, setForm] = useState({ acquisitionCost: '', freightCost: '', otherAcquisitionCost: '', marginPercent: '', operationalCostPercent: '', operationalCostFixed: '', taxPercent: '', cardFeePercent: '', commissionPercent: '', otherVariablePercent: '' });
  const [simulatedPrice, setSimulatedPrice] = useState('');
  const [result, setResult] = useState<PricingResult | null>(null);
  const [message, setMessage] = useState(''); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  const token = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await api<ProductPricingResponse>(`/pricing/products/${productId}`);
      setData(response); setResult(response.result); setSimulatedPrice(''); onSynced({ price: response.product.price, cost: response.product.cost });
      const row = response.pricing;
      setForm({
        acquisitionCost: text(response.product.cost), freightCost: text(row?.freightCost ?? 0), otherAcquisitionCost: text(row?.otherAcquisitionCost ?? 0), marginPercent: text(row?.marginPercent), operationalCostPercent: text(row?.operationalCostPercent),
        operationalCostFixed: text(row?.operationalCostFixed), taxPercent: text(row?.taxPercent), cardFeePercent: text(row?.cardFeePercent), commissionPercent: text(row?.commissionPercent), otherVariablePercent: text(row?.otherVariablePercent),
      });
    } catch (cause) { setOk(false); setMessage(errorMessage(cause, 'Falha ao carregar custos e margens')); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);
  useEffect(() => { void load(); }, [load]);

  // Live simulation: blank percentage fields inherit the company default, exactly like the saved calculation.
  useEffect(() => {
    if (!data) return;
    const current = ++token.current;
    const timer = setTimeout(async () => {
      const d = data.defaults;
      const pick = (value: string, fallback: number) => (value.trim() === '' ? fallback : Number(value));
      try {
        const response = await api<PricingResult>('/pricing/simulate', { method: 'POST', body: JSON.stringify({
          productId, acquisitionCost: Number(form.acquisitionCost || 0), freightCost: Number(form.freightCost || 0), otherAcquisitionCost: Number(form.otherAcquisitionCost || 0), marginPercent: pick(form.marginPercent, d.marginPercent),
          taxPercent: pick(form.taxPercent, d.taxPercent), cardFeePercent: pick(form.cardFeePercent, d.cardFeePercent), commissionPercent: pick(form.commissionPercent, d.commissionPercent), operationalCostPercent: pick(form.operationalCostPercent, d.operationalCostPercent),
          otherVariablePercent: pick(form.otherVariablePercent, d.otherVariablePercent), operationalCostFixed: Number(form.operationalCostFixed || 0), ...(simulatedPrice.trim() !== '' ? { simulatedPrice: Number(simulatedPrice) } : {}),
        }) });
        if (current === token.current) setResult(response);
      } catch { /* keeps the last result while the user types */ }
    }, 350);
    return () => clearTimeout(timer);
  }, [form, simulatedPrice, data, productId]);

  async function save() {
    setBusy(true); setMessage('');
    try {
      await api(`/pricing/products/${productId}`, { method: 'PUT', body: JSON.stringify({
        acquisitionCost: form.acquisitionCost.trim() === '' ? null : Number(form.acquisitionCost), freightCost: Number(form.freightCost || 0), otherAcquisitionCost: Number(form.otherAcquisitionCost || 0), marginPercent: numberOrNull(form.marginPercent),
        operationalCostPercent: numberOrNull(form.operationalCostPercent), operationalCostFixed: numberOrNull(form.operationalCostFixed), taxPercent: numberOrNull(form.taxPercent), cardFeePercent: numberOrNull(form.cardFeePercent),
        commissionPercent: numberOrNull(form.commissionPercent), otherVariablePercent: numberOrNull(form.otherVariablePercent),
      }) });
      await load(); setOk(true); setMessage('Custos e margens salvos. O preço de venda não foi alterado.');
    } catch (cause) { setOk(false); setMessage(errorMessage(cause, 'Falha ao salvar')); } finally { setBusy(false); }
  }
  async function applyPrice(price: string) {
    if (!window.confirm(`Alterar o preço oficial de venda para ${formatMoney(price)}? A alteração fica registrada no histórico.`)) return;
    setBusy(true); setMessage('');
    try { await api(`/pricing/products/${productId}/apply-price`, { method: 'POST', body: JSON.stringify({ price: Number(price), confirm: true }) }); await load(); setOk(true); setMessage(`Preço oficial alterado para ${formatMoney(price)}.`); }
    catch (cause) { setOk(false); setMessage(errorMessage(cause, 'Falha ao aplicar o preço')); } finally { setBusy(false); }
  }
  if (!data) return <div className="md:col-span-2 xl:col-span-3">{message ? <Notice message={message} /> : <p className="text-sm text-slate-500">Carregando…</p>}</div>;
  const d = data.defaults;
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  const inherit = (fallback: number) => `Padrão da empresa: ${fallback}%`;
  const good = result && result.ok ? result : null;

  return <div className="space-y-4 md:col-span-2 xl:col-span-3">
    {message && <Notice message={message} kind={ok ? 'success' : 'error'} />}
    <p className="text-sm text-slate-600">A margem é calculada <strong>sobre o custo</strong>. Tributos, taxa de cartão, comissão e despesas em % incidem sobre o preço de venda (&quot;por dentro&quot;). Campos em branco herdam o padrão da empresa.</p>
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <Field label="Custo de aquisição (R$)" type="number" min="0" step="0.01" value={form.acquisitionCost} onChange={set('acquisitionCost')} />
      <Field label="Frete (R$)" type="number" min="0" step="0.01" value={form.freightCost} onChange={set('freightCost')} />
      <Field label="Outras despesas de aquisição (R$)" type="number" min="0" step="0.01" value={form.otherAcquisitionCost} onChange={set('otherAcquisitionCost')} />
      <Field label="Margem de lucro desejada (% sobre o custo)" type="number" min="0" step="0.1" placeholder={inherit(d.marginPercent)} value={form.marginPercent} onChange={set('marginPercent')} />
      <Field label="Tributos (% do preço)" type="number" min="0" step="0.01" placeholder={inherit(d.taxPercent)} value={form.taxPercent} onChange={set('taxPercent')} />
      <Field label="Taxa de cartão (% do preço)" type="number" min="0" step="0.01" placeholder={inherit(d.cardFeePercent)} value={form.cardFeePercent} onChange={set('cardFeePercent')} />
      <Field label="Comissão (% do preço)" type="number" min="0" step="0.01" placeholder={inherit(d.commissionPercent)} value={form.commissionPercent} onChange={set('commissionPercent')} />
      <Field label="Custo operacional (% do preço)" type="number" min="0" step="0.01" placeholder={inherit(d.operationalCostPercent)} value={form.operationalCostPercent} onChange={set('operationalCostPercent')} />
      <Field label="Outras despesas variáveis (% do preço)" type="number" min="0" step="0.01" placeholder={inherit(d.otherVariablePercent)} value={form.otherVariablePercent} onChange={set('otherVariablePercent')} />
      <Field label="Custo operacional fixo por unidade (R$)" type="number" min="0" step="0.01" value={form.operationalCostFixed} onChange={set('operationalCostFixed')} />
      <Field label="Simular outro preço de venda (R$)" type="number" min="0" step="0.01" value={simulatedPrice} onChange={event => setSimulatedPrice(event.target.value)} />
    </div>
    {result && !result.ok && <Notice message={result.message} />}
    {good && <div className="space-y-3 rounded-2xl border border-brand-500/30 p-4">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>Custo total: <strong>{formatMoney(good.totalCost)}</strong></span><span>Lucro desejado: <strong>{formatMoney(good.desiredProfit)}</strong></span><span>Encargos sobre o preço: <strong>{pct(good.variablePercent)}</strong></span>
        <Badge tone={STATUS_LABEL[good.status].tone}>{STATUS_LABEL[good.status].label}</Badge>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metrics title="Preço recomendado" data={good.recommended} /><Metrics title="Preço mínimo (sem prejuízo)" data={good.minimum} /><Metrics title="Preço atual" data={good.current} /><Metrics title="Preço simulado" data={good.simulated} />
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void save()}>Salvar custos e margens</button>
        <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void applyPrice(good.recommendedPrice)}>Usar preço recomendado ({formatMoney(good.recommendedPrice)})</button>
        {good.simulated && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void applyPrice(good.simulated!.price)}>Usar preço simulado ({formatMoney(good.simulated.price)})</button>}
      </div>
      <details className="text-xs text-slate-600"><summary className="cursor-pointer font-medium">Como o cálculo é feito</summary><ul className="mt-2 list-disc space-y-1 pl-5">{good.formulas.map(line => <li key={line}>{line}</li>)}</ul></details>
    </div>}
    {data.history.length > 0 && <details className="text-sm"><summary className="cursor-pointer font-medium text-slate-700">Histórico de preço e custo ({data.history.length})</summary>
      <table className="mt-2 w-full text-left text-xs"><thead><tr className="text-slate-500"><th className="py-1">Data</th><th>Motivo</th><th>Preço</th><th>Custo</th></tr></thead>
        <tbody>{data.history.map(row => <tr key={row.id} className="border-t border-slate-100"><td className="py-1">{formatDateTime(row.createdAt)}</td><td>{HISTORY_REASON[row.reason] ?? row.reason}</td><td>{formatMoney(row.price)}</td><td>{row.cost === null ? '—' : formatMoney(row.cost)}</td></tr>)}</tbody></table></details>}
  </div>;
}
