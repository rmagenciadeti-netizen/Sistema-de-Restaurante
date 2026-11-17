'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../app-shell';
import { Badge, DataTable, EmptyState } from '../ui';
import { exportCsv, ReasonDialog, Section, statusLabels, statusTone } from './common';

type Invoice = { id: string; seq: number; reference: string; status: string; overdue: boolean; total: string | number; discount: string | number; dueDate: string; paidAt: string | null; paymentMethod: string | null; paymentReference: string | null; tenant: { id: string; name: string }; plan: { name: string } | null; coupon: { code: string } | null; campaign: { name: string } | null; items: { type: string; label: string; amount: number }[] };
type Quote = { quote: { lines: { type: string; label: string; amount: number }[]; subtotal: number; discount: number; total: number }; period: string; reference: string };
type Campaign = { id: string; name: string; phase: string };
const stateOf = (invoice: Invoice) => (invoice.overdue ? 'OVERDUE' : invoice.status);
const inTenDays = () => new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);

export function BillingManager({ initialTenantId }: { initialTenantId?: string }) {
  const [items, setItems] = useState<Invoice[]>([]);
  const [total, setTotal] = useState(0);
  const [tenants, setTenants] = useState<{ id: string; name: string }[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [filter, setFilter] = useState({ status: '', q: '' });
  const [form, setForm] = useState({ tenantId: initialTenantId ?? '', couponCode: '', campaignId: '', dueDate: inTenDays(), includeFees: '', notes: '' });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [payment, setPayment] = useState({ method: 'PIX', reference: '', extend: true });
  const [cancelling, setCancelling] = useState<Invoice | null>(null);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filter.status) params.set('status', filter.status);
    if (filter.q) params.set('q', filter.q);
    try {
      const [list, tenantList, campaignList] = await Promise.all([api<{ items: Invoice[]; total: number }>(`/commercial/invoices?${params}`), api<{ items: { id: string; name: string }[] }>('/tenants'), api<{ items: Campaign[] }>('/commercial/campaigns')]);
      setItems(list.items); setTotal(list.total); setTenants(tenantList.items); setCampaigns(campaignList.items.filter(item => item.phase === 'ACTIVE'));
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao carregar as cobranças')); }
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  const payload = () => ({ tenantId: form.tenantId, couponCode: form.couponCode || null, campaignId: form.campaignId || null, ...(form.includeFees ? { includeFees: form.includeFees === 'yes' } : {}) });
  async function preview() {
    setBusy(true); setMessage(''); setQuote(null);
    try { setQuote(await api<Quote>('/commercial/invoices/quote', { method: 'POST', body: JSON.stringify(payload()) })); } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Não foi possível calcular')); } finally { setBusy(false); }
  }
  async function issue() {
    setBusy(true); setMessage('');
    try {
      await api('/commercial/invoices', { method: 'POST', body: JSON.stringify({ ...payload(), dueDate: new Date(`${form.dueDate}T23:59:59`).toISOString(), notes: form.notes || null }) });
      setSuccess(true); setMessage('Cobrança emitida. A composição (plano, módulos, descontos e valor final) está no detalhe da cobrança.'); setQuote(null); await load();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao emitir a cobrança')); } finally { setBusy(false); }
  }
  async function pay(event: React.FormEvent) {
    event.preventDefault(); if (!paying) return;
    try {
      await api(`/commercial/invoices/${paying.id}/pay`, { method: 'POST', body: JSON.stringify({ method: payment.method, reference: payment.reference || undefined, extendLicense: payment.extend }) });
      setSuccess(true); setMessage(`Pagamento da cobrança #${paying.seq} registrado.`); setPaying(null); await load();
    } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao registrar o pagamento')); setPaying(null); }
  }
  async function cancel(reason: string) {
    if (!cancelling) return;
    try { await api(`/commercial/invoices/${cancelling.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }); setSuccess(true); setMessage('Cobrança cancelada.'); } catch (cause) { setSuccess(false); setMessage(errorMessage(cause, 'Falha ao cancelar')); }
    setCancelling(null); await load();
  }

  return <>
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    <section className={`${panelClass} mb-6 space-y-4`}>
      <h2 className="text-base font-bold">Nova cobrança</h2>
      <p className="text-xs text-slate-500">Calculada a partir da assinatura do cliente: plano + módulos avulsos − descontos. Cada competência só admite uma cobrança ativa, evitando duplicidades.</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Select label="Cliente" value={form.tenantId} onChange={event => { setForm({ ...form, tenantId: event.target.value }); setQuote(null); }}><option value="">Selecione</option>{tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}</option>)}</Select>
        <Field label="Cupom" value={form.couponCode} onChange={event => { setForm({ ...form, couponCode: event.target.value.toUpperCase() }); setQuote(null); }} />
        <Select label="Promoção ativa" value={form.campaignId} onChange={event => { setForm({ ...form, campaignId: event.target.value }); setQuote(null); }}><option value="">Nenhuma</option>{campaigns.map(campaign => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}</Select>
        <Field label="Vencimento" type="date" value={form.dueDate} onChange={event => setForm({ ...form, dueDate: event.target.value })} />
        <Select label="Taxas de ativação/implantação" value={form.includeFees} onChange={event => { setForm({ ...form, includeFees: event.target.value }); setQuote(null); }}><option value="">Automático (1ª cobrança)</option><option value="yes">Incluir</option><option value="no">Não incluir</option></Select>
        <Field label="Observações" value={form.notes} maxLength={500} onChange={event => setForm({ ...form, notes: event.target.value })} />
      </div>
      <div className="flex gap-2"><button type="button" className={secondaryButtonClass} disabled={!form.tenantId || busy} onClick={() => void preview()}>Calcular prévia</button><button type="button" className={buttonClass} disabled={!quote || busy} onClick={() => void issue()}>Emitir cobrança</button></div>
      {quote && <div className="rounded-xl border border-brand-300 bg-brand-50/40 p-4 text-sm">
        <p className="mb-2 font-semibold">Competência {quote.reference} · {quote.period}</p>
        {quote.quote.lines.map((line, index) => <div key={index} className="flex justify-between border-b border-slate-200 py-1"><span>{line.label}</span><span className={line.amount < 0 ? 'text-emerald-700' : ''}>{formatMoney(line.amount)}</span></div>)}
        <div className="mt-2 flex justify-between text-base font-bold"><span>Valor final</span><span>{formatMoney(quote.quote.total)}</span></div>
      </div>}
    </section>
    <Section title={`Cobranças (${total})`} actions={<button type="button" className={secondaryButtonClass} onClick={() => exportCsv('cobrancas.csv', ['Nº', 'Cliente', 'Competência', 'Situação', 'Total', 'Desconto', 'Vencimento', 'Pago em'], items.map(invoice => [invoice.seq, invoice.tenant.name, invoice.reference, statusLabels[stateOf(invoice)], Number(invoice.total), Number(invoice.discount), formatDateTime(invoice.dueDate), formatDateTime(invoice.paidAt)]))}>Exportar CSV</button>}>
      <div className="mb-3 grid gap-3 sm:grid-cols-3">
        <Select label="Situação" value={filter.status} onChange={event => setFilter({ ...filter, status: event.target.value })}><option value="">Todas</option><option value="OPEN">Em aberto</option><option value="OVERDUE">Vencidas</option><option value="PAID">Pagas</option><option value="CANCELLED">Canceladas</option></Select>
        <Field label="Buscar cliente" value={filter.q} onChange={event => setFilter({ ...filter, q: event.target.value })} />
      </div>
      {items.length === 0 ? <EmptyState icon="🧾" title="Nenhuma cobrança" hint="Emita a primeira cobrança de um cliente com assinatura." /> : <DataTable columns={[{ label: 'Nº' }, { label: 'Cliente / plano' }, { label: 'Composição' }, { label: 'Total' }, { label: 'Vencimento' }, { label: 'Situação' }, { label: 'Ações' }]}>
        {items.map(invoice => <tr key={invoice.id} className="align-top">
          <td>#{invoice.seq}<div className="text-xs text-slate-500">{invoice.reference}</div></td>
          <td><strong>{invoice.tenant.name}</strong><div className="text-xs text-slate-500">{invoice.plan?.name ?? 'Sem plano'}</div></td>
          <td className="text-xs">{invoice.items.map((line, index) => <div key={index}>{line.label}: {formatMoney(line.amount)}</div>)}</td>
          <td><strong>{formatMoney(invoice.total)}</strong>{Number(invoice.discount) > 0 && <div className="text-xs text-emerald-700">Desconto {formatMoney(invoice.discount)}</div>}</td>
          <td className="text-xs">{formatDateTime(invoice.dueDate)}{invoice.paidAt && <div>Pago em {formatDateTime(invoice.paidAt)} ({invoice.paymentMethod})</div>}</td>
          <td><Badge tone={statusTone(stateOf(invoice))}>{statusLabels[stateOf(invoice)]}</Badge></td>
          <td>{invoice.status === 'OPEN' && <div className="flex flex-wrap gap-1"><button type="button" className={secondaryButtonClass} onClick={() => { setPaying(invoice); setPayment({ method: 'PIX', reference: '', extend: true }); }}>Registrar pagamento</button><button type="button" className={secondaryButtonClass} onClick={() => setCancelling(invoice)}>Cancelar</button></div>}</td>
        </tr>)}
      </DataTable>}
    </Section>
    {paying && <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <form onSubmit={pay} className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="text-lg font-bold">Registrar pagamento #{paying.seq} — {formatMoney(paying.total)}</h3>
        <p className="text-xs text-slate-500">Conciliação manual: o pagamento só é marcado após a confirmação real recebida pelo banco ou provedor.</p>
        <Select label="Forma de pagamento" value={payment.method} onChange={event => setPayment({ ...payment, method: event.target.value })}>{['PIX', 'Boleto', 'Cartão', 'Transferência', 'Dinheiro'].map(method => <option key={method}>{method}</option>)}</Select>
        <Field label="Comprovante / referência" value={payment.reference} maxLength={120} onChange={event => setPayment({ ...payment, reference: event.target.value })} />
        <Check label="Renovar a validade da licença pelo período pago" checked={payment.extend} onChange={event => setPayment({ ...payment, extend: event.target.checked })} />
        <div className="flex justify-end gap-2"><button type="button" className={secondaryButtonClass} onClick={() => setPaying(null)}>Voltar</button><button className={buttonClass}>Confirmar pagamento</button></div>
      </form>
    </div>}
    {cancelling && <ReasonDialog title={`Cancelar cobrança #${cancelling.seq}`} danger confirmLabel="Cancelar cobrança" onCancel={() => setCancelling(null)} onConfirm={cancel} />}
  </>;
}

type Entry = { id: string; action: string; entityType: string; metadata: unknown; createdAt: string; tenant: { name: string } | null; actor: { name: string } | null };
const summary = (metadata: unknown) => { const text = JSON.stringify(metadata ?? {}); return text.length > 220 ? `${text.slice(0, 220)}…` : text; };

export function CommercialHistory() {
  const [items, setItems] = useState<Entry[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [prefix, setPrefix] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: '30' });
    if (prefix) params.set('prefix', prefix);
    api<{ items: Entry[]; total: number }>(`/commercial/history?${params}`).then(result => { setItems(result.items); setTotal(result.total); }).catch(cause => setError(errorMessage(cause, 'Falha ao carregar o histórico')));
  }, [page, prefix]);
  return <>
    {error && <Notice message={error} />}
    <Section title={`Auditoria comercial (${total})`}>
      <div className="mb-3 max-w-xs"><Select label="Área" value={prefix} onChange={event => { setPrefix(event.target.value); setPage(1); }}><option value="">Todas</option><option value="SAAS_PLAN">Planos</option><option value="SAAS_MODULE">Módulos</option><option value="SAAS_CAMPAIGN">Promoções</option><option value="SAAS_COUPON">Cupons</option><option value="SAAS_INVOICE">Cobranças</option><option value="ADDON_">Módulos avulsos</option><option value="SUBSCRIPTION_">Assinaturas</option><option value="LICENSE_">Licenças</option></Select></div>
      {items.length === 0 ? <EmptyState title="Nenhum registro" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Ação' }, { label: 'Cliente' }, { label: 'Responsável' }, { label: 'Detalhes' }]}>
        {items.map(entry => <tr key={entry.id} className="align-top"><td className="whitespace-nowrap text-xs">{formatDateTime(entry.createdAt)}</td><td className="text-xs font-semibold">{entry.action}</td><td>{entry.tenant?.name ?? '—'}</td><td>{entry.actor?.name ?? '—'}</td><td className="max-w-md break-words text-xs text-slate-500">{summary(entry.metadata)}</td></tr>)}
      </DataTable>}
      <div className="mt-3 flex justify-end gap-2"><button type="button" className={secondaryButtonClass} disabled={page <= 1} onClick={() => setPage(page - 1)}>Anterior</button><button type="button" className={secondaryButtonClass} disabled={page * 30 >= total} onClick={() => setPage(page + 1)}>Próxima</button></div>
    </Section>
  </>;
}
