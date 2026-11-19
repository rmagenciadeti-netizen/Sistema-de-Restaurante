'use client';

import { Fragment, useState } from 'react';
import Link from '../../components/nav-link';
import { ApiError, api, errorMessage, FiscalDocument, formatDateTime, formatMoney, ListResponse, Order, saveText, storedUser } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs, dangerButtonClass, textareaClass } from '../../components/ui';
import { BatchResponse, EnvironmentBanner, FiscalStatusBadges, makePeriod, Modal, modelLabel, Period, PeriodFilter, setPeriodParams, useFiscalSettings, XmlFile, XmlModal } from '../../components/fiscal-common';
import { environmentLabel, eventTypeLabel, fiscalStatusLabel, fiscalStatusTone, kindLabel, type FiscalEnvironment, type FiscalEvent } from '../../lib/types-fiscal';

type Kind = 'NFCE' | 'NFE';
type TabKey = 'emit' | 'documents' | 'numbering';
type NoticeState = { text: string; kind: 'error' | 'success' | 'info' } | null;
type Address = { street: string; number: string; complement?: string; district: string; city: string; cityIbge: string; uf: string; cep: string };
type Recipient = { name: string | null; document: string | null; email?: string | null; stateRegistration?: string | null; contributorIndicator?: '1' | '2' | '9'; address?: Address | null };
type TaxView = Partial<Record<'ncm' | 'cfop' | 'icmsCst' | 'icmsRate' | 'pisCst' | 'cofinsCst' | 'ibsCbsCst' | 'cClassTrib' | 'cbsRate' | 'ibsUfRate' | 'ibsMunRate', string | null>>;
type PreviewItem = { name: string; quantity: number; unitPrice: string; total: string; code?: string; unit?: string; tax: TaxView };
type Preview = {
  environment: FiscalEnvironment; kind: Kind;
  issuer: { legalName: string; tradeName: string; cnpj: string; stateRegistration: string; street: string; number: string; district: string; city: string; uf: string; cep: string };
  document: { series: string; number: string; customer: Recipient | null; items: PreviewItem[]; nature?: string; finality?: string; freight?: string; otherExpenses?: string; discount?: string; additionalInfo?: string };
  subtotal: string | number; discount: string | number; total: string | number;
};
type CustomerHit = { id: string; name: string; phone: string; document?: string | null; email?: string | null; address?: string | null };
type Numbering = { items: { kind: Kind; series: string; nextNumber: number }[]; environment: FiscalEnvironment };
type DocumentDetail = FiscalDocument & { events: FiscalEvent[] };

const overrideFields = [['cfop', 'CFOP'], ['ncm', 'NCM'], ['icmsCst', 'CST/CSOSN ICMS'], ['pisCst', 'CST PIS'], ['cofinsCst', 'CST COFINS'], ['ibsCbsCst', 'CST IBS/CBS'], ['cClassTrib', 'cClassTrib']] as const;
type OverrideKey = typeof overrideFields[number][0];
type EmitBody = {
  kind: Kind; provider?: string; nature?: string; finality?: '1' | '2' | '3' | '4'; freight?: number; otherExpenses?: number; additionalInfo?: string;
  recipient?: Recipient; items?: ({ index: number } & Partial<Record<OverrideKey, string>>)[];
};

const tabs: { key: TabKey; label: string }[] = [{ key: 'emit', label: 'Emitir' }, { key: 'documents', label: 'Documentos' }, { key: 'numbering', label: 'Numeração' }];
const finalityLabel: Record<string, string> = { '1': 'Normal', '2': 'Complementar', '3': 'Ajuste', '4': 'Devolução' };
const indicatorLabel: Record<string, string> = { '1': 'Contribuinte do ICMS', '2': 'Contribuinte isento', '9': 'Não contribuinte' };
const statusFilters = [{ value: '', label: 'Todas' }, { value: 'PENDING,PROCESSING,CONTINGENCY,REJECTED', label: 'Pendentes de regularização' }, ...Object.entries(fiscalStatusLabel).map(([value, label]) => ({ value, label }))];
const consultable = ['PROCESSING', 'CONTINGENCY', 'PENDING', 'AUTHORIZED'];
const resendable = ['REJECTED', 'CONTINGENCY', 'PROCESSING'];
const smallButton = 'rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-brand-400 hover:text-brand-700 disabled:opacity-50';
const emptyRecipient = { name: '', document: '', email: '', stateRegistration: '', contributorIndicator: '9' as '1' | '2' | '9', street: '', number: '', complement: '', district: '', city: '', cityIbge: '', uf: '', cep: '' };
const emptyForm = { orderId: '', kind: 'NFCE' as Kind, provider: '', nature: '', finality: '1' as '1' | '2' | '3' | '4', freight: '', otherExpenses: '', additionalInfo: '' };
const digits = (value: string) => value.replace(/\D/g, '');
const docNumber = (doc: { kind: string; number?: string | null; series?: string | null }) => `${modelLabel[doc.kind] ?? doc.kind}${doc.number ? ` nº ${doc.number}` : ''}${doc.series ? ` · série ${doc.series}` : ''}`;

