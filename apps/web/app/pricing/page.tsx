'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from '../../components/nav-link';
import { api, errorMessage, formatMoney, ListResponse, ProductCategory } from '../../lib/api';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, Select, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, StatCard, Tabs } from '../../components/ui';
import { STATUS_LABEL, type BulkPreview, type PanelResponse, type PanelRow, type PricingDefaults } from '../../lib/types-pricing';

const tabs = [{ key: 'panel', label: '📊 Painel de rentabilidade' }, { key: 'defaults', label: '⚙️ Padrões da empresa' }, { key: 'bulk', label: '🧮 Alteração em massa' }] as const;
type Tab = (typeof tabs)[number]['key'];
const pct = (value: number | null) => (value === null ? '—' : `${value.toFixed(2).replace('.', ',')}%`);

function ProductTable({ rows, empty }: { rows: PanelRow[]; empty: string }) {
  if (rows.length === 0) return <EmptyState icon="✅" title={empty} />;
  return <DataTable columns={[{ label: 'Produto' }, { label: 'Categoria' }, { label: 'Custo', className: 'text-right' }, { label: 'Preço', className: 'text-right' }, { label: 'ML', className: 'text-right' }, { label: 'MLA', className: 'text-right' }, { label: 'Recomendado', className: 'text-right' }, { label: 'Situação' }]}>
    {rows.map(row => <tr key={row.id}>
      <td className="font-medium"><Link className="text-brand-700 hover:underline" href={`/products?edit=${row.id}`}>{row.name}</Link></td><td>{row.category}</td>
      <td className="text-right">{formatMoney(row.totalCost)}</td><td className="text-right">{formatMoney(row.price)}</td><td className="text-right">{pct(row.ml)}</td>
      <td className={`text-right font-semibold ${row.status === 'NEGATIVE' ? 'text-red-700' : ''}`}>{pct(row.mla)}</td><td className="text-right">{formatMoney(row.recommendedPrice)}</td>
      <td><Badge tone={STATUS_LABEL[row.status].tone}>{STATUS_LABEL[row.status].label}</Badge></td>
    </tr>)}
  </DataTable>;
}

