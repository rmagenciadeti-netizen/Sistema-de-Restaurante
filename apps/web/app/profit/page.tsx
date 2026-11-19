'use client';

import Link from '../../components/nav-link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, StatCard, Tabs } from '../../components/ui';
import { exportCsv, Section } from '../../components/commercial/common';
import { DonutChart } from '../../components/charts';

type Row = { key: string; name: string; revenue: number; cost: number; profit: number; marginPercent: number | null; units: number; costCoverage: number };
type Result = { grossRevenue: number; discounts: number; cancellations: { count: number; value: number }; netRevenue: number; received: number; cogs: number; costCoverage: number; grossProfit: number; cardFees: number; taxes: number; commissions: number; variableExpenses: number; fixedExpenses: number; contributionMargin: number; contributionMarginPercent: number | null; operatingResult: number; operatingMarginPercent: number | null; expensesByCategory: { category: string; amount: number; kind: 'FIXED' | 'VARIABLE' }[] };
type Config = { cardFeePercent: number; taxPercent: number; fixedCategories: string[]; includeCommissions: boolean };
type Summary = { truncated: boolean; config: Config; result: Result; previous: Result; byProduct: Row[]; byCategory: Row[]; byEmployee: Row[]; notes: string[] };
type Recipe = { id: string; name: string; category: string; price: number; registeredCost: number | null; recipeCost: number | null; complete: boolean; lines: { name: string; unit: string; quantity: number; unitCost: number; total: number }[]; packagingCost: number; margin: number | null; marginPercent: number | null; divergent: boolean };
type Waste = { items: { id: string; createdAt: string; ingredient: string; unit: string; quantity: number; reason: string; responsible: string; cost: number }[]; total: number; byIngredient: { name: string; cost: number }[]; byResponsible: { name: string; cost: number }[]; byReason: { name: string; cost: number }[]; unvalued: number };
type History = { id: string; entityId: string | null; createdAt: string; metadata: { name?: string; before?: number | null; after?: number }; actor: { name: string } | null };

const tabs = [{ key: 'result', label: '💹 Resultado' }, { key: 'profitability', label: '📊 Rentabilidade' }, { key: 'recipes', label: '🧾 Ficha técnica e CMV' }, { key: 'waste', label: '🗑️ Perdas' }, { key: 'method', label: '⚙️ Método de cálculo' }] as const;
type Tab = (typeof tabs)[number]['key'];
const monthStart = () => { const now = new Date(); return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);
const delta = (current: number, previous: number) => (previous === 0 ? null : Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10);
const pctText = (value: number | null) => (value === null ? '—' : `${value}%`);

