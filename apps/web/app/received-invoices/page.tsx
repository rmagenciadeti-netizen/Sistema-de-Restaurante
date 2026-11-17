'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, errorMessage, formatDateTime, formatMoney, ListResponse } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs, textareaClass } from '../../components/ui';
import { formatDocument } from '../../lib/types-registry';
import { invoiceStatusLabel, type InvoiceItem, type InvoiceStatus, type OperationNature, type ParsedInvoice, type ReceivedInvoice } from '../../lib/types-fiscal';

type TabKey = 'received' | 'entry';
const tabs: { key: TabKey; label: string }[] = [{ key: 'received', label: 'Notas recebidas' }, { key: 'entry', label: 'Entrada de NF-e' }];
const statusTone: Record<InvoiceStatus, 'amber' | 'green' | 'red'> = { RECEIVED: 'amber', ENTERED: 'green', CANCELLED: 'red' };
const emptyForm = { accessKey: '', number: '', series: '1', supplierName: '', supplierDocument: '', issuedAt: '', totalAmount: '', natureId: '', notes: '' };

function InvoicesContent() {
  const initial = useSearchParams().get('tab');
  const [tab, setTab] = useState<TabKey>(initial === 'entry' ? 'entry' : 'received');
  const [items, setItems] = useState<ReceivedInvoice[]>([]); const [natures, setNatures] = useState<OperationNature[]>([]);
  const [q, setQ] = useState(''); const [status, setStatus] = useState('');
  const [form, setForm] = useState(emptyForm); const [xml, setXml] = useState<string | null>(null); const [xmlItems, setXmlItems] = useState<InvoiceItem[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const ok = (text: string) => setNotice({ text, kind: 'success' });
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });

  async function load(next: { q?: string; status?: string } = {}) {
    const params = new URLSearchParams(); const query = (next.q ?? q).trim(); const state = next.status ?? status;
    if (query) params.set('q', query);
    if (state) params.set('status', state);
    try {
      const [list, kinds] = await Promise.all([api<ListResponse<ReceivedInvoice>>(`/fiscal-registry/invoices?${params}`), api<ListResponse<OperationNature>>('/fiscal-registry/natures?active=true')]);
      setItems(list.items); setNatures(kinds.items.filter(nature => nature.direction === 'IN'));
    } catch (e) { fail(e, 'Erro ao carregar notas recebidas'); } finally { setLoaded(true); }
  }
  useAutoLoad(() => load());

  async function readXml(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    try {
      const text = await file.text();
      const parsed = await api<ParsedInvoice>('/fiscal-registry/invoices/parse-xml', { method: 'POST', body: JSON.stringify({ xml: text }) });
      setXml(text); setXmlItems(parsed.items);
      setForm(current => ({ ...current, accessKey: parsed.accessKey, number: parsed.number, series: parsed.series, supplierName: parsed.supplierName, supplierDocument: parsed.supplierDocument ?? '', issuedAt: parsed.issueDate, totalAmount: String(parsed.totalAmount) }));
      ok('XML lido. Confira os dados e escolha a natureza de operação antes de registrar.');
    } catch (e) { setXml(null); setXmlItems([]); fail(e, 'Não foi possível ler o XML'); }
  }
  function reset() { setForm(emptyForm); setXml(null); setXmlItems([]); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setNotice(null); setBusy(true);
    const body = { ...form, supplierDocument: form.supplierDocument || null, natureId: form.natureId || null, notes: form.notes || null, totalAmount: Number(form.totalAmount.replace(',', '.')), issuedAt: new Date(`${form.issuedAt}T12:00:00`).toISOString(), items: xmlItems, xml };
    try { await api('/fiscal-registry/invoices', { method: 'POST', body: JSON.stringify(body) }); reset(); ok('Nota registrada como Recebida. Use "Lançar entrada" na lista para concluí-la.'); setTab('received'); await load(); } catch (e) { fail(e, 'Erro ao registrar nota'); } finally { setBusy(false); }
  }
  async function act(invoice: ReceivedInvoice, action: 'enter' | 'cancel') {
    if (action === 'cancel' && !window.confirm(`Cancelar a nota ${invoice.number} de ${invoice.supplierName}?`)) return;
    try { await api(`/fiscal-registry/invoices/${invoice.id}/${action}`, { method: 'POST' }); ok(action === 'enter' ? 'Nota lançada.' : 'Nota cancelada.'); await load(); } catch (e) { fail(e, 'Erro ao atualizar nota'); }
  }
  async function download(invoice: ReceivedInvoice) {
    try {
      const file = await api<{ accessKey: string; xml: string }>(`/fiscal-registry/invoices/${invoice.id}/xml`);
      const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([file.xml], { type: 'application/xml' })); link.download = `${file.accessKey}.xml`; link.click(); URL.revokeObjectURL(link.href);
    } catch (e) { fail(e, 'Esta nota não possui XML armazenado'); }
  }

  return <AppShell title={tab === 'entry' ? 'Entrada de NF-e' : 'Notas recebidas'}>
    <PageHeader title={tab === 'entry' ? 'Entrada de NF-e' : 'Notas recebidas'} subtitle="Registre as NF-e de fornecedores a partir do XML ou manualmente. O sistema lê os dados do XML, mas não valida a assinatura nem consulta a SEFAZ; estoque e contas a pagar continuam em Compras e Financeiro." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <Tabs tabs={tabs} value={tab} onChange={next => { setTab(next); setNotice(null); }} label="Notas de entrada" />
    {tab === 'entry' && <form onSubmit={save} className={`${panelClass} mb-6 grid gap-4`}>
      <label className="block text-sm font-medium text-slate-700">Arquivo XML da NF-e (opcional)
        <input type="file" accept=".xml,text/xml,application/xml" className="mt-1 block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border file:border-slate-300 file:bg-white file:px-3 file:py-2 file:text-sm file:font-medium" onChange={e => void readXml(e.target.files?.[0])} />
      </label>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="md:col-span-2"><Field label="Chave de acesso (44 dígitos)" required inputMode="numeric" maxLength={44} pattern="\d{44}" value={form.accessKey} onChange={e => setForm({ ...form, accessKey: e.target.value.replace(/\D/g, '') })} /></div>
        <Field label="Número" required maxLength={20} value={form.number} onChange={e => setForm({ ...form, number: e.target.value })} />
        <Field label="Série" required maxLength={5} value={form.series} onChange={e => setForm({ ...form, series: e.target.value })} />
        <div className="md:col-span-2"><Field label="Fornecedor (emitente)" required minLength={2} maxLength={160} value={form.supplierName} onChange={e => setForm({ ...form, supplierName: e.target.value })} /></div>
        <Field label="CNPJ/CPF do emitente" maxLength={18} value={form.supplierDocument} onChange={e => setForm({ ...form, supplierDocument: e.target.value })} />
        <Field label="Data de emissão" type="date" required value={form.issuedAt} onChange={e => setForm({ ...form, issuedAt: e.target.value })} />
        <Field label="Valor total (R$)" type="number" min={0} step="0.01" required value={form.totalAmount} onChange={e => setForm({ ...form, totalAmount: e.target.value })} />
        <div className="md:col-span-2"><Select label="Natureza de operação (entrada)" value={form.natureId} onChange={e => setForm({ ...form, natureId: e.target.value })}><option value="">Não informada</option>{natures.map(nature => <option key={nature.id} value={nature.id}>{nature.name} — CFOP {nature.cfop}</option>)}</Select></div>
      </div>
      <label className="block text-sm font-medium text-slate-700">Observações<textarea className={textareaClass} rows={2} maxLength={500} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
      {xmlItems.length > 0 && <DataTable columns={[{ label: 'Item do XML' }, { label: 'NCM' }, { label: 'CFOP' }, { label: 'Qtd.' }, { label: 'Unitário' }, { label: 'Total' }]} footer={`${xmlItems.length} item(ns)`}>
        {xmlItems.map((item, index) => <tr key={index}><td>{item.description}</td><td>{item.ncm || '—'}</td><td>{item.cfop || '—'}</td><td>{item.quantity}</td><td>{formatMoney(item.unitValue)}</td><td>{formatMoney(item.totalValue)}</td></tr>)}
      </DataTable>}
      <div className="flex gap-3"><button className={buttonClass} disabled={busy}>{busy ? 'Registrando...' : 'Registrar nota'}</button><button type="button" className={secondaryButtonClass} onClick={reset}>Limpar</button></div>
    </form>}
    {tab === 'received' && <>
      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void load(); }}>
        <div className="min-w-64 flex-1"><Field label="Buscar" placeholder="Fornecedor, número ou chave" value={q} onChange={e => setQ(e.target.value)} /></div>
        <div className="w-48"><Select label="Situação" value={status} onChange={e => { setStatus(e.target.value); void load({ status: e.target.value }); }}><option value="">Todas</option>{Object.entries(invoiceStatusLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></div>
        <button className={buttonClass}>Buscar</button>
      </form>
      {loaded && items.length === 0 ? <EmptyState icon="📥" title="Nenhuma nota recebida" hint="Use a aba Entrada de NF-e para registrar a primeira nota." action={<button className={buttonClass} onClick={() => setTab('entry')}>Registrar nota</button>} /> :
        <DataTable columns={[{ label: 'Nota' }, { label: 'Fornecedor' }, { label: 'Emissão' }, { label: 'Natureza' }, { label: 'Total' }, { label: 'Situação' }, { label: 'Ações', className: 'text-right' }]} footer={`${items.length} nota(s)`}>
          {items.map(invoice => <tr key={invoice.id}>
            <td className="font-medium text-slate-900">{invoice.number}/{invoice.series}<span className="block max-w-48 truncate text-xs font-normal text-slate-500" title={invoice.accessKey}>{invoice.accessKey}</span></td>
            <td>{invoice.supplierName}{invoice.supplierDocument && <span className="block text-xs text-slate-500">{formatDocument(invoice.supplierDocument)}</span>}</td>
            <td>{formatDateTime(invoice.issuedAt).slice(0, 10)}</td><td>{invoice.nature?.name ?? '—'}</td><td>{formatMoney(invoice.totalAmount)}</td>
            <td><Badge tone={statusTone[invoice.status]}>{invoiceStatusLabel[invoice.status]}</Badge></td>
            <td><div className="flex flex-wrap justify-end gap-2">
              {invoice.items.length > 0 && <button className={secondaryButtonClass} onClick={() => setExpanded(expanded === invoice.id ? null : invoice.id)}>{expanded === invoice.id ? 'Ocultar itens' : 'Itens'}</button>}
              <button className={secondaryButtonClass} onClick={() => void download(invoice)}>XML</button>
              {invoice.status === 'RECEIVED' && <><button className={buttonClass} onClick={() => void act(invoice, 'enter')}>Lançar entrada</button><button className={secondaryButtonClass} onClick={() => void act(invoice, 'cancel')}>Cancelar</button></>}
            </div>
            {expanded === invoice.id && <ul className="mt-2 text-left text-xs text-slate-600">{invoice.items.map((item, index) => <li key={index}>{item.quantity} × {item.description} — {formatMoney(item.totalValue)}</li>)}</ul>}</td>
          </tr>)}
        </DataTable>}
    </>}
  </AppShell>;
}

export default function ReceivedInvoicesPage() {
  return <Suspense fallback={null}><InvoicesContent /></Suspense>;
}
