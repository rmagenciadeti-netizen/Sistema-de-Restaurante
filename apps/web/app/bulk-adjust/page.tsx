'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney, ListResponse, ProductCategory } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import type { AdjustMode, AdjustRounding, BulkAdjustPreview } from '../../lib/types-catalog';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader } from '../../components/ui';

const MODE_LABELS: Record<AdjustMode, string> = {
  SET: 'Definir novo valor (R$)', INCREASE_PERCENT: 'Aumentar em %', DECREASE_PERCENT: 'Reduzir em %', ADD: 'Somar valor (R$)', SUBTRACT: 'Subtrair valor (R$)', COST_MARGIN: 'Margem sobre o custo (%)',
};
const ROUNDING_LABELS: Record<AdjustRounding, string> = { NONE: 'Sem arredondamento', UP_10C: 'Para cima, de 10 em 10 centavos', NEAREST_50C: 'Para o R$ 0,50 mais próximo', ROUND_1: 'Para o real mais próximo' };
const STEPS = ['O que alterar', 'Quais produtos', 'Prévia', 'Revisar e aplicar'];
const unitOf = (mode: AdjustMode) => (mode === 'SET' || mode === 'ADD' || mode === 'SUBTRACT' ? 'R$' : '%');

type Change = { enabled: boolean; mode: AdjustMode; value: string };
const parseValue = (text: string) => Number(text.trim().replace(',', '.'));
const validValue = (change: Change) => Number.isFinite(parseValue(change.value)) && parseValue(change.value) > 0;

function ChangeEditor({ title, change, onChange, allowMargin }: { title: string; change: Change; onChange: (next: Change) => void; allowMargin: boolean }) {
  const modes = (Object.keys(MODE_LABELS) as AdjustMode[]).filter(mode => allowMargin || mode !== 'COST_MARGIN');
  return <div className="rounded-xl border border-slate-200 p-4">
    <Check label={title} checked={change.enabled} onChange={e => onChange({ ...change, enabled: e.target.checked })} />
    {change.enabled && <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <Select label="Como alterar" value={change.mode} onChange={e => onChange({ ...change, mode: e.target.value as AdjustMode })}>{modes.map(mode => <option key={mode} value={mode}>{MODE_LABELS[mode]}</option>)}</Select>
      <Field label={`Valor (${unitOf(change.mode)})`} inputMode="decimal" value={change.value} onChange={e => onChange({ ...change, value: e.target.value })} />
    </div>}
  </div>;
}

