'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, API_BASE, errorMessage, formatMoney, ListResponse, ReportOverview, ServiceFeeDistribution, tokenStorageKey, WaiterReportRow } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { REPORT_CATALOG, REPORT_OPTIONS, ReportTable } from '../../lib/types-reports';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { PageHeader, StatCard } from '../../components/ui';
import { ReportTableView, tableToCsv } from '../../components/report-table';
import type { SettingsResponse, TenantSettings } from '../../lib/settings';

const pad = (value: number) => String(value).padStart(2, '0');
const dayString = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const startOf = (day: string) => new Date(`${day}T00:00:00`).toISOString();
const endOf = (day: string) => new Date(`${day}T23:59:59.999`).toISOString();
const methodLabel: Record<string, string> = { CASH: 'Dinheiro', PIX: 'PIX', CREDIT_CARD: 'Cartão de crédito', DEBIT_CARD: 'Cartão de débito', VOUCHER: 'Vale-refeição', OTHER: 'Outro' };
const groups = Array.from(new Set(REPORT_CATALOG.map(item => item.group)));
const periodless = new Set(['availability']);

type Period = { from: string; to: string };
const shortcuts: { label: string; range: () => Period }[] = [
  { label: 'Hoje', range: () => ({ from: dayString(new Date()), to: dayString(new Date()) }) },
  { label: '7 dias', range: () => ({ from: dayString(new Date(Date.now() - 6 * 86_400_000)), to: dayString(new Date()) }) },
  { label: 'Mês', range: () => { const now = new Date(); return { from: dayString(new Date(now.getFullYear(), now.getMonth(), 1)), to: dayString(now) }; } },
];

const text = (key: string, label: string) => ({ key, label, type: 'text' as const });
const money = (key: string, label: string) => ({ key, label, type: 'money' as const });
const num = (key: string, label: string) => ({ key, label, type: 'number' as const });

// The overview and the fee split come from the pre-existing endpoints; they are mapped to the same tabular shape as the other reports.
function overviewTables(overview: ReportOverview, waiters: WaiterReportRow[], period: ReportTable['period']) {
  const payments: ReportTable = { kind: 'overview-payments', period, columns: [text('method', 'Forma'), num('count', 'Qtd.'), money('amount', 'Valor')], rows: overview.paymentsByMethod.map(row => ({ method: methodLabel[row.method] ?? row.method, count: row._count, amount: row._sum.amount ?? '0' })) };
  const best: ReportTable = { kind: 'overview-best', period, columns: [text('name', 'Produto'), num('quantity', 'Qtd.'), money('sales', 'Vendas')], rows: overview.bestSellers.map(row => ({ name: row.name, quantity: row.quantity ?? 0, sales: row.sales ?? '0' })) };
  const attendants: ReportTable = { kind: 'overview-waiters', period, columns: [text('name', 'Atendente'), num('orders', 'Pedidos'), money('sales', 'Vendas'), money('serviceFee', 'Taxa de serviço'), money('total', 'Total')], rows: waiters.map(row => ({ name: row.name, orders: row.orders, sales: row.sales ?? '0', serviceFee: row.serviceFee ?? '0', total: row.total ?? '0' })) };
  return { payments, best, attendants };
}

function distributionTable(data: ServiceFeeDistribution): ReportTable {
  return {
    kind: 'service-fee-distribution', period: data.period,
    columns: [text('name', 'Atendente'), money('serviceFeeCollected', 'Taxa arrecadada'), money('waiterAmount', 'Parte do atendente'), money('poolAmount', 'Fundo a distribuir'), money('commission', 'Comissão')],
    rows: data.items.map(item => ({ ...item })), totals: { name: 'Totais', ...data.totals },
  };
}

type Loaded = { table?: ReportTable; overview?: { cards: [string, string][]; tables: ReturnType<typeof overviewTables> } };

