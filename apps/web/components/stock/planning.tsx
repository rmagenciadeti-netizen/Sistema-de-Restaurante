'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAutoLoad } from '../../lib/use-auto-load';
import { api, errorMessage, formatDateTime, formatMoney, type ListResponse, type Supplier } from '../../lib/api';
import { buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable, EmptyState, Tabs } from '../ui';

type Suggestion = { ingredientId: string; name: string; unitOfMeasure: string; current: number; minimum: number | null; maximum: number | null; quantity: number; reason: 'BELOW_MINIMUM' | 'LOW_COVERAGE'; coverageDays: number | null; target: number; unitCost: number; estimatedCost: number; supplier: { id: string; name: string } | null };
type Suggestions = { items: Suggestion[]; estimatedTotal: number; note: string; windowDays: number };
type Expiring = { days: number; items: { id: string; name: string; unitOfMeasure: string; currentStock: string; expiresAt: string; state: 'EXPIRED' | 'EXPIRING' | 'OK'; valueAtRisk: string }[] };
type SessionRow = { id: string; title: string; scope: 'FULL' | 'PARTIAL' | 'CATEGORY'; category: string | null; status: 'OPEN' | 'CLOSED' | 'CANCELLED'; createdAt: string; closedAt: string | null; lineCount: number; countedCount: number; adjustedCount: number; adjustmentValue: string };
type SessionLine = { id: string; ingredientId: string; name: string; unitOfMeasure: string; expected: string; counted: string | null; adjustment: string | null };
type SessionDetail = SessionRow & { lines: SessionLine[] };
type Notice_ = { text: string; kind: 'error' | 'success' } | null;
const scopeLabel = { FULL: 'Completo', PARTIAL: 'Parcial', CATEGORY: 'Por categoria' } as const;
const statusLabel = { OPEN: 'Em andamento', CLOSED: 'Concluído', CANCELLED: 'Cancelado' } as const;
const statusTone = { OPEN: 'blue', CLOSED: 'green', CANCELLED: 'neutral' } as const;
const tabs: { key: 'suggestions' | 'expiring' | 'counts'; label: string }[] = [{ key: 'suggestions', label: '🛒 Sugestão de compra' }, { key: 'expiring', label: '⏳ Vencimentos' }, { key: 'counts', label: '📋 Inventários' }];
type Tab = (typeof tabs)[number]['key'];