export default function FiscalPage() {
  const { settings, error: settingsError } = useFiscalSettings();
  const [tab, setTab] = useState<TabKey>('emit');
  const [notice, setNotice] = useState<NoticeState>(null);
  const fail = (e: unknown, fallback: string) => setNotice({ text: errorMessage(e, fallback), kind: 'error' });
  const [providers, setProviders] = useState<string[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [contingency, setContingency] = useState<{ startedAt: string; reason: string } | null>(null);

  // ---------- Emissão ----------
  const [form, setForm] = useState(emptyForm);
  const [recipient, setRecipient] = useState(emptyRecipient);
  const [items, setItems] = useState<PreviewItem[]>([]); const [itemsError, setItemsError] = useState('');
  const [overrides, setOverrides] = useState<Record<number, Partial<Record<OverrideKey, string>>>>({});
  const [search, setSearch] = useState(''); const [hits, setHits] = useState<CustomerHit[] | null>(null); const [savedAddress, setSavedAddress] = useState('');
  const [quick, setQuick] = useState<{ name: string; phone: string; document: string; email: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  // ---------- Documentos ----------
  const [documents, setDocuments] = useState<FiscalDocument[]>([]); const [loadedDocs, setLoadedDocs] = useState(false);
  const [filters, setFilters] = useState({ period: makePeriod('month') as Period, status: '', kind: '', environment: '', q: '' });
  const [action, setAction] = useState<{ id: string; type: 'cancel' | 'correction' } | null>(null); const [actionText, setActionText] = useState('');
  const [history, setHistory] = useState<Record<string, FiscalEvent[] | 'loading' | string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [xmlView, setXmlView] = useState<XmlFile | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  // ---------- Numeração ----------
  const [numbering, setNumbering] = useState<Record<Kind, { series: string; nextNumber: string }>>({ NFCE: { series: '1', nextNumber: '1' }, NFE: { series: '1', nextNumber: '1' } });
  const [numberingEnv, setNumberingEnv] = useState<FiscalEnvironment | null>(null); const [numberingBusy, setNumberingBusy] = useState<Kind | null>(null);
  const canEditNumbering = ['ADMIN', 'MANAGER'].includes(storedUser().role ?? '');

  async function loadDocuments(current = filters) {
    const params = setPeriodParams(new URLSearchParams({ take: '200' }), current.period);
    if (current.status) params.set('status', current.status);
    if (current.kind) params.set('kind', current.kind);
    if (current.environment) params.set('environment', current.environment);
    if (current.q.trim()) params.set('q', current.q.trim());
    try { setDocuments((await api<ListResponse<FiscalDocument>>(`/fiscal/documents?${params}`)).items); } catch (e) { fail(e, 'Erro ao carregar documentos fiscais'); } finally { setLoadedDocs(true); }
  }
  async function loadNumbering() {
    try {
      const data = await api<Numbering>('/fiscal/numbering');
      setNumberingEnv(data.environment);
      setNumbering(current => data.items.reduce((acc, item) => ({ ...acc, [item.kind]: { series: item.series, nextNumber: String(item.nextNumber) } }), current));
    } catch (e) { fail(e, 'Erro ao carregar a numeração'); }
  }
  async function load() {
    try {
      const [p, o, c] = await Promise.all([api<{ items: string[] }>('/fiscal/providers'), api<ListResponse<Order>>('/orders?pageSize=100'), api<{ active: { startedAt: string; reason: string } | null }>('/fiscal-registry/contingency').catch(() => ({ active: null }))]);
      setProviders(p.items); setOrders(o.items.filter(order => order.status !== 'CANCELLED')); setContingency(c.active);
      setForm(current => ({ ...current, provider: current.provider || p.items[0] || '' }));
    } catch (e) { fail(e, 'Erro ao carregar dados fiscais'); }
    await Promise.all([loadDocuments(), loadNumbering()]);
  }
  useAutoLoad(load);

  const showProvider = Boolean(settings && !settings.provider && providers.length > 0);
  const problems = settings?.readiness[form.kind] ?? [];

  function body(withOverrides = true): EmitBody {
    const result: EmitBody = { kind: form.kind };
    if (showProvider && form.provider) result.provider = form.provider;
    if (form.kind !== 'NFE') return result;
    if (form.nature.trim()) result.nature = form.nature.trim();
    result.finality = form.finality;
    if (form.freight !== '') result.freight = Number(form.freight);
    if (form.otherExpenses !== '') result.otherExpenses = Number(form.otherExpenses);
    if (form.additionalInfo.trim()) result.additionalInfo = form.additionalInfo.trim();
    const r = recipient;
    if (r.name.trim() || r.document.trim()) {
      result.recipient = { name: r.name.trim() || null, document: digits(r.document) || null, email: r.email.trim() || null, stateRegistration: r.stateRegistration.trim() || null, contributorIndicator: r.contributorIndicator };
      if (r.street.trim()) result.recipient.address = { street: r.street.trim(), number: r.number.trim(), ...(r.complement.trim() ? { complement: r.complement.trim() } : {}), district: r.district.trim(), city: r.city.trim(), cityIbge: digits(r.cityIbge), uf: r.uf.trim().toUpperCase(), cep: digits(r.cep) };
    }
    if (withOverrides) {
      const list = Object.entries(overrides).map(([index, values]) => ({ index: Number(index), ...Object.fromEntries(Object.entries(values).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value!.trim()])) })).filter(item => Object.keys(item).length > 1);
      if (list.length) result.items = list;
    }
    return result;
  }

  async function loadItems(orderId: string, kind: Kind) {
    setItems([]); setOverrides({}); setItemsError('');
    if (!orderId || kind !== 'NFE') return;
    try { setItems((await api<Preview>(`/fiscal/orders/${orderId}/preview`, { method: 'POST', body: JSON.stringify({ kind }) })).document.items); } catch (e) { setItemsError(errorMessage(e, 'Não foi possível carregar os itens do pedido.')); }
  }
  function chooseOrder(orderId: string) {
    setForm(current => ({ ...current, orderId }));
    const order = orders.find(item => item.id === orderId);
    if (order?.customerName) setRecipient(current => (current.name ? current : { ...current, name: order.customerName ?? '' }));
    void loadItems(orderId, form.kind);
  }
  function chooseKind(kind: Kind) { setForm(current => ({ ...current, kind })); void loadItems(form.orderId, kind); }

  async function searchCustomers() {
    if (!search.trim()) return;
    try { setHits((await api<ListResponse<CustomerHit>>(`/customers?pageSize=6&search=${encodeURIComponent(search.trim())}`)).items); } catch (e) { fail(e, 'Erro ao buscar clientes'); }
  }
  function pickCustomer(customer: CustomerHit) {
    setRecipient(current => ({ ...current, name: customer.name, document: customer.document ?? '', email: customer.email ?? '' }));
    setSavedAddress(customer.address ?? ''); setHits(null); setSearch('');
  }
  async function createCustomer() {
    if (!quick) return;
    try {
      const created = await api<CustomerHit>('/customers', { method: 'POST', body: JSON.stringify({ name: quick.name.trim(), phone: quick.phone.trim(), ...(quick.document.trim() ? { document: digits(quick.document) } : {}), ...(quick.email.trim() ? { email: quick.email.trim() } : {}) }) });
      pickCustomer(created); setQuick(null); setNotice({ text: `Cliente ${created.name} cadastrado e selecionado como destinatário.`, kind: 'success' });
    } catch (e) { fail(e, 'Erro ao cadastrar cliente'); }
  }

  async function openPreview() {
    setNotice(null); setBusy(true);
    try { setPreview(await api<Preview>(`/fiscal/orders/${form.orderId}/preview`, { method: 'POST', body: JSON.stringify(body()) })); } catch (e) { fail(e, 'Erro ao gerar a pré-visualização'); } finally { setBusy(false); }
  }
  async function emit() {
    setNotice(null); setBusy(true); setPreview(null);
    const model = modelLabel[form.kind];
    try {
      const doc = await api<FiscalDocument>(`/fiscal/orders/${form.orderId}/emit`, { method: 'POST', body: JSON.stringify(body()) });
      if (doc.status === 'AUTHORIZED') setNotice({ text: `${model} nº ${doc.number ?? '—'} (série ${doc.series ?? '—'}) autorizada${doc.protocol ? ` — protocolo ${doc.protocol}` : ''}.`, kind: 'success' });
      else setNotice({ text: `${model} nº ${doc.number ?? '—'} transmitida sem protocolo (${fiscalStatusLabel[doc.status] ?? doc.status}). Ela será consultada na SEFAZ — nunca reemitida com outro número. Acompanhe na aba Documentos.`, kind: 'info' });
      setForm(current => ({ ...emptyForm, kind: current.kind, provider: current.provider })); setRecipient(emptyRecipient); setItems([]); setOverrides({}); setSavedAddress('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setNotice({ text: `Documento rejeitado: ${e.message}. Corrija e transmita novamente (o número é mantido).`, kind: 'error' });
      else if (e instanceof ApiError && e.status === 502) setNotice({ text: `${e.message} Use "Consultar SEFAZ" na aba Documentos.`, kind: 'info' });
      else if (e instanceof ApiError && e.status === 501) setNotice({ text: 'Nenhum provedor fiscal configurado: configure-o em Configurações › Fiscal.', kind: 'error' });
      else fail(e, 'Erro ao emitir documento fiscal');
    } finally { setBusy(false); await loadDocuments(); }
  }

  // ---------- Ações por documento ----------
  async function rowAction(id: string, run: () => Promise<string>) {
    setNotice(null); setRowBusy(id);
    try { setNotice({ text: await run(), kind: 'success' }); setAction(null); setActionText(''); } catch (e) { fail(e, 'Erro ao executar a ação'); } finally {
      setRowBusy(null); await loadDocuments();
      if (openHistory === id) await loadHistory(id);
    }
  }
  const consult = (doc: FiscalDocument) => rowAction(doc.id, async () => {
    const result = await api<FiscalDocument>(`/fiscal/documents/${doc.id}/consult`, { method: 'POST' });
    return `${docNumber(doc)}: ${fiscalStatusLabel[result.status] ?? result.status}${result.protocol ? ` — protocolo ${result.protocol}` : ''}.`;
  });
  const resend = (doc: FiscalDocument) => rowAction(doc.id, async () => {
    const result = (await api<BatchResponse>('/fiscal/documents/transmit', { method: 'POST', body: JSON.stringify({ ids: [doc.id] }) })).results[0];
    if (!result) return 'Documento não elegível para reenvio.';
    if (result.error) throw new Error(result.error);
    return `${docNumber(doc)}: ${fiscalStatusLabel[result.status ?? ''] ?? result.status}${result.message ? ` — ${result.message}` : ''}.`;
  });
  const cancel = (doc: FiscalDocument) => {
    if (!window.confirm(`Cancelar ${docNumber(doc)}? O cancelamento é registrado na SEFAZ e não pode ser desfeito.`)) return;
    void rowAction(doc.id, async () => { await api(`/fiscal/documents/${doc.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: actionText.trim() }) }); return `${docNumber(doc)} cancelada.`; });
  };
  const correct = (doc: FiscalDocument) => {
    if (!window.confirm('Registrar a Carta de Correção na SEFAZ? Ela substitui as correções anteriores deste documento.')) return;
    void rowAction(doc.id, async () => {
      const event = await api<{ sequence?: number; protocol?: string | null }>(`/fiscal/documents/${doc.id}/correction`, { method: 'POST', body: JSON.stringify({ text: actionText.trim() }) });
      return `Carta de correção nº ${event.sequence ?? '—'} registrada${event.protocol ? ` — protocolo ${event.protocol}` : ''}.`;
    });
  };
  async function xml(doc: FiscalDocument, mode: 'view' | 'save') {
    try { const file = await api<XmlFile>(`/fiscal/documents/${doc.id}/xml`); if (mode === 'save') saveText(file.xml, file.fileName); else setXmlView(file); } catch (e) { fail(e, 'Erro ao obter o XML'); }
  }
  async function eventXml(id: string) {
    try { const file = await api<XmlFile>(`/fiscal/events/${id}/xml`); saveText(file.xml, file.fileName); } catch (e) { fail(e, 'XML do evento indisponível'); }
  }
  async function loadHistory(id: string) {
    setHistory(current => ({ ...current, [id]: 'loading' }));
    try { const detail = await api<DocumentDetail>(`/fiscal/documents/${id}`); setHistory(current => ({ ...current, [id]: detail.events })); } catch (e) { setHistory(current => ({ ...current, [id]: errorMessage(e, 'Erro ao carregar o histórico') })); }
  }
  function toggleHistory(id: string) {
    if (openHistory === id) { setOpenHistory(null); return; }
    setOpenHistory(id); void loadHistory(id);
  }

  async function saveNumbering(kind: Kind) {
    setNotice(null); setNumberingBusy(kind);
    try { await api('/fiscal/numbering', { method: 'PUT', body: JSON.stringify({ kind, series: numbering[kind].series.trim(), nextNumber: Number(numbering[kind].nextNumber) }) }); setNotice({ text: `Numeração da ${modelLabel[kind]} salva.`, kind: 'success' }); } catch (e) { fail(e, 'Erro ao salvar a numeração'); } finally { setNumberingBusy(null); await loadNumbering(); }
  }

  const setR = (key: keyof typeof emptyRecipient) => (e: { target: { value: string } }) => setRecipient(current => ({ ...current, [key]: e.target.value }));
  const columns = ['Documento', 'Pedido / cliente', 'Valor', 'Ambiente', 'Situação', 'Protocolo', 'Última tentativa', 'Mensagem', 'Ações'].map(label => ({ label }));

  return <AppShell title="Documentos fiscais">
    <PageHeader title="Documentos fiscais" subtitle="Emita NFC-e e NF-e a partir dos pedidos, acompanhe autorizações e rejeições da SEFAZ, cancele e consulte o histórico. Emitente, certificado, CFOP, tributação e séries vêm de Configurações › Fiscais." actions={<><Link className={secondaryButtonClass} href="/settings?tab=fiscal">Configurações fiscais</Link><Link className={secondaryButtonClass} href="/contingency">Contingências</Link><Link className={secondaryButtonClass} href="/fiscal-xmls">XMLs</Link></>} />
    <EnvironmentBanner settings={settings} error={settingsError} />
    {notice && (notice.kind === 'info' ? <div role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{notice.text}</div> : <Notice message={notice.text} kind={notice.kind} />)}
    {contingency && <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Contingência fiscal em andamento desde {formatDateTime(contingency.startedAt)}: {contingency.reason}. Gerencie em <Link className="font-semibold underline" href="/contingency">Contingências</Link>.</p>}
    <Tabs tabs={tabs} value={tab} onChange={setTab} label="Seções fiscais" />

    {tab === 'emit' && <section className={panelClass}>
      <h2 className="mb-4 text-lg font-semibold text-slate-900">Emitir documento</h2>
      {problems.length > 0 && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><p className="font-semibold">A {modelLabel[form.kind]} ainda não está pronta para emissão:</p><ul className="ml-5 mt-1 list-disc">{problems.map(problem => <li key={problem}>{problem}</li>)}</ul><Link href="/settings?tab=fiscal" className="mt-2 inline-block font-semibold underline">Ajustar em Configurações › Fiscais</Link></div>}
      <form onSubmit={event => { event.preventDefault(); void emit(); }} className="grid gap-5">
        <div className="grid gap-4 md:grid-cols-4">
          <div className="md:col-span-2"><Select label="Pedido" required value={form.orderId} onChange={e => chooseOrder(e.target.value)}><option value="">Selecione</option>{orders.map(order => <option key={order.id} value={order.id}>{order.code} — {formatMoney(order.total)}{order.customerName ? ` — ${order.customerName}` : ''}</option>)}</Select></div>
          <Select label="Modelo" value={form.kind} onChange={e => chooseKind(e.target.value as Kind)}><option value="NFCE">{kindLabel.NFCE}</option><option value="NFE">{kindLabel.NFE}</option></Select>
          {showProvider && <Select label="Provedor" value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}>{providers.map(name => <option key={name} value={name}>{name}</option>)}</Select>}
          {orders.length === 0 && <p className="text-sm text-slate-500 md:col-span-4">Nenhum pedido disponível para emissão.</p>}
        </div>

        {form.kind === 'NFE' && <>
          <fieldset className="grid gap-4 rounded-xl border border-slate-200 p-4 md:grid-cols-4"><legend className="px-1 text-sm font-semibold text-slate-700">Operação</legend>
            <div className="md:col-span-2"><Field label="Natureza da operação" placeholder={settings?.nfe.nature || 'Venda de mercadoria'} maxLength={60} value={form.nature} onChange={e => setForm({ ...form, nature: e.target.value })} /></div>
            <Select label="Finalidade" value={form.finality} onChange={e => setForm({ ...form, finality: e.target.value as typeof form.finality })}>{Object.entries(finalityLabel).map(([value, label]) => <option key={value} value={value}>{value} — {label}</option>)}</Select>
            <div />
            <Field label="Frete (R$)" type="number" min="0" step="0.01" value={form.freight} onChange={e => setForm({ ...form, freight: e.target.value })} />
            <Field label="Outras despesas (R$)" type="number" min="0" step="0.01" value={form.otherExpenses} onChange={e => setForm({ ...form, otherExpenses: e.target.value })} />
            <label className="block text-sm font-medium text-slate-700 md:col-span-4">Informações complementares<textarea className={textareaClass} rows={2} maxLength={2000} value={form.additionalInfo} placeholder={settings?.nfe.additionalInfo || ''} onChange={e => setForm({ ...form, additionalInfo: e.target.value })} /></label>
          </fieldset>

          <fieldset className="grid gap-4 rounded-xl border border-slate-200 p-4 md:grid-cols-4"><legend className="px-1 text-sm font-semibold text-slate-700">Destinatário</legend>
            <div className="flex flex-wrap items-end gap-2 md:col-span-4">
              <div className="min-w-60 flex-1"><Field label="Buscar cliente cadastrado (nome ou documento)" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void searchCustomers(); } }} /></div>
              <button type="button" className={secondaryButtonClass} onClick={() => void searchCustomers()}>Buscar</button>
              <button type="button" className={secondaryButtonClass} onClick={() => setQuick(quick ? null : { name: recipient.name, phone: '', document: recipient.document, email: recipient.email })}>{quick ? 'Fechar cadastro' : '+ Novo cliente'}</button>
            </div>
            {hits && <div className="md:col-span-4">{hits.length === 0 ? <p className="text-sm text-slate-500">Nenhum cliente encontrado.</p> : <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">{hits.map(hit => <li key={hit.id}><button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50" onClick={() => pickCustomer(hit)}><span className="font-medium text-slate-900">{hit.name}</span> <span className="text-slate-500">{hit.document || 'sem documento'} · {hit.phone}</span></button></li>)}</ul>}</div>}
            {quick && <div className="grid gap-3 rounded-xl bg-slate-50 p-3 md:col-span-4 md:grid-cols-5">
              <Field label="Nome" value={quick.name} onChange={e => setQuick({ ...quick, name: e.target.value })} />
              <Field label="Telefone" value={quick.phone} onChange={e => setQuick({ ...quick, phone: e.target.value })} />
              <Field label="CPF/CNPJ" value={quick.document} onChange={e => setQuick({ ...quick, document: e.target.value })} />
              <Field label="E-mail" type="email" value={quick.email} onChange={e => setQuick({ ...quick, email: e.target.value })} />
              <div className="flex items-end"><button type="button" className={buttonClass} disabled={quick.name.trim().length < 2 || quick.phone.trim().length < 8} onClick={() => void createCustomer()}>Cadastrar e usar</button></div>
            </div>}
            <div className="md:col-span-2"><Field label="Nome / razão social" maxLength={120} value={recipient.name} onChange={setR('name')} /></div>
            <Field label="CPF/CNPJ" inputMode="numeric" value={recipient.document} onChange={setR('document')} />
            <Field label="Inscrição estadual" value={recipient.stateRegistration} onChange={setR('stateRegistration')} />
            <Select label="Indicador de IE" value={recipient.contributorIndicator} onChange={e => setRecipient({ ...recipient, contributorIndicator: e.target.value as '1' | '2' | '9' })}>{Object.entries(indicatorLabel).map(([value, label]) => <option key={value} value={value}>{value} — {label}</option>)}</Select>
            <div className="md:col-span-3"><Field label="E-mail" type="email" value={recipient.email} onChange={setR('email')} /></div>
            {savedAddress && <p className="text-xs text-slate-500 md:col-span-4">Endereço no cadastro do cliente: {savedAddress}</p>}
            <div className="md:col-span-2"><Field label="Logradouro" value={recipient.street} onChange={setR('street')} /></div>
            <Field label="Número" value={recipient.number} onChange={setR('number')} />
            <Field label="Complemento" value={recipient.complement} onChange={setR('complement')} />
            <Field label="Bairro" value={recipient.district} onChange={setR('district')} />
            <Field label="Município" value={recipient.city} onChange={setR('city')} />
            <Field label="Cód. IBGE (7 dígitos)" inputMode="numeric" maxLength={7} value={recipient.cityIbge} onChange={setR('cityIbge')} />
            <div className="grid grid-cols-2 gap-3"><Field label="UF" maxLength={2} value={recipient.uf} onChange={setR('uf')} /><Field label="CEP" inputMode="numeric" maxLength={9} value={recipient.cep} onChange={setR('cep')} /></div>
            <p className="text-xs text-slate-500 md:col-span-4">O endereço só é enviado quando o logradouro é preenchido; nesse caso informe todos os campos.</p>
          </fieldset>

          <fieldset className="rounded-xl border border-slate-200 p-4"><legend className="px-1 text-sm font-semibold text-slate-700">Itens e tributação</legend>
            <p className="mb-3 text-xs text-slate-500">Os campos vazios usam a regra tributária do produto (valor exibido em cinza). As alterações valem <strong>somente para este documento</strong> e não mudam o cadastro.</p>
            {!form.orderId ? <p className="text-sm text-slate-500">Selecione um pedido para carregar os itens.</p> : itemsError ? <p className="text-sm text-red-700">{itemsError}</p> : items.length === 0 ? <p className="text-sm text-slate-500">Carregando itens...</p> :
              <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-neutral-950 font-semibold uppercase tracking-wider text-brand-300"><tr><th className="px-2 py-2">Item</th><th className="px-2 py-2">Qtd</th><th className="px-2 py-2">Total</th>{overrideFields.map(([, label]) => <th key={label} className="px-2 py-2">{label}</th>)}</tr></thead>
                <tbody className="divide-y divide-slate-100">{items.map((item, index) => <tr key={index}><td className="px-2 py-1.5 font-medium text-slate-900">{item.name}</td><td className="px-2 py-1.5">{item.quantity}</td><td className="px-2 py-1.5">{formatMoney(item.total)}</td>
                  {overrideFields.map(([key, label]) => <td key={key} className="px-1 py-1"><input aria-label={`${label} — ${item.name}`} className="w-24 rounded-lg border border-slate-300 px-2 py-1 text-xs placeholder:text-slate-400 focus:border-brand-500 focus:outline-none" placeholder={item.tax[key] ?? '—'} value={overrides[index]?.[key] ?? ''} onChange={e => setOverrides(current => ({ ...current, [index]: { ...current[index], [key]: e.target.value } }))} /></td>)}</tr>)}</tbody></table></div>}
          </fieldset>
        </>}

        <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButtonClass} disabled={busy || !form.orderId} onClick={() => void openPreview()}>Pré-visualizar DANFE</button>
          <button className={buttonClass} disabled={busy || !form.orderId}>{busy ? 'Processando...' : 'Transmitir'}</button>
        </div>
      </form>
    </section>}

    {tab === 'documents' && <>
      <form className={`${panelClass} mb-4 grid gap-3`} onSubmit={event => { event.preventDefault(); void loadDocuments(); }}>
        <PeriodFilter value={filters.period} onChange={period => setFilters({ ...filters, period })} />
        <div className="grid gap-3 md:grid-cols-5">
          <Select label="Situação" value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}>{statusFilters.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select>
          <Select label="Modelo" value={filters.kind} onChange={e => setFilters({ ...filters, kind: e.target.value })}><option value="">Todos</option><option value="NFCE">NFC-e</option><option value="NFE">NF-e</option></Select>
          <Select label="Ambiente" value={filters.environment} onChange={e => setFilters({ ...filters, environment: e.target.value })}><option value="">Todos</option><option value="PRODUCTION">Produção</option><option value="HOMOLOGATION">Homologação</option></Select>
          <Field label="Busca" placeholder="Número, chave, pedido, cliente, CPF/CNPJ" value={filters.q} onChange={e => setFilters({ ...filters, q: e.target.value })} />
          <div className="flex items-end"><button className={buttonClass}>Filtrar</button></div>
        </div>
      </form>
      {loadedDocs && documents.length === 0 ? <EmptyState icon="🧾" title="Nenhum documento encontrado" hint="Ajuste o período ou os filtros." /> :
        <DataTable columns={columns} footer={`${documents.length} documento(s)`}>
          {documents.map(doc => <Fragment key={doc.id}>
            <tr className="align-top">
              <td className="font-medium text-slate-900">{docNumber(doc)}{doc.accessKey && <span className="block max-w-52 truncate font-mono text-[11px] font-normal text-slate-500" title={doc.accessKey}>{doc.accessKey}</span>}<span className="block text-xs font-normal text-slate-500">{formatDateTime(doc.createdAt)}</span></td>
              <td>{doc.order?.code ?? '—'}<span className="block text-xs text-slate-500">{doc.order?.customer?.name ?? doc.order?.customerName ?? 'Consumidor'}{doc.order?.customer?.document ? ` · ${doc.order.customer.document}` : ''}</span></td>
              <td className="whitespace-nowrap">{doc.order ? formatMoney(doc.order.total) : '—'}</td>
              <td><Badge tone={doc.environment === 'PRODUCTION' ? 'green' : 'amber'}>{environmentLabel[doc.environment]}</Badge></td>
              <td><FiscalStatusBadges status={doc.status} contingency={doc.contingency} /></td>
              <td className="font-mono text-xs">{doc.protocol ?? '—'}</td>
              <td className="text-xs">{formatDateTime(doc.lastAttemptAt)}{doc.attempts > 0 && <span className="block text-slate-500">{doc.attempts} tentativa(s)</span>}</td>
              <td className="max-w-56 text-xs text-slate-600">{doc.error ?? '—'}</td>
              <td><div className="flex min-w-48 flex-wrap gap-1">
                {consultable.includes(doc.status) && <button type="button" className={smallButton} disabled={rowBusy === doc.id} onClick={() => void consult(doc)}>Consultar SEFAZ</button>}
                {resendable.includes(doc.status) && <button type="button" className={smallButton} disabled={rowBusy === doc.id} onClick={() => void resend(doc)}>Reenviar</button>}
                {doc.status === 'AUTHORIZED' && <button type="button" className={smallButton} onClick={() => { setAction(action?.id === doc.id && action.type === 'cancel' ? null : { id: doc.id, type: 'cancel' }); setActionText(''); }}>Cancelar</button>}
                {doc.status === 'AUTHORIZED' && doc.kind === 'NFE' && <button type="button" className={smallButton} onClick={() => { setAction(action?.id === doc.id && action.type === 'correction' ? null : { id: doc.id, type: 'correction' }); setActionText(''); }}>Carta de correção</button>}
                {doc.hasXml && <><button type="button" className={smallButton} onClick={() => void xml(doc, 'view')}>Ver XML</button><button type="button" className={smallButton} onClick={() => void xml(doc, 'save')}>Baixar XML</button></>}
                {doc.documentUrl && <a className={smallButton} href={doc.documentUrl} target="_blank" rel="noopener noreferrer">DANFE</a>}
                <button type="button" className={smallButton} aria-expanded={openHistory === doc.id} onClick={() => toggleHistory(doc.id)}>Histórico</button>
              </div></td>
            </tr>
            {action?.id === doc.id && <tr><td colSpan={columns.length} className="bg-slate-50">
              <div className="flex flex-wrap items-end gap-3">
                <label className="block min-w-72 flex-1 text-sm font-medium text-slate-700">{action.type === 'cancel' ? `Motivo do cancelamento (${actionText.trim().length}/15–255)` : `Texto da correção (${actionText.trim().length}/15–1000)`}
                  <textarea className={textareaClass} rows={2} maxLength={action.type === 'cancel' ? 255 : 1000} value={actionText} onChange={e => setActionText(e.target.value)} /></label>
                {action.type === 'cancel'
                  ? <button type="button" className={dangerButtonClass} disabled={rowBusy === doc.id || actionText.trim().length < 15} onClick={() => cancel(doc)}>Confirmar cancelamento</button>
                  : <button type="button" className={buttonClass} disabled={rowBusy === doc.id || actionText.trim().length < 15} onClick={() => correct(doc)}>Registrar correção</button>}
              </div>
              {action.type === 'correction' && <p className="mt-2 text-xs text-slate-500">A CC-e não pode corrigir valores, impostos, dados cadastrais que mudem o destinatário nem a data de emissão.</p>}
            </td></tr>}
            {openHistory === doc.id && <tr><td colSpan={columns.length} className="bg-slate-50">
              <HistoryList state={history[doc.id]} onXml={id => void eventXml(id)} />
            </td></tr>}
          </Fragment>)}
        </DataTable>}
    </>}

    {tab === 'numbering' && <section className={panelClass}>
      <h2 className="mb-1 text-lg font-semibold text-slate-900">Numeração {numberingEnv && <Badge tone={numberingEnv === 'PRODUCTION' ? 'green' : 'amber'}>{environmentLabel[numberingEnv]}</Badge>}</h2>
      <p className="mb-4 text-sm text-slate-500">Cada documento emitido (inclusive pelo PDV e pelo quadro de pedidos) recebe o próximo número da série, em sequência. A numeração é separada por modelo e por ambiente; o número só pode avançar.</p>
      <div className="grid gap-4 lg:grid-cols-2">{(['NFCE', 'NFE'] as Kind[]).map(kind => <form key={kind} className="grid gap-3 rounded-xl border border-slate-200 p-4 sm:grid-cols-3" onSubmit={event => { event.preventDefault(); void saveNumbering(kind); }}>
        <h3 className="font-semibold text-slate-900 sm:col-span-3">{kindLabel[kind]}</h3>
        <Field label="Série" required inputMode="numeric" pattern="\d{1,3}" maxLength={3} disabled={!canEditNumbering} value={numbering[kind].series} onChange={e => setNumbering({ ...numbering, [kind]: { ...numbering[kind], series: e.target.value } })} />
        <Field label="Próximo número" required type="number" min="1" step="1" disabled={!canEditNumbering} value={numbering[kind].nextNumber} onChange={e => setNumbering({ ...numbering, [kind]: { ...numbering[kind], nextNumber: e.target.value } })} />
        {canEditNumbering && <div className="flex items-end"><button className={buttonClass} disabled={numberingBusy === kind}>{numberingBusy === kind ? 'Salvando...' : 'Salvar'}</button></div>}
      </form>)}</div>
      {!canEditNumbering && <p className="mt-3 text-sm text-slate-500">Somente administradores e gerentes alteram a numeração.</p>}
    </section>}

    {preview && <DanfePreview preview={preview} onClose={() => setPreview(null)} onTransmit={() => void emit()} busy={busy} />}
    {xmlView && <XmlModal file={xmlView} onClose={() => setXmlView(null)} />}
  </AppShell>;
}

function HistoryList({ state, onXml }: { state: FiscalEvent[] | 'loading' | string | undefined; onXml: (id: string) => void }) {
  if (state === undefined || state === 'loading') return <p className="text-sm text-slate-500">Carregando histórico...</p>;
  if (typeof state === 'string') return <p className="text-sm text-red-700">{state}</p>;
  if (state.length === 0) return <p className="text-sm text-slate-500">Nenhum evento registrado.</p>;
  return <ol className="relative ml-2 border-l border-slate-300">{state.map(event => <li key={event.id} className="mb-3 ml-4">
    <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border border-white bg-brand-500" />
    <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold text-slate-900">{eventTypeLabel[event.type] ?? event.type}{event.sequence ? ` nº ${event.sequence}` : ''}</span>
      <Badge tone={fiscalStatusTone[event.status] ?? (event.status === 'REGISTERED' ? 'green' : event.status === 'REJECTED' ? 'red' : 'neutral')}>{fiscalStatusLabel[event.status] ?? (event.status === 'REGISTERED' ? 'Registrado' : event.status)}</Badge>
      <span className="text-xs text-slate-500">{formatDateTime(event.createdAt)}</span>
      {event.protocol && <span className="font-mono text-xs text-slate-600">Protocolo {event.protocol}</span>}
      <button type="button" className={smallButton} onClick={() => onXml(event.id)}>XML do evento</button></div>
    {event.message && <p className="text-xs text-slate-600">{event.message}</p>}
  </li>)}</ol>;
}

const printCss = '@media print { body * { visibility: hidden !important; } [role="dialog"] { position: static !important; overflow: visible !important; background: none !important; padding: 0 !important; } #danfe-print, #danfe-print * { visibility: visible !important; } #danfe-print { position: absolute; left: 0; top: 0; width: 100%; margin: 0; box-shadow: none; } }';
const money = (value?: string | number | null) => formatMoney(value ?? 0);

function DanfePreview({ preview, onClose, onTransmit, busy }: { preview: Preview; onClose: () => void; onTransmit: () => void; busy: boolean }) {
  const { issuer, document: doc } = preview;
  const customer = doc.customer;
  const address = customer?.address;
  const grandTotal = Number(preview.total) + Number(doc.freight ?? 0) + Number(doc.otherExpenses ?? 0);
  const cell = 'border border-slate-400 px-2 py-1';
  return <Modal title="Pré-visualização do DANFE" onClose={onClose} wide id="danfe-print">
    <style>{printCss}</style>
    <div className="relative overflow-hidden text-xs text-slate-900">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center"><span className="-rotate-[30deg] select-none whitespace-nowrap text-4xl font-black uppercase tracking-widest text-red-500/20 sm:text-6xl">Sem valor fiscal — pré-visualização</span></div>
      <div className="grid grid-cols-3 border border-slate-400">
        <div className="col-span-2 p-2"><p className="text-sm font-bold">{issuer.legalName || '—'}</p>{issuer.tradeName && <p>{issuer.tradeName}</p>}<p>{[issuer.street, issuer.number, issuer.district].filter(Boolean).join(', ')} — {issuer.city}/{issuer.uf} · CEP {issuer.cep}</p><p>CNPJ {issuer.cnpj || '—'} · IE {issuer.stateRegistration || '—'}</p></div>
        <div className="border-l border-slate-400 p-2 text-center"><p className="text-sm font-bold">DANFE{preview.kind === 'NFCE' ? ' NFC-e' : ''}</p><p>{kindLabel[preview.kind]}</p><p className="mt-1 font-semibold">Nº {doc.number} · Série {doc.series}</p><p>{environmentLabel[preview.environment]}</p></div>
      </div>
      <div className="grid grid-cols-2 border-x border-b border-slate-400"><p className="p-2"><span className="font-semibold">Natureza da operação:</span> {doc.nature || '—'}</p><p className="border-l border-slate-400 p-2"><span className="font-semibold">Finalidade:</span> {finalityLabel[doc.finality ?? '1'] ?? doc.finality}</p></div>
      <p className="mt-2 font-bold uppercase">Destinatário</p>
      <div className="border border-slate-400 p-2">{customer?.name || customer?.document ? <><p className="font-semibold">{customer.name || '—'}</p><p>CPF/CNPJ {customer.document || '—'}{customer.stateRegistration ? ` · IE ${customer.stateRegistration}` : ''}{customer.contributorIndicator ? ` · ${indicatorLabel[customer.contributorIndicator]}` : ''}</p>{address && <p>{address.street}, {address.number}{address.complement ? ` ${address.complement}` : ''} — {address.district} — {address.city}/{address.uf} · CEP {address.cep}</p>}</> : <p>Consumidor não identificado</p>}</div>
      <p className="mt-2 font-bold uppercase">Itens</p>
      <div className="overflow-x-auto"><table className="w-full border-collapse"><thead className="bg-slate-100"><tr>{['Código', 'Descrição', 'NCM', 'CFOP', 'CST/CSOSN', 'Alíq. ICMS', 'PIS/COFINS', 'IBS/CBS', 'Un', 'Qtd', 'Vl. unit.', 'Total'].map(label => <th key={label} className={cell}>{label}</th>)}</tr></thead>
        <tbody>{doc.items.map((item, index) => <tr key={index}><td className={cell}>{item.code ?? index + 1}</td><td className={cell}>{item.name}</td><td className={cell}>{item.tax.ncm ?? '—'}</td><td className={cell}>{item.tax.cfop ?? '—'}</td><td className={cell}>{item.tax.icmsCst ?? '—'}</td><td className={cell}>{item.tax.icmsRate ? `${item.tax.icmsRate}%` : '—'}</td><td className={cell}>{item.tax.pisCst ?? '—'}/{item.tax.cofinsCst ?? '—'}</td><td className={cell}>{item.tax.ibsCbsCst ? `${item.tax.ibsCbsCst}${item.tax.cClassTrib ? ` · ${item.tax.cClassTrib}` : ''}${item.tax.cbsRate ? ` · CBS ${item.tax.cbsRate}%` : ''}` : '—'}</td><td className={cell}>{item.unit ?? 'UN'}</td><td className={`${cell} text-right`}>{item.quantity}</td><td className={`${cell} text-right`}>{money(item.unitPrice)}</td><td className={`${cell} text-right`}>{money(item.total)}</td></tr>)}</tbody></table></div>
      <div className="mt-2 grid grid-cols-2 border border-slate-400 sm:grid-cols-5">{[['Produtos', preview.subtotal], ['Desconto', doc.discount ?? preview.discount], ['Frete', doc.freight], ['Outras despesas', doc.otherExpenses], ['Total da nota', grandTotal]].map(([label, value]) => <div key={String(label)} className="border-r border-slate-400 p-2 last:border-r-0"><p className="text-[10px] uppercase text-slate-500">{label}</p><p className="font-semibold">{money(value)}</p></div>)}</div>
      <p className="mt-2 font-bold uppercase">Informações complementares</p>
      <p className="min-h-10 whitespace-pre-wrap border border-slate-400 p-2">{doc.additionalInfo || '—'}</p>
      <p className="mt-2 text-center font-semibold text-red-700">Documento sem valor fiscal — pré-visualização gerada antes da transmissão.</p>
    </div>
    <div className="mt-4 flex flex-wrap justify-end gap-2 print:hidden">
      <button type="button" className={secondaryButtonClass} onClick={onClose}>Voltar à edição</button>
      <button type="button" className={secondaryButtonClass} onClick={() => window.print()}>Imprimir / salvar PDF</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={onTransmit}>Transmitir</button>
    </div>
  </Modal>;
}