function Line({ label, value, strong, negative, hint }: { label: string; value: number; strong?: boolean; negative?: boolean; hint?: string }) {
  return <div className={`flex items-baseline justify-between gap-3 border-b border-slate-100 py-2 text-sm ${strong ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
    <span>{label}{hint && <span className="block text-xs font-normal text-slate-500">{hint}</span>}</span><span className={negative ? 'text-red-700' : ''}>{negative ? '− ' : ''}{formatMoney(Math.abs(value))}</span>
  </div>;
}

export default function ProfitPage() {
  const [tab, setTab] = useState<Tab>('result');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<Summary | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [waste, setWaste] = useState<Waste | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [categoriesText, setCategoriesText] = useState('');
  const [margin, setMargin] = useState<Record<string, string>>({});
  const [suggested, setSuggested] = useState<Record<string, number | null>>({});
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const fail = (cause: unknown, fallback: string) => { setSuccess(false); setMessage(errorMessage(cause, fallback)); };

  const load = useCallback(async () => {
    const params = new URLSearchParams({ from: new Date(`${from}T00:00:00Z`).toISOString(), to: new Date(`${to}T23:59:59Z`).toISOString() });
    try {
      const [summary, wasteReport, recipeList, costHistory] = await Promise.all([api<Summary>(`/profit/summary?${params}`), api<Waste>(`/profit/waste?${params}`), api<{ items: Recipe[] }>('/profit/recipes'), api<{ items: History[] }>('/profit/cost-history')]);
      setData(summary); setConfig(summary.config); setCategoriesText(summary.config.fixedCategories.join(', ')); setWaste(wasteReport); setRecipes(recipeList.items); setHistory(costHistory.items);
    } catch (cause) { fail(cause, 'Falha ao carregar o controle de lucro'); }
  }, [from, to]);
  useEffect(() => { void load(); }, [load]);

  async function simulate(recipe: Recipe) {
    const cost = recipe.recipeCost ?? recipe.registeredCost;
    if (cost === null || margin[recipe.id] === undefined || margin[recipe.id] === '') return;
    try { const result = await api<{ suggestedPrice: number | null }>(`/profit/simulate?cost=${cost}&margin=${margin[recipe.id]}`); setSuggested(current => ({ ...current, [recipe.id]: result.suggestedPrice })); } catch (cause) { fail(cause, 'Margem inválida'); }
  }
  async function applyCost(recipe: Recipe) {
    if (!window.confirm(`Atualizar o custo de "${recipe.name}" para ${formatMoney(recipe.recipeCost)}? A alteração fica no histórico.`)) return;
    try { await api(`/profit/recipes/${recipe.id}/apply-cost`, { method: 'POST' }); setSuccess(true); setMessage(`Custo de ${recipe.name} atualizado.`); await load(); } catch (cause) { fail(cause, 'Falha ao aplicar o custo'); }
  }
  async function saveConfig(event: React.FormEvent) {
    event.preventDefault(); if (!config) return;
    const body = { ...config, fixedCategories: categoriesText.split(',').map(item => item.trim()).filter(Boolean) };
    try { await api('/settings/profit', { method: 'PUT', body: JSON.stringify(body) }); setSuccess(true); setMessage('Método de cálculo salvo.'); await load(); } catch (cause) { fail(cause, 'Falha ao salvar'); }
  }

  const result = data?.result; const previous = data?.previous;
  const rowsTable = (rows: Row[], label: string, file: string) => rows.length === 0 ? <EmptyState icon="📊" title="Sem vendas no período" /> : <>
    <div className="mb-2 flex justify-end"><button type="button" className={secondaryButtonClass} onClick={() => exportCsv(file, [label, 'Qtd.', 'Faturamento', 'Custo', 'Lucro bruto', 'Margem %', 'Cobertura do custo %'], rows.map(row => [row.name, row.units, row.revenue, row.cost, row.profit, row.marginPercent ?? '', row.costCoverage]))}>Exportar CSV</button></div>
    <DataTable columns={[{ label }, { label: 'Qtd.' }, { label: 'Faturamento' }, { label: 'Custo' }, { label: 'Lucro bruto' }, { label: 'Margem' }, { label: 'Custo cadastrado' }]}>
      {rows.map(row => <tr key={row.key}><td>{row.name}</td><td>{row.units}</td><td>{formatMoney(row.revenue)}</td><td>{formatMoney(row.cost)}</td><td className={row.profit < 0 ? 'text-red-700' : ''}>{formatMoney(row.profit)}</td><td>{pctText(row.marginPercent)}</td><td>{row.costCoverage >= 100 ? <Badge tone="green">100%</Badge> : <Badge tone={row.costCoverage === 0 ? 'red' : 'gold'}>{row.costCoverage}%</Badge>}</td></tr>)}
    </DataTable></>;

  return <AppShell title="RM Controle de Lucro">
    <PageHeader title="RM Controle de Lucro" subtitle="Quanto o restaurante realmente ganha: faturamento, recebimento, lucro bruto, margem de contribuição e resultado operacional, a partir dos dados registrados." />
    <p className="-mt-2 mb-4 text-sm text-slate-600">Para definir preços e margens por produto, use <Link href="/pricing" className="font-semibold text-brand-700 hover:underline">Formação de preço e rentabilidade</Link>. O percentual de impostos abaixo é informado por você: o sistema não presume alíquotas; confirme com seu contador.</p>
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <Section title="Período"><div className="grid gap-3 sm:grid-cols-4"><Field label="De" type="date" value={from} onChange={event => setFrom(event.target.value)} /><Field label="Até" type="date" value={to} onChange={event => setTo(event.target.value)} /><button type="button" className={`${secondaryButtonClass} self-end`} onClick={() => void load()}>Atualizar</button></div></Section>
    <Tabs tabs={tabs.map(item => ({ key: item.key, label: item.label }))} value={tab} onChange={setTab} label="Controle de lucro" />
    {!data && !message && <p className="text-sm text-slate-500">Calculando…</p>}
    {data && result && previous && tab === 'result' && <>
      {data.truncated && <Notice message="Período muito grande: parte dos itens vendidos foi desconsiderada na análise." />}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Faturamento líquido" value={formatMoney(result.netRevenue)} hint={delta(result.netRevenue, previous.netRevenue) === null ? 'Sem período anterior para comparar' : `${delta(result.netRevenue, previous.netRevenue)! >= 0 ? '+' : ''}${delta(result.netRevenue, previous.netRevenue)}% vs. período anterior`} />
        <StatCard label="Recebido (pagamentos)" value={formatMoney(result.received)} hint="Diferente de faturamento" />
        <StatCard label="Margem de contribuição" value={formatMoney(result.contributionMargin)} hint={`${pctText(result.contributionMarginPercent)} do faturamento`} />
        <StatCard tone="dark" label="Resultado operacional" value={formatMoney(result.operatingResult)} hint={`${pctText(result.operatingMarginPercent)} · anterior ${formatMoney(previous.operatingResult)}`} />
      </div>
      <Section title="Para onde vai o faturamento líquido" number={1}>
        {result.netRevenue > 0 ? <DonutChart centerLabel="Composição do faturamento líquido" format={formatMoney} slices={[{ label: 'CMV', value: result.cogs }, { label: 'Taxas de cartão', value: result.cardFees }, { label: 'Impostos', value: result.taxes }, { label: 'Comissões', value: result.commissions }, { label: 'Despesas variáveis', value: result.variableExpenses }, { label: 'Despesas fixas', value: result.fixedExpenses }, { label: 'Resultado operacional', value: Math.max(0, result.operatingResult) }].filter(slice => slice.value > 0)} /> : <p className="text-sm text-slate-500">Sem faturamento no período.</p>}
      </Section>
      <div className="grid gap-6 xl:grid-cols-2">
        <section className={panelClass}>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-base font-bold">Demonstrativo do período</h2><button type="button" className={secondaryButtonClass} onClick={() => exportCsv('resultado.csv', ['Indicador', 'Valor'], [['Faturamento bruto', result.grossRevenue], ['Descontos', result.discounts], ['Faturamento líquido', result.netRevenue], ['Recebido', result.received], ['Custo das mercadorias', result.cogs], ['Lucro bruto', result.grossProfit], ['Taxas de cartão (estimadas)', result.cardFees], ['Impostos (estimados)', result.taxes], ['Comissões', result.commissions], ['Despesas variáveis pagas', result.variableExpenses - result.cardFees - result.taxes - result.commissions], ['Margem de contribuição', result.contributionMargin], ['Despesas fixas', result.fixedExpenses], ['Resultado operacional', result.operatingResult]])}>Exportar CSV</button></div>
          <Line label="Faturamento bruto" value={result.grossRevenue} />
          <Line label="Descontos concedidos" value={result.discounts} negative />
          <Line strong label="Faturamento líquido" value={result.netRevenue} hint={`Cancelamentos fora do faturamento: ${result.cancellations.count} pedido(s), ${formatMoney(result.cancellations.value)}`} />
          <Line label="Custo das mercadorias vendidas (CMV)" value={result.cogs} negative hint={`Cobertura de custo: ${result.costCoverage}% do faturamento dos itens`} />
          <Line strong label="Lucro bruto" value={result.grossProfit} />
          <Line label="Taxas de cartão (estimadas)" value={result.cardFees} negative />
          <Line label="Impostos (estimados)" value={result.taxes} negative />
          <Line label="Comissões (parte do garçom na taxa de serviço)" value={result.commissions} negative />
          <Line label="Demais despesas variáveis pagas" value={result.variableExpenses - result.cardFees - result.taxes - result.commissions} negative />
          <Line strong label="Margem de contribuição" value={result.contributionMargin} />
          <Line label="Despesas fixas pagas" value={result.fixedExpenses} negative />
          <Line strong label="Resultado operacional estimado" value={result.operatingResult} />
          <ul className="mt-3 space-y-1 text-xs text-slate-500">{data.notes.map(note => <li key={note}>• {note}</li>)}</ul>
        </section>
        <section className={panelClass}>
          <h2 className="mb-2 text-base font-bold">Despesas pagas por categoria</h2>
          {result.expensesByCategory.length === 0 ? <EmptyState icon="🧾" title="Nenhuma despesa paga no período" /> : <DataTable columns={[{ label: 'Categoria' }, { label: 'Tipo' }, { label: 'Valor' }]}>{result.expensesByCategory.map(item => <tr key={item.category}><td>{item.category}</td><td><Badge tone={item.kind === 'FIXED' ? 'gold' : 'neutral'}>{item.kind === 'FIXED' ? 'Fixa' : 'Variável'}</Badge></td><td>{formatMoney(item.amount)}</td></tr>)}</DataTable>}
          <p className="mt-3 text-xs text-slate-500">A classificação fixa/variável é definida em “Método de cálculo”. Folha de pagamento entra aqui quando lançada como despesa paga.</p>
        </section>
      </div>
    </>}
    {data && tab === 'profitability' && <>
      <Section title="Por produto (30 maiores lucros)">{rowsTable(data.byProduct, 'Produto', 'lucro-produtos.csv')}</Section>
      <Section title="Por categoria">{rowsTable(data.byCategory, 'Categoria', 'lucro-categorias.csv')}</Section>
      <Section title="Por funcionário (quem lançou a venda)">{rowsTable(data.byEmployee, 'Funcionário', 'lucro-funcionarios.csv')}</Section>
    </>}
    {tab === 'recipes' && <>
      <Section title={`Fichas técnicas e custos (${recipes.length})`}>
        {recipes.length === 0 ? <EmptyState icon="🧾" title="Nenhuma ficha técnica cadastrada" hint="Cadastre a composição dos produtos em Estoque e fichas." /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Custo da ficha' }, { label: 'Preço' }, { label: 'Margem' }, { label: 'Custo do produto' }, { label: 'Simulação de preço' }, { label: 'Ações' }]}>
          {recipes.map(recipe => <tr key={recipe.id} className="align-top">
            <td><strong>{recipe.name}</strong><div className="text-xs text-slate-500">{recipe.category}</div><details className="text-xs text-slate-500"><summary className="cursor-pointer">Ingredientes</summary>{recipe.lines.map(line => <div key={line.name}>{line.name}: {line.quantity} {line.unit} × {formatMoney(line.unitCost)} = {formatMoney(line.total)}</div>)}</details></td>
            <td>{recipe.recipeCost === null ? <Badge tone="red">Incompleta</Badge> : formatMoney(recipe.recipeCost)}{recipe.packagingCost > 0 && <div className="text-xs text-slate-500">Embalagem cobrada: {formatMoney(recipe.packagingCost)}</div>}</td>
            <td>{formatMoney(recipe.price)}</td>
            <td>{recipe.margin === null ? '—' : `${formatMoney(recipe.margin)} (${recipe.marginPercent}%)`}</td>
            <td>{recipe.registeredCost === null ? 'Não definido' : formatMoney(recipe.registeredCost)}{recipe.divergent && <div><Badge tone="gold">Diferente da ficha</Badge></div>}</td>
            <td><div className="flex items-center gap-1"><input aria-label={`Margem desejada de ${recipe.name}`} type="number" min={0} max={99} placeholder="Margem %" value={margin[recipe.id] ?? ''} onChange={event => setMargin({ ...margin, [recipe.id]: event.target.value })} className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-xs" /><button type="button" className={secondaryButtonClass} onClick={() => void simulate(recipe)} disabled={recipe.recipeCost === null && recipe.registeredCost === null}>Simular</button></div>{suggested[recipe.id] != null && <p className="mt-1 text-xs font-semibold text-brand-700">Preço sugerido: {formatMoney(suggested[recipe.id])}</p>}</td>
            <td>{recipe.recipeCost !== null && (recipe.registeredCost === null || recipe.divergent) ? <button type="button" className={buttonClass} onClick={() => void applyCost(recipe)}>Aplicar custo ao produto</button> : null}</td>
          </tr>)}
        </DataTable>}
        <p className="mt-2 text-xs text-slate-500">O custo da ficha usa o custo médio de cada ingrediente (atualizado nas compras). Fichas com ingrediente sem custo ficam incompletas.</p>
      </Section>
      <Section title="Histórico de alteração de custos">{history.length === 0 ? <EmptyState title="Nenhuma alteração registrada" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Produto' }, { label: 'Antes' }, { label: 'Depois' }, { label: 'Responsável' }]}>{history.map(entry => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td>{entry.metadata.name ?? '—'}</td><td>{entry.metadata.before == null ? '—' : formatMoney(entry.metadata.before)}</td><td>{formatMoney(entry.metadata.after)}</td><td>{entry.actor?.name ?? '—'}</td></tr>)}</DataTable>}</Section>
    </>}
    {tab === 'waste' && waste && <>
      <div className="mb-6 grid gap-3 sm:grid-cols-3"><StatCard tone="dark" label="Perda financeira no período" value={formatMoney(waste.total)} hint={waste.unvalued > 0 ? `${waste.unvalued} lançamento(s) sem custo` : 'Valorizada pelo custo do insumo'} /><StatCard label="Lançamentos" value={waste.items.length} /><StatCard label="Maior causa" value={waste.byReason[0]?.name ?? '—'} hint={waste.byReason[0] ? formatMoney(waste.byReason[0].cost) : undefined} /></div>
      <div className="mb-6 grid gap-6 xl:grid-cols-3">{([['Por insumo', waste.byIngredient], ['Por responsável', waste.byResponsible], ['Por motivo', waste.byReason]] as const).map(([title, rows]) => <Section key={title} title={title}>{rows.length === 0 ? <p className="text-sm text-slate-500">Sem registros.</p> : <DataTable columns={[{ label: 'Nome' }, { label: 'Perda' }]}>{rows.slice(0, 8).map(row => <tr key={row.name}><td>{row.name}</td><td>{formatMoney(row.cost)}</td></tr>)}</DataTable>}</Section>)}</div>
      <Section title="Lançamentos" actions={<button type="button" className={secondaryButtonClass} onClick={() => exportCsv('perdas.csv', ['Data', 'Insumo', 'Quantidade', 'Motivo', 'Responsável', 'Valor'], waste.items.map(item => [formatDateTime(item.createdAt), item.ingredient, `${item.quantity} ${item.unit}`, item.reason, item.responsible, item.cost]))}>Exportar CSV</button>}>
        {waste.items.length === 0 ? <EmptyState icon="🗑️" title="Nenhuma perda registrada" hint="Registre perdas em Estoque e fichas → movimentação “Perda”, informando a justificativa." /> : <DataTable columns={[{ label: 'Data' }, { label: 'Insumo' }, { label: 'Qtd.' }, { label: 'Motivo' }, { label: 'Responsável' }, { label: 'Valor' }]}>{waste.items.map(item => <tr key={item.id}><td>{formatDateTime(item.createdAt)}</td><td>{item.ingredient}</td><td>{item.quantity} {item.unit}</td><td>{item.reason}</td><td>{item.responsible}</td><td>{formatMoney(item.cost)}</td></tr>)}</DataTable>}
      </Section>
    </>}
    {tab === 'method' && config && <form onSubmit={saveConfig} className={`${panelClass} max-w-2xl space-y-4`}>
      <h2 className="text-base font-bold">Método de cálculo</h2>
      <p className="text-sm text-slate-600">Taxas de cartão, impostos e a classificação de despesas fixas são parâmetros do seu estabelecimento. Sem eles, o resultado considera apenas custos e despesas efetivamente registrados.</p>
      <div className="grid gap-4 sm:grid-cols-2"><Field label="Taxa média de cartão (%)" type="number" min={0} max={30} step="0.01" value={config.cardFeePercent} onChange={event => setConfig({ ...config, cardFeePercent: Number(event.target.value) })} /><Field label="Impostos sobre o faturamento (%)" type="number" min={0} max={60} step="0.01" value={config.taxPercent} onChange={event => setConfig({ ...config, taxPercent: Number(event.target.value) })} /></div>
      <Field label="Categorias de despesas FIXAS (separadas por vírgula)" value={categoriesText} onChange={event => setCategoriesText(event.target.value)} />
      <Check label="Descontar comissões de garçom (parte da taxa de serviço)" checked={config.includeCommissions} onChange={event => setConfig({ ...config, includeCommissions: event.target.checked })} />
      <button className={buttonClass}>Salvar método</button>
    </form>}
  </AppShell>;
}