function ReportView({ kind, period, onPeriod }: { kind: string; period: Period; onPeriod: (period: Period) => void }) {
  const item = REPORT_CATALOG.find(entry => entry.kind === kind)!;
  const option = REPORT_OPTIONS[kind];
  const [from, setFrom] = useState(period.from); const [to, setTo] = useState(period.to); const [choice, setChoice] = useState('');
  const [message, setMessage] = useState(''); const [loading, setLoading] = useState(false); const [exporting, setExporting] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({});
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const request = useRef(0);

  useEffect(() => {
    let active = true;
    api<SettingsResponse>('/settings').then(result => { if (active) setSettings(result.settings); })
      .catch(e => { if (active) setMessage(errorMessage(e, 'Não foi possível carregar as configurações de impressão')); })
      .finally(() => { if (active) setSettingsLoading(false); });
    return () => { active = false; };
  }, []);

  const queryFor = (start: string, end: string, filter: string) => `from=${encodeURIComponent(startOf(start))}&to=${encodeURIComponent(endOf(end))}${option && filter ? `&${option.param}=${encodeURIComponent(filter)}` : ''}`;

  async function load(start = from, end = to, filter = choice) {
    if (start > end) { setMessage('A data inicial não pode ser posterior à data final.'); return; }
    const current = ++request.current;
    setLoading(true); setMessage('');
    try {
      const query = queryFor(start, end, filter);
      let next: Loaded;
      if (kind === 'overview') {
        const [overview, waiters] = await Promise.all([api<ReportOverview>(`/reports/overview?${query}`), api<Pick<ListResponse<WaiterReportRow>, 'items'>>(`/reports/waiters?${query}`)]);
        const totals = overview.totals;
        next = { overview: { cards: [['Pedidos', String(overview.orders)], ['Subtotal', formatMoney(totals.subtotal)], ['Taxa de serviço', formatMoney(totals.serviceFee)], ['Entrega', formatMoney(totals.deliveryFee)], ['Descontos', formatMoney(totals.discount)], ['Total vendido', formatMoney(totals.total)], ['Despesas pagas', formatMoney(overview.paidExpenses)]], tables: overviewTables(overview, waiters.items, overview.period) } };
      } else if (kind === 'service-fee-distribution') next = { table: distributionTable(await api<ServiceFeeDistribution>(`/reports/service-fee-distribution?${query}`)) };
      else next = { table: await api<ReportTable>(`/reports/x/${kind}?${query}`) };
      if (current !== request.current) return;
      setLoaded(next);
    } catch (e) { if (current === request.current) setMessage(errorMessage(e, 'Erro ao carregar o relatório')); } finally { if (current === request.current) setLoading(false); }
  }
  useAutoLoad(() => load());

  function apply(next: Period) { setFrom(next.from); setTo(next.to); onPeriod(next); void load(next.from, next.to); }

  async function exportCsv() {
    setExporting(true); setMessage('');
    try {
      let blob: Blob;
      if (loaded.table && kind === 'service-fee-distribution') blob = new Blob([tableToCsv(loaded.table)], { type: 'text/csv;charset=utf-8' });
      else if (loaded.overview) {
        const { payments, best, attendants } = loaded.overview.tables;
        const sections = [['Recebimentos por forma', payments], ['Mais vendidos', best], ['Vendas por atendente', attendants]] as const;
        blob = new Blob([`\uFEFF${sections.map(([title, table]) => `${title}\r\n${tableToCsv(table).replace('\uFEFF', '')}`).join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
      }
      else {
        const token = localStorage.getItem(tokenStorageKey);
        const response = await fetch(`${API_BASE}/reports/x/${kind}?${queryFor(from, to, choice)}&format=csv`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
        if (!response.ok) throw new Error('Não foi possível exportar o relatório');
        blob = await response.blob();
      }
      if (settings?.printing.companyHeaderOnReports) {
        const company = settings.company;
        const header = [company.tradeName || company.legalName, company.document, [company.address, company.number, company.district, company.city, company.state].filter(Boolean).join(', '), company.phone].filter(Boolean);
        if (header.length > 0) {
          const content = (await blob.text()).replace(/^\uFEFF/, '');
          blob = new Blob([`\uFEFF${header.join('\r\n')}\r\n\r\n${content}`], { type: 'text/csv;charset=utf-8' });
        }
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob); link.download = `relatorio-${kind}-${from}_${to}.csv`; link.click();
      URL.revokeObjectURL(link.href);
    } catch (e) { setMessage(errorMessage(e, 'Erro ao exportar')); } finally { setExporting(false); }
  }

  const periodLabel = periodless.has(kind) ? 'Situação atual' : `${from.split('-').reverse().join('/')} a ${to.split('-').reverse().join('/')}`;
  return <div className="min-w-0 flex-1">
    <PageHeader title={item.title} subtitle={item.description} actions={<>
      <button type="button" className={secondaryButtonClass} onClick={() => void exportCsv()} disabled={settingsLoading || exporting || loading || (!loaded.table && !loaded.overview)}>{exporting ? 'Exportando…' : '⬇ Exportar CSV'}</button>
      <button type="button" className={secondaryButtonClass} onClick={() => window.print()} disabled={settingsLoading || loading}>🖨 Imprimir</button>
    </>} />
    {message && <Notice message={message} />}
    {settings?.printing.companyHeaderOnReports && <div className="hidden text-center text-xs print:mb-4 print:block">
      <strong>{settings.company.tradeName || settings.company.legalName}</strong>
      {[settings.company.document, [settings.company.address, settings.company.number, settings.company.district, settings.company.city, settings.company.state].filter(Boolean).join(', '), settings.company.phone].filter(Boolean).map(line => <p key={line}>{line}</p>)}
    </div>}
    <section className={`${panelClass} mb-4 print:hidden`} aria-label="Filtros">
      <form onSubmit={event => { event.preventDefault(); apply({ from, to }); }} className="flex flex-wrap items-end gap-3">
        {!periodless.has(kind) && <>
          <Field label="De" type="date" required value={from} onChange={e => setFrom(e.target.value)} />
          <Field label="Até" type="date" required min={from || undefined} value={to} onChange={e => setTo(e.target.value)} />
          <div className="flex gap-1" role="group" aria-label="Atalhos de período">{shortcuts.map(shortcut => <button key={shortcut.label} type="button" className={secondaryButtonClass} onClick={() => apply(shortcut.range())}>{shortcut.label}</button>)}</div>
        </>}
        {option && <Select label={option.label} value={choice} onChange={event => { setChoice(event.target.value); void load(from, to, event.target.value); }}>{option.choices.map(entry => <option key={entry.value} value={entry.value}>{entry.label}</option>)}</Select>}
        <button className={buttonClass} disabled={loading}>{loading ? 'Carregando…' : periodless.has(kind) ? 'Atualizar' : 'Aplicar período'}</button>
      </form>
    </section>
    <p className="mb-3 hidden text-sm print:block"><strong>{item.title}</strong> — {periodLabel}</p>
    {loading && !loaded.table && !loaded.overview && <p className="text-sm text-slate-500" role="status">Carregando…</p>}
    {loaded.table && <div aria-busy={loading} className={loading ? 'opacity-60' : undefined}><ReportTableView table={loaded.table} /></div>}
    {loaded.overview && <div aria-busy={loading} className={`space-y-4 ${loading ? 'opacity-60' : ''}`}>
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{loaded.overview.cards.map(([label, value]) => <StatCard key={label} label={label} value={value} />)}</section>
      <div className="grid gap-4 xl:grid-cols-2">
        <section><h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Recebimentos por forma</h3><ReportTableView table={loaded.overview.tables.payments} /></section>
        <section><h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Mais vendidos</h3><ReportTableView table={loaded.overview.tables.best} /></section>
      </div>
      <section><h3 className="mb-2 text-sm font-bold uppercase tracking-wider text-slate-600">Vendas por atendente (pedidos concluídos)</h3><ReportTableView table={loaded.overview.tables.attendants} /></section>
    </div>}
    {kind === 'service-fee-distribution' && <p className="mt-3 text-sm text-slate-500">A parte do atendente usa o percentual definido na unidade; o restante forma o fundo a ser distribuído pelas regras do restaurante.</p>}
  </div>;
}

function ReportsCenter() {
  const router = useRouter();
  const requested = useSearchParams().get('r') ?? 'overview';
  const kind = REPORT_CATALOG.some(entry => entry.kind === requested) ? requested : 'overview';
  const [period, setPeriod] = useState<Period>(() => shortcuts[0].range());

  return <AppShell title="Central de relatórios">
    <div className="gap-6 lg:flex lg:items-start">
      <div className="mb-4 lg:hidden print:hidden"><Select label="Relatório" value={kind} onChange={event => router.push(`/reports?r=${event.target.value}`)}>
        {groups.map(group => <optgroup key={group} label={group}>{REPORT_CATALOG.filter(entry => entry.group === group).map(entry => <option key={entry.kind} value={entry.kind}>{entry.title}</option>)}</optgroup>)}
      </Select></div>
      <nav aria-label="Relatórios" className="hidden w-64 shrink-0 space-y-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:sticky lg:top-20 lg:block print:hidden">
        {groups.map(group => <section key={group}>
          <h2 className="px-2 pb-1 text-[11px] font-bold uppercase tracking-wider text-slate-500">{group}</h2>
          <ul className="space-y-0.5">{REPORT_CATALOG.filter(entry => entry.group === group).map(entry => <li key={entry.kind}>
            <Link href={`/reports?r=${entry.kind}`} aria-current={entry.kind === kind ? 'page' : undefined} className={`block rounded-lg px-3 py-2 text-sm transition ${entry.kind === kind ? 'bg-neutral-950 font-semibold text-brand-300' : 'text-slate-700 hover:bg-slate-100'}`}>{entry.title}</Link>
          </li>)}</ul>
        </section>)}
      </nav>
      <ReportView key={kind} kind={kind} period={period} onPeriod={setPeriod} />
    </div>
  </AppShell>;
}

export default function ReportsPage() {
  return <Suspense fallback={null}><ReportsCenter /></Suspense>;
}
