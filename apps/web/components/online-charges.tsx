'use client';

import { useRef, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney, ListResponse, PaymentCharge } from '../lib/api';
import { useAutoLoad } from '../lib/use-auto-load';
import { buttonClass, Notice, panelClass, secondaryButtonClass, Select } from './app-shell';

const methods = [{ value: 'PIX', label: 'PIX' }, { value: 'CREDIT_CARD', label: 'Cartão de crédito' }, { value: 'DEBIT_CARD', label: 'Cartão de débito' }];
const statusLabel: Record<string, string> = { PENDING: 'Aguardando pagamento', PAID: 'Paga', FAILED: 'Falhou', EXPIRED: 'Cancelada/expirada', REFUNDED: 'Estornada' };

// Remount with `key={orderId}` to reload for another order.
export function OnlineCharges({ orderId, onPaid }: { orderId: string; onPaid?: () => void | Promise<void> }) {
  const [providers, setProviders] = useState<string[] | null>(null); const [provider, setProvider] = useState(''); const [method, setMethod] = useState('PIX');
  const [charges, setCharges] = useState<PaymentCharge[]>([]); const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null); const [busy, setBusy] = useState(false); const previous = useRef<PaymentCharge[]>([]);

  async function loadProviders() {
    try { const data = await api<{ items: string[] }>('/payments/providers'); setProviders(data.items); setProvider(current => current || data.items[0] || ''); } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao carregar provedores de pagamento'), kind: 'error' }); }
  }
  async function loadCharges() {
    if (!orderId) return;
    try {
      const data = await api<ListResponse<PaymentCharge>>(`/payments/charges?orderId=${orderId}`);
      const paidNow = data.items.some(item => item.status === 'PAID' && previous.current.find(old => old.id === item.id)?.status === 'PENDING');
      previous.current = data.items; setCharges(data.items);
      if (paidNow) await onPaid?.();
    } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao carregar cobranças'), kind: 'error' }); }
  }
  useAutoLoad(loadProviders);
  useAutoLoad(loadCharges, 10000);

  async function create() {
    setBusy(true); setNotice(null);
    try { await api('/payments/charges', { method: 'POST', body: JSON.stringify({ orderId, provider, method }) }); setNotice({ text: 'Cobrança gerada para o saldo restante do pedido.', kind: 'success' }); await loadCharges(); } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao gerar cobrança'), kind: 'error' }); } finally { setBusy(false); }
  }
  async function cancel(charge: PaymentCharge) {
    if (!window.confirm('Cancelar esta cobrança pendente?')) return;
    try { await api(`/payments/charges/${charge.id}/cancel`, { method: 'POST' }); setNotice({ text: 'Cobrança cancelada.', kind: 'success' }); await loadCharges(); } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao cancelar cobrança'), kind: 'error' }); }
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice({ text: 'Código copiado.', kind: 'success' }); } catch { setNotice({ text: 'Não foi possível copiar; selecione o código manualmente.', kind: 'error' }); }
  }

  return <section className={`${panelClass} xl:col-span-2`}>
    <h2 className="mb-4 text-lg font-semibold">Cobrança online do pedido selecionado</h2>
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {!orderId ? <p className="text-sm text-slate-400">Selecione um pedido em “Receber pagamento”.</p>
      : providers && providers.length === 0 ? <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">Nenhum provedor de pagamento configurado. Configure um provedor no servidor para gerar cobranças online; os pagamentos manuais continuam disponíveis.</p>
      : <div className="flex flex-wrap items-end gap-3"><Select label="Provedor" value={provider} onChange={e => setProvider(e.target.value)}>{(providers ?? []).map(name => <option key={name} value={name}>{name}</option>)}</Select><Select label="Forma" value={method} onChange={e => setMethod(e.target.value)}>{methods.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</Select><button className={buttonClass} disabled={busy || !provider} onClick={() => void create()}>{busy ? 'Gerando...' : 'Gerar cobrança'}</button><button className={secondaryButtonClass} onClick={() => void loadCharges()}>Atualizar</button></div>}
    <div className="mt-4 grid gap-3">{charges.map(charge => <article key={charge.id} className="rounded-lg border border-slate-800 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-semibold">{formatMoney(charge.amount)} · {methods.find(item => item.value === charge.method)?.label ?? charge.method} <span className={`text-xs font-normal ${charge.status === 'PAID' ? 'text-emerald-300' : charge.status === 'PENDING' ? 'text-amber-300' : 'text-red-300'}`}>{statusLabel[charge.status] ?? charge.status}</span></h3><p className="mt-1 text-xs text-slate-400">{charge.provider} · criada em {formatDateTime(charge.createdAt)}{charge.paidAt ? ` · paga em ${formatDateTime(charge.paidAt)}` : ''}</p>{charge.error && <p className="mt-1 text-xs text-red-300">{charge.error === 'EXCEEDS_ORDER_BALANCE' ? 'Valor recebido excede o saldo do pedido: revisar.' : `Erro: ${charge.error}`}</p>}</div>{charge.status === 'PENDING' && <button className={secondaryButtonClass} onClick={() => void cancel(charge)}>Cancelar cobrança</button>}</div>
      {charge.qrPayload && charge.status === 'PENDING' && <div className="mt-3"><p className="mb-1 text-xs text-slate-400">Código PIX / pagamento (copia e cola)</p><textarea readOnly rows={3} className="w-full select-all rounded-lg border border-slate-700 bg-slate-950 p-2 text-xs text-white" value={charge.qrPayload} /><button className={`${secondaryButtonClass} mt-2`} onClick={() => void copy(charge.qrPayload ?? '')}>Copiar código</button></div>}</article>)}{providers && providers.length > 0 && charges.length === 0 && <p className="text-sm text-slate-400">Nenhuma cobrança online para este pedido.</p>}</div>
  </section>;
}