function SuggestionsTab({ onNotice, onChanged }: { onNotice: (notice: Notice_) => void; onChanged: () => void }) {
  const [data, setData] = useState<Suggestions | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [fallback, setFallback] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<Suggestions>('/inventory/suggestions'));
      setSuppliers((await api<ListResponse<Supplier>>('/purchasing/suppliers').catch(() => ({ items: [] as Supplier[], total: 0 }))).items);
    } catch (cause) { onNotice({ text: errorMessage(cause, 'Falha ao calcular as sugestões'), kind: 'error' }); }
  }, [onNotice]);
  useAutoLoad(load);

  // One draft purchase per supplier (the last one that sold the item, or the one chosen here for items without history).
  async function createOrders() {
    if (!data) return;
    setBusy(true); onNotice(null);
    try {
      const groups = new Map<string, Suggestion[]>();
      for (const item of data.items) { const supplierId = item.supplier?.id ?? fallback; if (supplierId) groups.set(supplierId, [...(groups.get(supplierId) ?? []), item]); }
      for (const [supplierId, items] of Array.from(groups.entries())) await api('/purchasing/orders', { method: 'POST', body: JSON.stringify({ supplierId, items: items.map(item => ({ ingredientId: item.ingredientId, quantity: item.quantity, unitCost: item.unitCost })) }) });
      onNotice({ text: `${groups.size} pedido(s) de compra criado(s) para recebimento em Compras.`, kind: 'success' }); onChanged();
    } catch (cause) { onNotice({ text: errorMessage(cause, 'Não foi possível criar os pedidos (apenas gerência e financeiro compram)'), kind: 'error' }); } finally { setBusy(false); }
  }
  if (!data) return <p className="text-sm text-slate-500">Calculando…</p>;
  const withoutSupplier = data.items.filter(item => !item.supplier).length;
  return <>
    <p className="mb-3 text-xs text-slate-600">{data.note}</p>
    {data.items.length === 0 ? <EmptyState icon="✅" title="Nada a comprar agora" hint="Nenhum insumo está abaixo do mínimo ou com cobertura de até 7 dias." /> : <>
      <DataTable columns={[{ label: 'Insumo' }, { label: 'Saldo' }, { label: 'Mín. / Máx.' }, { label: 'Cobertura' }, { label: 'Comprar' }, { label: 'Custo est.' }, { label: 'Fornecedor' }]}>
        {data.items.map(item => <tr key={item.ingredientId}><td><strong>{item.name}</strong> <Badge tone={item.reason === 'BELOW_MINIMUM' ? 'red' : 'amber'}>{item.reason === 'BELOW_MINIMUM' ? 'Abaixo do mínimo' : 'Cobertura baixa'}</Badge></td><td>{item.current} {item.unitOfMeasure}</td><td>{item.minimum ?? '—'} / {item.maximum ?? '—'}</td><td>{item.coverageDays === null ? '—' : `${item.coverageDays} dia(s)`}</td><td><strong>{item.quantity} {item.unitOfMeasure}</strong></td><td>{formatMoney(item.estimatedCost)}</td><td>{item.supplier?.name ?? <span className="text-xs text-slate-500">sem histórico</span>}</td></tr>)}
      </DataTable>
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <p className="text-sm font-semibold">Total estimado: {formatMoney(data.estimatedTotal)}</p>
        {withoutSupplier > 0 && <div className="w-64"><Select label={`Fornecedor para ${withoutSupplier} item(ns) sem histórico`} value={fallback} onChange={event => setFallback(event.target.value)}><option value="">Não incluir nos pedidos</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</Select></div>}
        <button type="button" className={buttonClass} disabled={busy} onClick={() => void createOrders()}>{busy ? 'Criando…' : 'Criar pedidos de compra'}</button>
      </div>
    </>}
  </>;
}