export default function BulkAdjustPage() {
  const [step, setStep] = useState(0);
  const [price, setPrice] = useState<Change>({ enabled: true, mode: 'INCREASE_PERCENT', value: '' });
  const [cost, setCost] = useState<Change>({ enabled: false, mode: 'INCREASE_PERCENT', value: '' });
  const [rounding, setRounding] = useState<AdjustRounding>('NONE');
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [situation, setSituation] = useState<'active' | 'inactive' | 'all'>('active');
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [preview, setPreview] = useState<BulkAdjustPreview | null>(null);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ updated: number; skipped: number } | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  useAutoLoad(async () => {
    try { setCategories((await api<ListResponse<ProductCategory>>('/products/categories')).items); } catch (e) { fail(e, 'Erro ao carregar categorias'); }
  });

  const adjustment = () => ({
    price: price.enabled ? { mode: price.mode, value: parseValue(price.value) } : null,
    cost: cost.enabled ? { mode: cost.mode, value: parseValue(cost.value) } : null,
    rounding: price.enabled ? rounding : 'NONE',
  });
  const selection = () => ({ ...(q.trim() ? { q: q.trim() } : {}), ...(categoryId ? { categoryId } : {}), ...(situation === 'all' ? {} : { active: situation === 'active' }) });

  function goToSelection() {
    setNotice(null);
    if (!price.enabled && !cost.enabled) { setNotice({ text: 'Escolha alterar o preço, o custo ou ambos.', kind: 'error' }); return; }
    if ((price.enabled && !validValue(price)) || (cost.enabled && !validValue(cost))) { setNotice({ text: 'Informe valores maiores que zero.', kind: 'error' }); return; }
    setStep(1);
  }
  async function buildPreview() {
    setNotice(null); setBusy(true);
    try {
      const result = await api<BulkAdjustPreview>('/product-tools/bulk-adjust/preview', { method: 'POST', body: JSON.stringify({ selection: selection(), ...adjustment() }) });
      setPreview(result); setExcluded([]); setConfirmed(false); setStep(2);
    } catch (e) { fail(e, 'Erro ao gerar a prévia'); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    const productIds = preview.items.filter(item => !item.skipped && !excluded.includes(item.id)).map(item => item.id);
    setNotice(null); setBusy(true);
    try {
      const result = await api<{ updated: number; skipped: number }>('/product-tools/bulk-adjust/apply', { method: 'POST', body: JSON.stringify({ selection: { productIds }, ...adjustment() }) });
      setDone(result); setPreview(null);
    } catch (e) { fail(e, 'Erro ao aplicar as alterações'); }
    finally { setBusy(false); }
  }
  function restart() { setDone(null); setPreview(null); setExcluded([]); setConfirmed(false); setStep(0); setNotice(null); }

  const included = preview ? preview.items.filter(item => !item.skipped && !excluded.includes(item.id)) : [];
  const changeText = (label: string, change: Change) => `${label}: ${MODE_LABELS[change.mode].replace(/ \(.*\)$/, '').toLowerCase()} ${change.value.trim()}${unitOf(change.mode) === '%' ? '%' : ''}${unitOf(change.mode) === 'R$' ? ' R$' : ''}`;

  return <AppShell title="Ajuste de preços em massa">
    <PageHeader title="Ajuste de preços em massa" subtitle="Reajuste preço e custo de vários produtos de uma vez, conferindo a prévia antes de aplicar." />
    <ol className="mb-4 grid gap-2 sm:grid-cols-4" aria-label="Etapas">
      {STEPS.map((label, index) => <li key={label} aria-current={!done && step === index ? 'step' : undefined} className={`rounded-xl border px-3 py-2 text-sm font-semibold ${!done && step === index ? 'border-neutral-950 bg-neutral-950 text-brand-300' : index < step || done ? 'border-brand-300 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-500'}`}>{index + 1}. {label}</li>)}
    </ol>
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {done ? <section className={panelClass}>
      <h2 className="text-lg font-semibold">Alterações aplicadas</h2>
      <p className="mt-2 text-sm text-slate-600">{done.updated} produto(s) atualizado(s){done.skipped ? `, ${done.skipped} ignorado(s)` : ''}. A operação foi registrada na auditoria.</p>
      <button type="button" className={`${buttonClass} mt-4`} onClick={restart}>Novo ajuste</button>
    </section> : <>
      {step === 0 && <section className={panelClass}>
        <h2 className="mb-4 text-lg font-semibold">1. O que alterar</h2>
        <div className="space-y-4">
          <ChangeEditor title="Alterar o preço de venda" change={price} onChange={setPrice} allowMargin />
          {price.enabled && <div className="max-w-sm"><Select label="Arredondamento do novo preço" value={rounding} onChange={e => setRounding(e.target.value as AdjustRounding)}>{(Object.keys(ROUNDING_LABELS) as AdjustRounding[]).map(key => <option key={key} value={key}>{ROUNDING_LABELS[key]}</option>)}</Select></div>}
          <ChangeEditor title="Alterar o custo" change={cost} onChange={setCost} allowMargin={false} />
          <p className="text-xs text-slate-500">Se alterar custo e margem juntos, a margem usa o custo já atualizado. Produtos sem custo são ignorados na margem. Valores que ficariam zerados ou negativos também são ignorados.</p>
        </div>
        <button type="button" className={`${buttonClass} mt-5`} onClick={goToSelection}>Continuar</button>
      </section>}
      {step === 1 && <section className={panelClass}>
        <h2 className="mb-4 text-lg font-semibold">2. Quais produtos</h2>
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Buscar por nome, código ou código de barras" type="search" value={q} onChange={e => setQ(e.target.value)} />
          <Select label="Categoria" value={categoryId} onChange={e => setCategoryId(e.target.value)}><option value="">Todas</option><option value="none">Sem categoria</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</Select>
          <Select label="Situação" value={situation} onChange={e => setSituation(e.target.value as 'active' | 'inactive' | 'all')}><option value="active">Somente ativos</option><option value="inactive">Somente inativos</option><option value="all">Todos</option></Select>
        </div>
        <p className="mt-3 text-xs text-slate-500">Sem filtros, todos os produtos da situação escolhida entram na prévia (até 1000). Na prévia você poderá desmarcar produtos individualmente.</p>
        <div className="mt-5 flex gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setStep(0)}>Voltar</button><button type="button" className={buttonClass} disabled={busy} onClick={() => void buildPreview()}>{busy ? 'Calculando...' : 'Gerar prévia'}</button></div>
      </section>}
      {step === 2 && preview && <section>
        <h2 className="mb-3 text-lg font-semibold">3. Prévia (antes → depois)</h2>
        {preview.items.length === 0 ? <EmptyState icon="🔎" title="Nenhum produto encontrado" hint="Volte e ajuste os filtros." />
          : <DataTable columns={[{ label: 'Aplicar' }, { label: 'Produto' }, { label: 'Categoria' }, { label: 'Preço' }, { label: 'Custo' }, { label: 'Situação' }]} footer={`${preview.changed} a alterar · ${preview.skipped} ignorado(s) · ${excluded.length} desmarcado(s)`}>
            {preview.items.map(item => <tr key={item.id} className={item.skipped ? 'bg-slate-50 text-slate-500' : ''}>
              <td><input type="checkbox" aria-label={`Aplicar em ${item.name}`} disabled={item.skipped} checked={!item.skipped && !excluded.includes(item.id)} onChange={e => setExcluded(current => (e.target.checked ? current.filter(id => id !== item.id) : [...current, item.id]))} /></td>
              <td className="font-semibold">{item.name}</td><td>{item.category ?? '—'}</td>
              <td className="whitespace-nowrap">{formatMoney(item.priceBefore)}{!item.skipped && item.priceAfter !== item.priceBefore && <> → <strong>{formatMoney(item.priceAfter)}</strong></>}</td>
              <td className="whitespace-nowrap">{item.costBefore === null ? '—' : formatMoney(item.costBefore)}{!item.skipped && item.costAfter !== null && item.costAfter !== item.costBefore && <> → <strong>{formatMoney(item.costAfter)}</strong></>}</td>
              <td>{item.skipped ? <Badge tone="amber">Ignorado: {item.reason}</Badge> : <Badge tone="green">Será alterado</Badge>}</td>
            </tr>)}
          </DataTable>}
        <div className="mt-4 flex gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setStep(1)}>Voltar</button><button type="button" className={buttonClass} disabled={included.length === 0} onClick={() => { setConfirmed(false); setStep(3); }}>Revisar ({included.length})</button></div>
      </section>}
      {step === 3 && preview && <section className={panelClass}>
        <h2 className="mb-3 text-lg font-semibold">4. Revisar e aplicar</h2>
        <ul className="list-inside list-disc space-y-1 text-sm text-slate-700">
          {price.enabled && <li>{changeText('Preço', price)}{rounding !== 'NONE' ? ` · ${ROUNDING_LABELS[rounding].toLowerCase()}` : ''}</li>}
          {cost.enabled && <li>{changeText('Custo', cost)}</li>}
          <li><strong>{included.length}</strong> produto(s) serão alterados; {preview.items.length - included.length} ficam como estão.</li>
        </ul>
        <div className="mt-4"><Check label="Conferi a prévia e confirmo a alteração destes produtos." checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /></div>
        <div className="mt-5 flex gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setStep(2)}>Voltar à prévia</button><button type="button" className={buttonClass} disabled={!confirmed || busy || included.length === 0} onClick={() => void apply()}>{busy ? 'Aplicando...' : 'Aplicar alterações'}</button></div>
      </section>}
    </>}
  </AppShell>;
}