export default function PricingPage() {
  const [tab, setTab] = useState<Tab>('panel');
  const [message, setMessage] = useState(''); const [ok, setOk] = useState(false);
  const fail = (cause: unknown, fallback: string) => { setOk(false); setMessage(errorMessage(cause, fallback)); };
  const [panel, setPanel] = useState<PanelResponse | null>(null);
  const [defaults, setDefaults] = useState<Record<keyof PricingDefaults, string> | null>(null);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [bulk, setBulk] = useState({ categoryId: '', marginPercent: '', keepIndividualMargins: true, onlyIncreases: false });
  const [preview, setPreview] = useState<BulkPreview | null>(null); const [busy, setBusy] = useState(false);

  const [taxReview, setTaxReview] = useState<{ fiscalRegime: string | null; note: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const [panelData, settings, categoryList] = await Promise.all([api<PanelResponse>('/pricing/panel'), api<{ defaults: PricingDefaults; taxReview?: { fiscalRegime: string | null; note: string } }>('/pricing/settings'), api<ListResponse<ProductCategory>>('/products/categories')]);
      setPanel(panelData); setCategories(categoryList.items); setTaxReview(settings.taxReview ?? null);
      setDefaults(Object.fromEntries(Object.entries(settings.defaults).map(([key, value]) => [key, String(value)])) as Record<keyof PricingDefaults, string>);
    } catch (cause) { fail(cause, 'Falha ao carregar a rentabilidade'); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function saveDefaults() {
    if (!defaults) return;
    setBusy(true); setMessage('');
    try {
      await api('/pricing/settings', { method: 'PUT', body: JSON.stringify({ marginPercent: Number(defaults.marginPercent), taxPercent: Number(defaults.taxPercent), cardFeePercent: Number(defaults.cardFeePercent), commissionPercent: Number(defaults.commissionPercent), operationalCostPercent: Number(defaults.operationalCostPercent), otherVariablePercent: Number(defaults.otherVariablePercent), rounding: defaults.rounding }) });
      await load(); setOk(true); setMessage('Padrões salvos. Os preços dos produtos não foram alterados.');
    } catch (cause) { fail(cause, 'Falha ao salvar os padrões'); } finally { setBusy(false); }
  }
  const bulkBody = () => ({ ...(bulk.categoryId ? { categoryId: bulk.categoryId } : {}), ...(bulk.marginPercent.trim() !== '' ? { marginPercent: Number(bulk.marginPercent) } : {}), keepIndividualMargins: bulk.keepIndividualMargins, onlyIncreases: bulk.onlyIncreases });
  async function simulate() {
    setBusy(true); setMessage(''); setPreview(null);
    try { setPreview(await api<BulkPreview>('/pricing/bulk/preview', { method: 'POST', body: JSON.stringify(bulkBody()) })); } catch (cause) { fail(cause, 'Falha ao simular'); } finally { setBusy(false); }
  }
  async function apply() {
    if (!preview || preview.count === 0) return;
    if (!window.confirm(`Aplicar os novos preços em ${preview.count} produto(s)? Cada alteração fica registrada no histórico.`)) return;
    setBusy(true); setMessage('');
    try { const result = await api<{ updated: number }>('/pricing/bulk/apply', { method: 'POST', body: JSON.stringify({ ...bulkBody(), confirm: true, expectedCount: preview.count }) }); setPreview(null); await load(); setOk(true); setMessage(`${result.updated} preço(s) atualizado(s).`); }
    catch (cause) { fail(cause, 'Falha ao aplicar'); } finally { setBusy(false); }
  }
  const setDefault = (key: keyof PricingDefaults) => (event: React.ChangeEvent<HTMLInputElement>) => setDefaults(current => current && { ...current, [key]: event.target.value });

  return <AppShell title="Formação de preço e rentabilidade">
    <PageHeader title="Formação de preço e rentabilidade" subtitle="Margem sobre o custo, encargos por dentro do preço, preço mínimo e recomendado. Nenhum preço oficial muda sem a sua confirmação." />
    <p className="-mt-2 mb-4 text-sm text-slate-600">Veja também o resultado real do período em <Link href="/profit" className="font-semibold text-brand-700 hover:underline">RM Controle de Lucro</Link>.</p>
    {message && <Notice message={message} kind={ok ? 'success' : 'error'} />}
    <Tabs tabs={[...tabs]} value={tab} onChange={setTab} label="Seções de preço" />
    {tab === 'panel' && (!panel ? <p className="text-sm text-slate-500">Carregando…</p> : <div className="space-y-6">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="📈" label="ML médio (sobre o custo)" value={pct(panel.summary.averageMl)} hint={`${panel.analyzed} produto(s) com custo`} />
        <StatCard icon="💹" label="MLA médio (após encargos)" value={pct(panel.summary.averageMla)} hint="Preço atual, descontando tributos, taxas e despesas" tone="dark" />
        <StatCard icon="🔻" label="Em prejuízo" value={panel.summary.negative} hint={`${panel.summary.belowTarget} abaixo da meta · ${panel.summary.onTarget} dentro da meta`} />
        <StatCard icon="🧾" label="Margem realizada no mês" value={pct(panel.summary.realizedMl)} hint={`Receita ${formatMoney(panel.summary.realizedRevenue)} · custo congelado ${formatMoney(panel.summary.realizedCost)}`} />
      </div>
      {panel.withoutCost.length > 0 && <Notice message={`${panel.withoutCost.length} produto(s) ativo(s) sem custo cadastrado ficam fora da análise: ${panel.withoutCost.slice(0, 5).map(item => item.name).join(', ')}${panel.withoutCost.length > 5 ? '…' : ''}`} />}
      <section><h3 className="mb-2 font-semibold">Produtos em prejuízo</h3><ProductTable rows={panel.negative} empty="Nenhum produto vendido abaixo do custo." /></section>
      <section><h3 className="mb-2 font-semibold">Abaixo da margem desejada</h3><ProductTable rows={panel.belowTarget} empty="Todos os produtos atingem a margem desejada." /></section>
      <section><h3 className="mb-2 font-semibold">Mais rentáveis</h3><ProductTable rows={panel.mostProfitable} empty="Sem produtos com custo e preço." /></section>
      <section><h3 className="mb-2 font-semibold">Menos rentáveis</h3><ProductTable rows={panel.leastProfitable} empty="Sem produtos com custo e preço." /></section>
      <section><h3 className="mb-2 font-semibold">Por categoria</h3>{panel.byCategory.length === 0 ? <EmptyState title="Sem dados" /> : <DataTable columns={[{ label: 'Categoria' }, { label: 'Produtos', className: 'text-right' }, { label: 'ML médio', className: 'text-right' }, { label: 'MLA médio', className: 'text-right' }]}>
        {panel.byCategory.map(row => <tr key={row.category}><td className="font-medium">{row.category}</td><td className="text-right">{row.products}</td><td className="text-right">{pct(row.averageMl)}</td><td className="text-right">{pct(row.averageMla)}</td></tr>)}</DataTable>}</section>
    </div>)}
    {tab === 'defaults' && defaults && <section className={panelClass}>
      <h3 className="mb-1 text-lg font-semibold">Padrões da empresa</h3>
      {taxReview && <Notice message={`${taxReview.fiscalRegime ? `Regime tributário cadastrado no Fiscal: ${taxReview.fiscalRegime.replace(/_/g, ' ')}. ` : 'Regime tributário ainda não cadastrado no Fiscal. '}${taxReview.note}`} />}
      <p className="mb-4 text-sm text-slate-600">Valem para todo produto que não tiver valor próprio. Alterar os padrões não muda o preço de nenhum produto.</p>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Margem de lucro padrão (% sobre o custo)" type="number" min="0" step="0.1" value={defaults.marginPercent} onChange={setDefault('marginPercent')} />
        <Field label="Tributos (% do preço)" type="number" min="0" max="60" step="0.01" value={defaults.taxPercent} onChange={setDefault('taxPercent')} />
        <Field label="Taxa de cartão (% do preço)" type="number" min="0" max="30" step="0.01" value={defaults.cardFeePercent} onChange={setDefault('cardFeePercent')} />
        <Field label="Comissão (% do preço)" type="number" min="0" max="60" step="0.01" value={defaults.commissionPercent} onChange={setDefault('commissionPercent')} />
        <Field label="Custo operacional (% do preço)" type="number" min="0" max="60" step="0.01" value={defaults.operationalCostPercent} onChange={setDefault('operationalCostPercent')} />
        <Field label="Outras despesas variáveis (% do preço)" type="number" min="0" max="60" step="0.01" value={defaults.otherVariablePercent} onChange={setDefault('otherVariablePercent')} />
        <Select label="Arredondamento do preço recomendado (sempre para cima)" value={defaults.rounding} onChange={event => setDefaults({ ...defaults, rounding: event.target.value as PricingDefaults['rounding'] })}>
          <option value="NONE">Sem arredondamento (centavo)</option><option value="UP_10_CENTS">Para cima, de R$ 0,10 em R$ 0,10</option><option value="UP_TO_90">Terminar em ,90</option>
        </Select>
      </div>
      <div className="mt-4"><button type="button" className={buttonClass} disabled={busy} onClick={() => void saveDefaults()}>Salvar padrões</button></div>
    </section>}
    {tab === 'bulk' && <section className={`${panelClass} space-y-4`}>
      <h3 className="text-lg font-semibold">Alteração de preços em massa</h3>
      <p className="text-sm text-slate-600">Primeiro simule: nada é gravado. Só depois de revisar a lista e confirmar os preços oficiais são alterados. Produtos sem custo nunca são alterados.</p>
      <div className="grid gap-4 md:grid-cols-3">
        <Select label="Categoria" value={bulk.categoryId} onChange={event => { setBulk({ ...bulk, categoryId: event.target.value }); setPreview(null); }}><option value="">Todas as categorias</option>{categories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</Select>
        <Field label="Margem a aplicar (% sobre o custo)" type="number" min="0" step="0.1" placeholder="Em branco: padrão da empresa" value={bulk.marginPercent} onChange={event => { setBulk({ ...bulk, marginPercent: event.target.value }); setPreview(null); }} />
        <div className="space-y-2 pt-6"><Check label="Preservar a margem individual dos produtos que têm margem própria" checked={bulk.keepIndividualMargins} onChange={event => { setBulk({ ...bulk, keepIndividualMargins: event.target.checked }); setPreview(null); }} />
          <Check label="Apenas aumentar preços" checked={bulk.onlyIncreases} onChange={event => { setBulk({ ...bulk, onlyIncreases: event.target.checked }); setPreview(null); }} /></div>
      </div>
      <div className="flex gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => void simulate()}>Simular</button>
        {preview && preview.count > 0 && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void apply()}>Confirmar e aplicar {preview.count} preço(s)</button>}</div>
      {preview && <div className="space-y-3">
        <p className="text-sm font-medium">{preview.count} produto(s) seriam alterados · {preview.skipped.length} ignorado(s)</p>
        {preview.count > 0 && <DataTable columns={[{ label: 'Produto' }, { label: 'Custo', className: 'text-right' }, { label: 'Preço atual', className: 'text-right' }, { label: 'Novo preço', className: 'text-right' }, { label: 'Diferença', className: 'text-right' }, { label: 'MLA novo', className: 'text-right' }]}>
          {preview.rows.map(row => <tr key={row.id}><td className="font-medium">{row.name}</td><td className="text-right">{formatMoney(row.cost)}</td><td className="text-right">{formatMoney(row.currentPrice)}</td><td className="text-right font-semibold">{formatMoney(row.newPrice)}</td>
            <td className={`text-right ${row.difference < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{row.difference > 0 ? '+' : ''}{formatMoney(row.difference)}</td><td className="text-right">{row.newMla ? `${row.newMla.replace('.', ',')}%` : '—'}</td></tr>)}</DataTable>}
        {preview.skipped.length > 0 && <details className="text-xs text-slate-600"><summary className="cursor-pointer">Ignorados ({preview.skipped.length})</summary><ul className="mt-1 list-disc pl-5">{preview.skipped.slice(0, 100).map(item => <li key={item.id}>{item.name}: {item.reason}</li>)}</ul></details>}
      </div>}
    </section>}
  </AppShell>;
}