function ExpiringTab({ onNotice }: { onNotice: (notice: Notice_) => void }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<Expiring | null>(null);
  useEffect(() => { let active = true; api<Expiring>(`/inventory/expiring?days=${days}`).then(result => { if (active) setData(result); }).catch(cause => { if (active) onNotice({ text: errorMessage(cause, 'Falha ao carregar vencimentos'), kind: 'error' }); }); return () => { active = false; }; }, [days, onNotice]);
  return <>
    <div className="mb-3 w-48"><Field label="Vencem em até (dias)" type="number" min={1} max={90} value={days} onChange={event => setDays(Math.min(90, Math.max(1, Number(event.target.value) || 7)))} /></div>
    <p className="mb-3 text-xs text-slate-600">A validade é a do lote mais antigo em estoque, informada na entrada (compra/recebimento) ou na edição do insumo; zera quando o saldo acaba.</p>
    {!data ? <p className="text-sm text-slate-500">Carregando…</p> : data.items.length === 0 ? <EmptyState icon="🌿" title="Nenhum insumo vencendo no período" hint="Informe a validade nas entradas para acompanhar aqui." /> : <DataTable columns={[{ label: 'Insumo' }, { label: 'Saldo' }, { label: 'Validade' }, { label: 'Situação' }, { label: 'Valor em risco' }]}>
      {data.items.map(item => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{Number(item.currentStock)} {item.unitOfMeasure}</td><td>{new Date(item.expiresAt).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</td><td><Badge tone={item.state === 'EXPIRED' ? 'red' : 'amber'}>{item.state === 'EXPIRED' ? 'Vencido' : 'Vence em breve'}</Badge></td><td>{formatMoney(item.valueAtRisk)}</td></tr>)}
    </DataTable>}
  </>;
}

function CountsTab({ onNotice, onChanged }: { onNotice: (notice: Notice_) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ title: '', scope: 'FULL' as SessionRow['scope'], category: '' });
  const [busy, setBusy] = useState(false);
  const fail = useCallback((cause: unknown, fallback: string) => onNotice({ text: errorMessage(cause, fallback), kind: 'error' }), [onNotice]);
  const loadRows = useCallback(async () => { try { setRows((await api<{ items: SessionRow[] }>('/inventory/count-sessions')).items); } catch (cause) { fail(cause, 'Falha ao carregar inventários'); } }, [fail]);
  useAutoLoad(loadRows);

  async function open(id: string) {
    try {
      const session = await api<SessionDetail>(`/inventory/count-sessions/${id}`);
      setDetail(session); setValues(Object.fromEntries(session.lines.map(line => [line.ingredientId, line.counted === null ? '' : String(Number(line.counted))])));
    } catch (cause) { fail(cause, 'Falha ao abrir o inventário'); }
  }
  async function start(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); onNotice(null);
    try { const created = await api<SessionDetail>('/inventory/count-sessions', { method: 'POST', body: JSON.stringify({ title: form.title, scope: form.scope, ...(form.scope === 'CATEGORY' ? { category: form.category } : {}) }) }); setForm({ title: '', scope: 'FULL', category: '' }); await loadRows(); await open(created.id); }
    catch (cause) { fail(cause, 'Não foi possível iniciar o inventário'); } finally { setBusy(false); }
  }
  async function save() {
    if (!detail) return;
    const lines = detail.lines.map(line => ({ ingredientId: line.ingredientId, counted: values[line.ingredientId] === '' || values[line.ingredientId] === undefined ? null : Number(values[line.ingredientId]) }));
    await api(`/inventory/count-sessions/${detail.id}/lines`, { method: 'PUT', body: JSON.stringify({ lines }) });
  }
  async function act(kind: 'save' | 'close' | 'cancel') {
    if (!detail) return;
    if (kind === 'close' && !window.confirm('Concluir o inventário? O estoque será ajustado para as quantidades contadas (itens não contados não mudam). Esta ação não pode ser desfeita.')) return;
    setBusy(true); onNotice(null);
    try {
      if (kind === 'cancel') await api(`/inventory/count-sessions/${detail.id}/cancel`, { method: 'POST' });
      else { await save(); if (kind === 'close') { const result = await api<{ adjusted: number; uncounted: number; adjustmentValue: string }>(`/inventory/count-sessions/${detail.id}/close`, { method: 'POST' }); onNotice({ text: `Inventário concluído: ${result.adjusted} ajuste(s), ${result.uncounted} item(ns) não contado(s), diferença de ${formatMoney(result.adjustmentValue)}.`, kind: 'success' }); onChanged(); } else onNotice({ text: 'Contagem salva.', kind: 'success' }); }
      if (kind !== 'save') setDetail(null);
      await loadRows();
    } catch (cause) { fail(cause, 'Não foi possível concluir a operação (apenas a gerência fecha inventários)'); } finally { setBusy(false); }
  }

  const hasOpen = rows.some(row => row.status === 'OPEN');
  return <>
    {!detail && <>
      {!hasOpen && <form onSubmit={start} className="mb-5 grid gap-3 md:grid-cols-4"><Field label="Nome do inventário" required minLength={3} maxLength={120} value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} />
        <Select label="Tipo" value={form.scope} onChange={event => setForm({ ...form, scope: event.target.value as SessionRow['scope'] })}><option value="FULL">Completo (todos os insumos)</option><option value="CATEGORY">Por categoria</option></Select>
        {form.scope === 'CATEGORY' ? <Field label="Categoria" required maxLength={60} value={form.category} onChange={event => setForm({ ...form, category: event.target.value })} /> : <span />}
        <div className="flex items-end"><button className={buttonClass} disabled={busy}>Iniciar inventário</button></div></form>}
      {hasOpen && <Notice message="Há um inventário em andamento. Conclua ou cancele para iniciar outro." kind="success" />}
      {rows.length === 0 ? <EmptyState icon="📋" title="Nenhum inventário realizado" hint="Inicie uma contagem completa ou por categoria; os ajustes ficam auditados." /> : <DataTable columns={[{ label: 'Inventário' }, { label: 'Tipo' }, { label: 'Situação' }, { label: 'Itens' }, { label: 'Ajustes' }, { label: 'Diferença' }, { label: 'Data' }, { label: '' }]}>
        {rows.map(row => <tr key={row.id}><td><strong>{row.title}</strong></td><td>{scopeLabel[row.scope]}{row.category ? ` · ${row.category}` : ''}</td><td><Badge tone={statusTone[row.status]}>{statusLabel[row.status]}</Badge></td><td>{row.countedCount}/{row.lineCount} contados</td><td>{row.adjustedCount}</td><td>{formatMoney(row.adjustmentValue)}</td><td>{formatDateTime(row.closedAt ?? row.createdAt)}</td><td><button type="button" className={secondaryButtonClass} onClick={() => void open(row.id)}>{row.status === 'OPEN' ? 'Continuar' : 'Ver'}</button></td></tr>)}
      </DataTable>}
    </>}
    {detail && <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-bold">{detail.title} <Badge tone={statusTone[detail.status]}>{statusLabel[detail.status]}</Badge></h3><button type="button" className={secondaryButtonClass} onClick={() => setDetail(null)}>← Voltar</button></div>
      <DataTable columns={[{ label: 'Insumo' }, { label: 'Esperado' }, { label: 'Contado' }, { label: 'Diferença' }]}>
        {detail.lines.map(line => { const counted = values[line.ingredientId]; const difference = detail.status === 'CLOSED' ? line.adjustment : counted === '' || counted === undefined ? null : String(Number(counted) - Number(line.expected));
          return <tr key={line.id}><td><strong>{line.name}</strong></td><td>{Number(line.expected)} {line.unitOfMeasure}</td><td>{detail.status === 'OPEN' ? <input aria-label={`Contagem de ${line.name}`} type="number" min={0} step="0.001" className="w-32 rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-900" value={counted ?? ''} onChange={event => setValues(current => ({ ...current, [line.ingredientId]: event.target.value }))} /> : line.counted === null ? '—' : `${Number(line.counted)} ${line.unitOfMeasure}`}</td><td className={difference && Number(difference) !== 0 ? (Number(difference) < 0 ? 'text-red-700' : 'text-emerald-700') : ''}>{difference === null || difference === undefined ? '—' : `${Number(difference) > 0 ? '+' : ''}${Number(difference)}`}</td></tr>; })}
      </DataTable>
      {detail.status === 'OPEN' && <div className="mt-4 flex flex-wrap gap-3"><button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void act('save')}>Salvar contagem</button><button type="button" className={buttonClass} disabled={busy} onClick={() => void act('close')}>Concluir e ajustar estoque</button><button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void act('cancel')}>Cancelar inventário</button></div>}
    </>}
  </>;
}

// Planning tools of the stock screen: purchase suggestions, expiry watch and inventory sessions (all from real data).
export function StockPlanning({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState<Tab>('suggestions');
  const [notice, setNotice] = useState<Notice_>(null);
  return <section className={`${panelClass} mb-6`} aria-label="Planejamento de estoque">
    <h2 className="mb-3 text-lg font-semibold">Planejamento de estoque</h2>
    <Tabs tabs={tabs} value={tab} onChange={next => { setTab(next); setNotice(null); }} label="Planejamento de estoque" />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {tab === 'suggestions' && <SuggestionsTab onNotice={setNotice} onChanged={onChanged} />}
    {tab === 'expiring' && <ExpiringTab onNotice={setNotice} />}
    {tab === 'counts' && <CountsTab onNotice={setNotice} onChanged={onChanged} />}
  </section>;
}
