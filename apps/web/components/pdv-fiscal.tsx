'use client';

import Link from './nav-link';
import { useEffect, useState } from 'react';
import { buttonClass, Field, Notice, Select, secondaryButtonClass } from './app-shell';
import { textareaClass } from './ui';
import { api, ApiError, errorMessage, formatDateTime } from '../lib/api';
import { environmentLabel, kindLabel, type FiscalSettingsView, type Inutilization } from '../lib/types-fiscal';

type CheckoutResult = {
  fiscalMode: 'FISCAL' | 'NON_FISCAL';
  document: { id: string; status: string; number?: string | null; series?: string | null; accessKey?: string | null; documentUrl?: string | null; error?: string | null; contingency?: boolean } | null;
  emission?: { httpStatus: number; message: string };
};
type Numbering = { items: { kind: string; series: string; nextNumber: number }[]; environment: string };
type Kind = 'NFCE' | 'NFE';

/** Decides the fiscal outcome of a paid sale. Never throws: the sale is already registered, so failures become a message. */
export async function fiscalCheckout(orderId: string, emit?: boolean): Promise<string> {
  try {
    const result = await api<CheckoutResult>(`/fiscal/orders/${orderId}/checkout`, { method: 'POST', body: JSON.stringify(emit === undefined ? {} : { emit }) });
    const doc = result.document;
    if (result.fiscalMode === 'NON_FISCAL' || !doc) return result.emission?.message ? `Sem documento fiscal: ${result.emission.message}` : 'Registrada sem emissão fiscal.';
    if (doc.status === 'AUTHORIZED') return `NFC-e nº ${doc.number ?? '—'} autorizada.`;
    if (doc.status === 'CONTINGENCY' || doc.contingency) return 'NFC-e em contingência — será transmitida depois (Contingências).';
    if (doc.status === 'PENDING' || doc.status === 'PROCESSING') return 'NFC-e sem protocolo — será consultada.';
    return `NFC-e não autorizada: ${doc.error || result.emission?.message || doc.status} — corrija em Documentos fiscais.`;
  } catch (error) {
    return `NFC-e não emitida: ${errorMessage(error, 'falha na emissão')} — corrija em Documentos fiscais.`;
  }
}

export function FiscalReadinessBanner({ settings }: { settings: FiscalSettingsView | null }) {
  if (!settings || settings.pdvMode === 'NON_FISCAL' || settings.readiness.NFCE.length === 0) return null;
  return <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
    <span>Configuração da NFC-e incompleta ({settings.readiness.NFCE.length} pendência(s)): as vendas serão registradas, mas a emissão fiscal pode falhar.</span>
    <Link href="/settings?tab=fiscal" className="font-semibold underline">Configurações fiscais</Link>
  </div>;
}

export function FiscalChoiceDialog({ onChoose }: { onChoose: (emit: boolean) => void }) {
  return <div role="dialog" aria-modal="true" aria-labelledby="fiscal-choice-title" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
      <h3 id="fiscal-choice-title" className="text-center text-lg font-black text-slate-900">DESEJA EMITIR DOCUMENTO FISCAL PARA ESTA VENDA?</h3>
      <p className="mt-2 text-center text-xs text-slate-500">O pagamento já foi registrado. A escolha fica registrada com operador, data e hora.</p>
      <div className="mt-4 grid gap-2">
        <button type="button" autoFocus className={`${buttonClass} min-h-14 text-base`} onClick={() => onChoose(true)}>SIM — EMITIR DOCUMENTO FISCAL</button>
        <button type="button" className={`${secondaryButtonClass} min-h-14 text-base font-bold`} onClick={() => onChoose(false)}>NÃO — REGISTRAR SEM EMISSÃO FISCAL</button>
      </div>
    </div>
  </div>;
}

