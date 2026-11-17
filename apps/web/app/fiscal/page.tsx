'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError, api, errorMessage, FiscalDocument, formatDateTime, formatMoney, ListResponse, Order, storedUser } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';

const statusLabel: Record<string, string> = { PENDING: 'Pendente', AUTHORIZED: 'Autorizado', REJECTED: 'Rejeitado', CANCELLED: 'Cancelado' };
const statusTone: Record<string, string> = { AUTHORIZED: 'text-emerald-300', PENDING: 'text-amber-300', REJECTED: 'text-red-300', CANCELLED: 'text-slate-400' };

export default function FiscalPage() {
  const [providers, setProviders] = useState<string[] | null>(null); const [documents, setDocuments] = useState<FiscalDocument[]>([]); const [orders, setOrders] = useState<Order[]>([]); const [contingency, setContingency] = useState<{ startedAt: string; reason: string } | null>(null);
  const [numbering, setNumbering] = useState({ series: '1', nextNumber: '1' }); const [numberingBusy, setNumberingBusy] = useState(false);
  const canEditNumbering = ['ADMIN', 'MANAGER'].includes(storedUser().role ?? '');
  const [form, setForm] = useState({ orderId: '', provider: '', kind: 'NFCE' }); const [cancelling, setCancelling] = useState<string | null>(null); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load() {
    try {
      const [p, d, o, c, n] = await Promise.all([api<{ items: string[] }>('/fiscal/providers'), api<ListResponse<FiscalDocument>>('/fiscal/documents'), api<ListResponse<Order>>('/orders?pageSize=100'), api<{ active: { startedAt: string; reason: string } | null }>('/fiscal-registry/contingency').catch(() => ({ active: null })), api<{ items: { kind: string; series: string; nextNumber: number }[] }>('/fiscal/numbering').catch(() => ({ items: [] }))]);
      setContingency(c.active);
      const nfce = n.items.find(item => item.kind === 'NFCE'); if (nfce) setNumbering({ series: nfce.series, nextNumber: String(nfce.nextNumber) });
      setProviders(p.items); setDocuments(d.items); setOrders(o.items.filter(order => order.status !== 'CANCELLED'));
      setForm(current => ({ ...current, provider: current.provider || p.items[0] || '' }));
    } catch (e) { fail(e, 'Erro ao carregar documentos fiscais'); }
  }
  useAutoLoad(load);

  async function emit(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setBusy(true);
    try {
      await api(`/fiscal/orders/${form.orderId}/emit`, { method: 'POST', body: JSON.stringify({ provider: form.provider, kind: form.kind }) });
      setNotice({ text: 'Documento fiscal autorizado.', kind: 'success' }); setForm(current => ({ ...current, orderId: '' }));
    } catch (e) { if (e instanceof ApiError && e.status === 422) setNotice({ text: `Documento rejeitado pelo provedor: ${e.message}. Corrija e tente emitir novamente.`, kind: 'error' }); else fail(e, 'Erro ao emitir documento fiscal'); } finally { setBusy(false); await load(); }
  }
  async function saveNumbering(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setNumberingBusy(true);
    try { await api('/fiscal/numbering', { method: 'PUT', body: JSON.stringify({ kind: 'NFCE', series: numbering.series.trim(), nextNumber: Number(numbering.nextNumber) }) }); setNotice({ text: 'Numeração da NFC-e salva.', kind: 'success' }); } catch (e) { fail(e, 'Erro ao salvar a numeração'); } finally { setNumberingBusy(false); await load(); }
  }
  async function cancel(document: FiscalDocument) {
    setBusy(true); setNotice(null);
    try { await api(`/fiscal/documents/${document.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }); setNotice({ text: 'Documento cancelado.', kind: 'success' }); setCancelling(null); setReason(''); } catch (e) { fail(e, 'Erro ao cancelar documento'); } finally { setBusy(false); await load(); }
  }
  const orderCode = (document: FiscalDocument) => document.order?.code ?? orders.find(order => order.id === document.orderId)?.code ?? 'Pedido';

  return <AppShell title="Documentos fiscais">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {contingency && <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Contingência fiscal em andamento desde {formatDateTime(contingency.startedAt)}: {contingency.reason}. Gerencie em <a className="font-semibold underline" href="/contingency">Contingências</a>.</p>}
    <section className={`${panelClass} mb-6`}><h2 className="mb-1 text-lg font-semibold">Numeração da NFC-e</h2>
      <p className="mb-4 text-sm text-slate-500">Cada NFC-e emitida (inclusive pelo quadro de pedidos) recebe o próximo número da série abaixo, em sequência. A tributação de cada item vem da regra tributária do produto, cadastrada em <Link href="/tax-rules" className="font-semibold text-brand-700 hover:text-brand-600">Fiscal / Tributos</Link>.</p>
      <form onSubmit={saveNumbering} className="grid gap-4 md:grid-cols-4"><Field label="Série" required inputMode="numeric" pattern="\d{1,3}" maxLength={3} disabled={!canEditNumbering} value={numbering.series} onChange={e => setNumbering({ ...numbering, series: e.target.value })} /><Field label="Próximo número" required type="number" min="1" step="1" disabled={!canEditNumbering} value={numbering.nextNumber} onChange={e => setNumbering({ ...numbering, nextNumber: e.target.value })} />{canEditNumbering ? <div className="flex items-end"><button className={buttonClass} disabled={numberingBusy}>{numberingBusy ? 'Salvando...' : 'Salvar numeração'}</button></div> : <p className="self-end text-sm text-slate-500 md:col-span-2">Somente administradores e gerentes alteram a numeração.</p>}</form></section>
    <section className={`${panelClass} mb-6`}><h2 className="mb-4 text-lg font-semibold">Emitir documento</h2>
      {providers && providers.length === 0 ? <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Nenhum provedor fiscal configurado; a emissão não está disponível.</p>
        : <form onSubmit={emit} className="grid gap-4 md:grid-cols-4">
          <Select label="Pedido" required value={form.orderId} onChange={e => setForm({ ...form, orderId: e.target.value })}><option value="">Selecione</option>{orders.map(order => <option key={order.id} value={order.id}>{order.code} — {formatMoney(order.total)}{order.customerName ? ` — ${order.customerName}` : ''}</option>)}</Select>
          <Select label="Provedor" required value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>{(providers ?? []).map(name => <option key={name} value={name}>{name}</option>)}</Select>
          <Select label="Tipo" value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="NFCE">NFC-e</option><option value="NFE">NF-e</option></Select>
          <div className="flex items-end"><button className={buttonClass} disabled={busy || !form.orderId || !form.provider}>{busy ? 'Emitindo...' : 'Emitir'}</button></div>
          {orders.length === 0 && <p className="text-sm text-slate-400 md:col-span-4">Nenhum pedido disponível para emissão.</p>}
        </form>}
    </section>
    <section className={panelClass}><h2 className="mb-4 text-lg font-semibold">Documentos ({documents.length})</h2><div className="grid gap-3">{documents.map(document => <article key={document.id} className="rounded-lg border border-slate-800 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{document.kind === 'NFE' ? 'NF-e' : 'NFC-e'} · {orderCode(document)} <span className={`text-xs font-normal ${statusTone[document.status]}`}>{statusLabel[document.status] ?? document.status}</span></h3><p className="mt-1 text-sm text-slate-400">{document.provider} · {formatDateTime(document.createdAt)}{document.number ? ` · nº ${document.number}` : ''}{document.series ? ` · série ${document.series}` : ''}{document.order ? ` · ${formatMoney(document.order.total)}` : ''}</p>{document.accessKey && <p className="mt-1 break-all text-xs text-slate-500">Chave: {document.accessKey}</p>}{document.error && <p className="mt-1 text-sm text-red-300">Motivo: {document.error}</p>}{document.documentUrl && <a href={document.documentUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-sm text-blue-300 hover:text-white">Abrir documento</a>}</div>{document.status === 'AUTHORIZED' && <button className={secondaryButtonClass} onClick={() => { setCancelling(cancelling === document.id ? null : document.id); setReason(''); }}>Cancelar documento</button>}</div>
      {cancelling === document.id && <div className="mt-3 flex flex-wrap items-end gap-3"><div className="min-w-64 flex-1"><Field label={`Motivo do cancelamento (${reason.trim().length}/15 mín.)`} minLength={15} maxLength={255} value={reason} onChange={e => setReason(e.target.value)} /></div><button className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50" disabled={busy || reason.trim().length < 15} onClick={() => void cancel(document)}>Confirmar cancelamento</button></div>}</article>)}</div>{documents.length === 0 && <p className="text-slate-400">Nenhum documento fiscal emitido.</p>}</section>
  </AppShell>;
}
