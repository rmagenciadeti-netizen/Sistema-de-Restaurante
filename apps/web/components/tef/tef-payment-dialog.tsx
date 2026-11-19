'use client';

import { useState } from 'react';
import { api, errorMessage, formatMoney } from '../../lib/api';
import { secondaryButtonClass } from '../app-shell';
import { Badge } from '../ui';
import { TEF_STATUS, type TefTransaction } from '../../lib/types-tef';

// Shown whenever a TEF payment did not end approved. Only an approved transaction counts as paid; everything else is explained and can be consulted, never silently retried.
export function TefPaymentDialog({ transaction, orderLabel, onClose, onApproved }: { transaction: TefTransaction; orderLabel: string; onClose: () => void; onApproved: () => void }) {
  const [current, setCurrent] = useState(transaction); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [fiscalNote, setFiscalNote] = useState('');
  const state = TEF_STATUS[current.status];
  async function consult() {
    setBusy(true); setError('');
    try { const result = await api<{ transaction: TefTransaction; paid: boolean; fiscal?: { action: string; message?: string } | null }>(`/tef/transactions/${current.id}/sync`, { method: 'POST' }); setCurrent(result.transaction);
      if (result.fiscal) setFiscalNote(result.fiscal.action === 'EMITTED' ? 'Documento fiscal emitido após a confirmação do pagamento.' : result.fiscal.message ?? '');
      if (result.paid) onApproved(); }
    catch (cause) { setError(errorMessage(cause, 'Não foi possível consultar o provedor')); } finally { setBusy(false); }
  }
  async function undo() {
    const reason = window.prompt('Motivo do desfazimento (mínimo 5 caracteres):');
    if (!reason || reason.trim().length < 5) return;
    setBusy(true); setError('');
    try { const result = await api<{ transaction: TefTransaction }>(`/tef/transactions/${current.id}/undo`, { method: 'POST', body: JSON.stringify({ reason, confirm: true }) }); setCurrent(result.transaction); }
    catch (cause) { setError(errorMessage(cause, 'Não foi possível desfazer a cobrança')); } finally { setBusy(false); }
  }
  const open = ['PENDING', 'TIMEOUT', 'UNKNOWN'].includes(current.status);
  const advice = current.status === 'DENIED' ? 'Pagamento negado. O pedido continua sem pagamento: tente outra forma de pagamento no Caixa.'
    : open ? 'O pagamento ainda não está confirmado. Consulte o provedor antes de qualquer nova cobrança, para o cliente não pagar duas vezes.'
    : current.status === 'ERROR' ? 'O provedor não tem registro desta transação; nenhuma cobrança foi feita. Conclua o pedido no Caixa.' : 'Esta transação não foi aprovada.';
  return <div role="dialog" aria-modal="true" aria-label="Pagamento TEF" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
    <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-2xl">
      <h3 className="text-lg font-bold text-slate-900">Pagamento TEF — pedido {orderLabel}</h3>
      <p className="text-2xl font-black text-slate-900">{formatMoney(current.amount)}</p>
      <p><Badge tone={state.tone}>{state.label}</Badge>{current.simulated && <span className="ml-2"><Badge tone="amber">simulada</Badge></span>}</p>
      {current.responseMessage && <p className="text-sm text-slate-600">{current.responseMessage}</p>}
      <p className="text-sm text-slate-700">{advice}</p>
      {fiscalNote && <p className="text-sm text-slate-700">{fiscalNote}</p>}
      {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
      <div className="flex gap-2">{open && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void consult()}>{busy ? 'Consultando…' : 'Consultar no provedor'}</button>}{open && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void undo()}>Desfazer cobrança</button>}<button type="button" className={secondaryButtonClass} onClick={onClose}>Fechar</button></div>
    </div>
  </div>;
}