export function InutilizationDialog({ onClose }: { onClose: () => void }) {
  const [numbering, setNumbering] = useState<Numbering | null>(null);
  const [history, setHistory] = useState<Inutilization[]>([]);
  const [kind, setKind] = useState<Kind>('NFCE');
  const [series, setSeries] = useState('');
  const [numberFrom, setNumberFrom] = useState('');
  const [numberTo, setNumberTo] = useState('');
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);

  const seriesFor = (data: Numbering | null, target: Kind) => data?.items.find(item => item.kind === target)?.series ?? '';
  async function loadHistory() {
    const list = await api<{ items: Inutilization[] }>('/fiscal/inutilizations').catch(() => ({ items: [] }));
    setHistory(list.items.slice(0, 5));
  }
  useEffect(() => {
    let alive = true;
    void (async () => {
      const data = await api<Numbering>('/fiscal/numbering').catch(() => null);
      const list = await api<{ items: Inutilization[] }>('/fiscal/inutilizations').catch(() => ({ items: [] }));
      if (!alive) return;
      setNumbering(data); setSeries(current => current || seriesFor(data, 'NFCE')); setHistory(list.items.slice(0, 5));
    })();
    return () => { alive = false; };
  }, []);

  function chooseKind(next: Kind) { setKind(next); setSeries(seriesFor(numbering, next)); }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    const from = Number(numberFrom); const to = Number(numberTo || numberFrom); const text = justification.trim();
    if (!series.trim() || !Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < from) { setNotice({ text: 'Informe a série e uma faixa de números válida (inicial ≤ final).', kind: 'error' }); return; }
    if (text.length < 15 || text.length > 255) { setNotice({ text: 'A justificativa deve ter entre 15 e 255 caracteres.', kind: 'error' }); return; }
    if (!window.confirm(`Inutilizar ${kindLabel[kind]} série ${series} números ${from} a ${to}? Esta operação não pode ser desfeita.`)) return;
    setBusy(true);
    try {
      const result = await api<Inutilization>('/fiscal/inutilizations', { method: 'POST', body: JSON.stringify({ kind, series: series.trim(), numberFrom: from, numberTo: to, justification: text }) });
      if (result.status === 'REJECTED') setNotice({ text: `Inutilização rejeitada: ${result.message ?? 'sem detalhes'}`, kind: 'error' });
      else { setNotice({ text: `Numeração inutilizada${result.protocol ? ` — protocolo ${result.protocol}` : ''}.`, kind: 'success' }); setNumberFrom(''); setNumberTo(''); setJustification(''); }
      await loadHistory();
    } catch (error) {
      setNotice({ text: error instanceof ApiError && error.status === 501 ? 'O provedor fiscal configurado não suporta inutilização.' : errorMessage(error, 'Erro ao inutilizar a numeração'), kind: 'error' });
    } finally { setBusy(false); }
  }

  const next = numbering?.items.find(item => item.kind === kind);
  return <div role="dialog" aria-modal="true" aria-labelledby="inutilization-title" className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4" onKeyDown={event => { if (event.key === 'Escape' && !busy) onClose(); }}>
    <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-2xl">
      <div className="mb-3 flex items-center justify-between gap-3"><h3 id="inutilization-title" className="text-lg font-bold text-slate-900">Inutilizar numeração</h3><button type="button" className={secondaryButtonClass} disabled={busy} onClick={onClose}>Fechar</button></div>
      {notice && <Notice message={notice.text} kind={notice.kind} />}
      <form onSubmit={event => void submit(event)} className="grid gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Modelo" value={kind} onChange={event => chooseKind(event.target.value as Kind)}><option value="NFCE">{kindLabel.NFCE}</option><option value="NFE">{kindLabel.NFE}</option></Select>
          <Field label="Série" inputMode="numeric" maxLength={3} required value={series} onChange={event => setSeries(event.target.value.replace(/\D/g, ''))} />
          <Field label="Número inicial" type="number" min={1} required value={numberFrom} onChange={event => setNumberFrom(event.target.value)} />
          <Field label="Número final" type="number" min={1} placeholder={numberFrom || undefined} value={numberTo} onChange={event => setNumberTo(event.target.value)} />
        </div>
        {next && <p className="text-xs text-slate-500">Próximo número da série {next.series}: {next.nextNumber}{numbering ? ` · ${environmentLabel[numbering.environment as keyof typeof environmentLabel] ?? numbering.environment}` : ''}. Só podem ser inutilizados números não utilizados.</p>}
        <label className="block text-sm font-medium text-slate-700">Justificativa<textarea className={textareaClass} rows={3} minLength={15} maxLength={255} required value={justification} onChange={event => setJustification(event.target.value)} /><span className={`mt-1 block text-right text-xs ${justification.trim().length < 15 ? 'text-amber-700' : 'text-slate-500'}`}>{justification.trim().length}/255 (mínimo 15)</span></label>
        <button type="submit" className={`${buttonClass} min-h-12`} disabled={busy}>{busy ? 'Enviando…' : 'Inutilizar numeração'}</button>
      </form>
      <h4 className="mt-5 text-xs font-bold uppercase tracking-wider text-slate-600">Últimas inutilizações</h4>
      {history.length === 0 ? <p className="mt-2 text-sm text-slate-500">Nenhuma inutilização registrada.</p> :
        <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">{history.map(item => <li key={item.id} className="px-3 py-2">
          <p className="font-medium text-slate-800">{kindLabel[item.kind] ?? item.kind} · série {item.series} · {item.numberFrom}{item.numberTo !== item.numberFrom ? `–${item.numberTo}` : ''} <span className={item.status === 'REGISTERED' ? 'text-emerald-700' : 'text-red-700'}>({item.status === 'REGISTERED' ? 'registrada' : 'rejeitada'})</span></p>
          <p className="text-xs text-slate-500">{formatDateTime(item.createdAt)} · {environmentLabel[item.environment]}{item.protocol ? ` · protocolo ${item.protocol}` : ''}{item.message && item.status === 'REJECTED' ? ` · ${item.message}` : ''}</p>
        </li>)}</ul>}
    </div>
  </div>;
}
