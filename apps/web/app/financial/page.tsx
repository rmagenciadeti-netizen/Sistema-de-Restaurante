'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, errorMessage, formatDateTime, formatMoney, ListResponse, Unit } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

type Entry = { id: string; description: string; type: 'INCOME' | 'EXPENSE'; category: string | null; amount: string; paidAmount: string | number; debtorName?: string | null; orderId?: string | null; status: 'OPEN' | 'PAID' | 'CANCELLED'; dueAt: string | null; settledAt: string | null; unitId: string | null; supplier?: { name: string } | null; customer?: { name: string } | null; costCenter?: { name: string } | null; bankAccount?: { name: string } | null; documentNumber?: string | null; installmentNumber?: number | null; installmentCount?: number | null; paymentMethod?: string | null; interestAmount?: string | number; discountAmount?: string | number; notes?: string | null };
type Summary = { revenue: string | number; expenses: string | number; openReceivables: string | number; openPayables: string | number };
const statuses = { OPEN: 'Em aberto', PAID: 'Baixada', CANCELLED: 'Cancelada' };
const pageSize = 25;

function FinancialContent() {
  // /financial?type=EXPENSE|INCOME opens the screen already filtered (menu entries Contas a pagar / Contas a receber).
  const typeParam = useSearchParams().get('type'); const initialType = typeParam === 'EXPENSE' || typeParam === 'INCOME' ? typeParam : '';
  const [form, setForm] = useState({ description: '', type: initialType || 'EXPENSE', category: '', amount: '', dueAt: '', unitId: '' });
  const [type, setType] = useState(initialType); const [status, setStatus] = useState('');
  const [applied, setApplied] = useState({ type: initialType, status: '' });
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [items, setItems] = useState<Entry[]>([]); const [units, setUnits] = useState<Unit[]>([]); const [summary, setSummary] = useState<Summary | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null); const [busy, setBusy] = useState(false);

  async function load(nextPage: number, filters: { type: string; status: string }) {
    const query = new URLSearchParams({ page: String(nextPage), pageSize: String(pageSize) });
    if (filters.type) query.set('type', filters.type);
    if (filters.status) query.set('status', filters.status);
    const [entries, totals, locations] = await Promise.all([
      api<ListResponse<Entry>>(`/financial/entries?${query}`),
      api<Summary>('/financial/summary'),
      api<ListResponse<Unit>>('/units'),
    ]);
    setItems(entries.items); setTotal(entries.total); setSummary(totals); setUnits(locations.items); setPage(nextPage); setApplied(filters);
  }
  useAutoLoad(async () => {
    try { await load(1, { type: initialType, status: '' }); }
    catch (error) { setMessage({ text: errorMessage(error, 'Erro ao carregar financeiro'), kind: 'error' }); }
  });

  async function refresh(nextPage: number, filters: { type: string; status: string }) {
    setBusy(true); setMessage(null);
    try { await load(nextPage, filters); }
    catch (error) { setMessage({ text: errorMessage(error, 'Erro ao carregar financeiro'), kind: 'error' }); }
    finally { setBusy(false); }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(null);
    try {
      await api('/financial/entries', { method: 'POST', body: JSON.stringify({
        description: form.description, type: form.type, amount: Number(form.amount),
        ...(form.category ? { category: form.category } : {}),
        ...(form.unitId ? { unitId: form.unitId } : {}),
        ...(form.dueAt ? { dueAt: new Date(`${form.dueAt}T12:00:00`).toISOString() } : {}),
      }) });
      setForm({ description: '', type: 'EXPENSE', category: '', amount: '', dueAt: '', unitId: '' });
      try {
        await load(1, applied);
        setMessage({ text: 'Conta registrada. Nenhum pagamento externo foi realizado.', kind: 'success' });
      } catch (error) {
        setMessage({ text: `Conta registrada, mas a atualização falhou: ${errorMessage(error, 'erro de comunicação')}. Atualize a lista antes de continuar.`, kind: 'error' });
      }
    } catch (error) { setMessage({ text: errorMessage(error, 'Erro ao registrar conta'), kind: 'error' }); }
    finally { setBusy(false); }
  }

  async function settle(entry: Entry) {
    if (!window.confirm(`Registrar a baixa integral de ${entry.description} (${formatMoney(entry.amount)})? Esta operação não transfere dinheiro.`)) return;
    setBusy(true); setMessage(null);
    try {
      await api(`/financial/entries/${entry.id}/settle`, { method: 'POST' });
      try {
        await load(page, applied);
        setMessage({ text: 'Baixa registrada. Nenhum pagamento externo foi realizado.', kind: 'success' });
      } catch (error) {
        setMessage({ text: `Baixa registrada, mas a atualização falhou: ${errorMessage(error, 'erro de comunicação')}. Atualize a lista antes de continuar.`, kind: 'error' });
      }
    } catch (error) { setMessage({ text: errorMessage(error, 'Erro ao registrar baixa'), kind: 'error' }); }
    finally { setBusy(false); }
  }

  return <AppShell title={initialType === 'EXPENSE' ? 'Contas a pagar' : initialType === 'INCOME' ? 'Contas a receber' : 'Financeiro'}>
    {message && <Notice message={message.text} kind={message.kind} />}
    <p className="mb-5 text-sm text-slate-600">Controle gerencial: a baixa registra o pagamento ou recebimento já realizado fora do sistema; não executa transferências.</p>
    {summary && <section className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
      ['A receber', summary.openReceivables], ['A pagar', summary.openPayables], ['Receitas baixadas', summary.revenue], ['Despesas baixadas', summary.expenses],
    ].map(([label, value]) => <div key={label} className={panelClass}><p className="text-sm text-slate-500">{label}</p><p className="mt-2 text-xl font-semibold">{formatMoney(value)}</p></div>)}</section>}
    <section className={`${panelClass} mb-6`}>
      <h2 className="mb-4 text-lg font-semibold">Nova conta</h2>
      <form onSubmit={create} className="grid gap-4 md:grid-cols-3">
        <Field label="Descrição" required minLength={2} maxLength={200} value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} />
        <Select label="Tipo" value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}><option value="EXPENSE">A pagar</option><option value="INCOME">A receber</option></Select>
        <Field label="Valor (R$)" type="number" min="0.01" max="9999999999.99" step="0.01" required value={form.amount} onChange={event => setForm({ ...form, amount: event.target.value })} />
        <Field label="Categoria" maxLength={100} value={form.category} onChange={event => setForm({ ...form, category: event.target.value })} />
        <Field label="Vencimento" type="date" value={form.dueAt} onChange={event => setForm({ ...form, dueAt: event.target.value })} />
        <Select label="Unidade" value={form.unitId} onChange={event => setForm({ ...form, unitId: event.target.value })}><option value="">Unidade da conta / geral</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>
        <div><button className={buttonClass} disabled={busy}>Registrar conta</button></div>
      </form>
    </section>
    <section className={panelClass}>
      <h2 className="mb-4 text-lg font-semibold">Contas</h2>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void refresh(1, { type, status }); }}>
        <Select label="Tipo" value={type} onChange={event => setType(event.target.value)}><option value="">Todos</option><option value="EXPENSE">A pagar</option><option value="INCOME">A receber</option></Select>
        <Select label="Situação" value={status} onChange={event => setStatus(event.target.value)}><option value="">Todas</option><option value="OPEN">Em aberto</option><option value="PAID">Baixada</option><option value="CANCELLED">Cancelada</option></Select>
        <button className={buttonClass} disabled={busy}>Filtrar</button>
      </form>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-slate-500"><tr><th className="p-2">Descrição</th><th className="p-2">Tipo</th><th className="p-2">Unidade</th><th className="p-2">Vencimento</th><th className="p-2">Valor</th><th className="p-2">Situação / baixa</th><th className="p-2">Ação</th></tr></thead><tbody>
        {items.map(entry => <tr key={entry.id} className="border-t border-slate-200"><td className="p-2">{entry.description}{(entry.supplier || entry.customer) && <div className="text-xs text-slate-500">{entry.supplier ? 'Fornecedor' : 'Cliente'}: {(entry.supplier ?? entry.customer)!.name}</div>}{entry.debtorName && !entry.supplier && !entry.customer && <div className="text-xs text-slate-500">Responsável: {entry.debtorName}</div>}{(entry.documentNumber || entry.installmentNumber) && <div className="text-xs text-slate-500">{entry.documentNumber ? `Doc. ${entry.documentNumber}` : ''}{entry.installmentNumber ? ` · Parcela ${entry.installmentNumber}${entry.installmentCount ? `/${entry.installmentCount}` : ''}` : ''}</div>}{entry.category && <div className="text-xs text-slate-500">{entry.category}{entry.costCenter ? ` · ${entry.costCenter.name}` : ''}</div>}{(entry.bankAccount || entry.paymentMethod) && <div className="text-xs text-slate-500">{[entry.bankAccount?.name, entry.paymentMethod].filter(Boolean).join(' · ')}</div>}{(Number(entry.interestAmount ?? 0) > 0 || Number(entry.discountAmount ?? 0) > 0) && <div className="text-xs text-slate-500">Juros {formatMoney(entry.interestAmount)} · Desconto {formatMoney(entry.discountAmount)}</div>}{entry.notes && <div className="text-xs text-slate-500">{entry.notes}</div>}</td><td className="p-2">{entry.type === 'EXPENSE' ? 'A pagar' : 'A receber'}</td><td className="p-2">{units.find(unit => unit.id === entry.unitId)?.name ?? (entry.unitId ? 'Unidade indisponível' : 'Geral')}</td><td className="p-2">{entry.dueAt ? new Date(entry.dueAt).toLocaleDateString('pt-BR') : '—'}{entry.status === 'OPEN' && entry.dueAt && new Date(entry.dueAt) < new Date() && <div className="text-xs font-semibold text-red-600">Vencida</div>}</td><td className="p-2">{formatMoney(entry.status === 'OPEN' ? Number(entry.amount) - Number(entry.paidAmount ?? 0) : entry.amount)}{Number(entry.paidAmount ?? 0) > 0 && entry.status === 'OPEN' && <div className="text-xs text-slate-500">Original {formatMoney(entry.amount)}</div>}</td><td className="p-2">{statuses[entry.status]}{entry.settledAt && <div className="text-xs text-slate-500">{formatDateTime(entry.settledAt)}</div>}</td><td className="p-2">{entry.status === 'OPEN' && <button className={secondaryButtonClass} disabled={busy || Boolean(entry.orderId)} title={entry.orderId ? 'Registre pagamentos pela tela do pedido/caixa.' : undefined} onClick={() => void settle(entry)}>{entry.orderId ? 'Pelo pedido' : 'Registrar baixa'}</button>}</td></tr>)}
      </tbody></table></div>
      {items.length === 0 && <p className="mt-3 text-sm text-slate-500">Nenhuma conta encontrada.</p>}
      <div className="mt-4 flex items-center gap-3 text-sm text-slate-500"><button className={secondaryButtonClass} disabled={busy || page <= 1} onClick={() => void refresh(page - 1, applied)}>Anterior</button><span>Página {page} · {total} conta(s)</span><button className={secondaryButtonClass} disabled={busy || page * pageSize >= total} onClick={() => void refresh(page + 1, applied)}>Próxima</button></div>
    </section>
  </AppShell>;
}

export default function FinancialPage() {
  return <Suspense fallback={null}><FinancialContent /></Suspense>;
}
