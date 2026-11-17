'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime, ListResponse, WhatsappMessage } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';

const statusLabel: Record<string, string> = { QUEUED: 'Na fila', SENT: 'Enviada', FAILED: 'Falhou' };
const statusTone: Record<string, string> = { QUEUED: 'text-amber-300', SENT: 'text-emerald-300', FAILED: 'text-red-300' };

export default function WhatsappPage() {
  const [items, setItems] = useState<WhatsappMessage[]>([]); const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  async function load() {
    try { setItems((await api<ListResponse<WhatsappMessage>>('/whatsapp/outbox')).items); } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao carregar mensagens'), kind: 'error' }); }
  }
  useAutoLoad(load, 15000);
  async function retry(item: WhatsappMessage) {
    try { await api(`/whatsapp/outbox/${item.id}/retry`, { method: 'POST' }); setNotice({ text: 'Mensagem recolocada na fila para novo envio.', kind: 'success' }); await load(); } catch (e) { setNotice({ text: errorMessage(e, 'Erro ao reenviar mensagem'), kind: 'error' }); }
  }
  const queued = items.filter(item => item.status === 'QUEUED').length;

  return <AppShell title="WhatsApp">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <div className="mb-6 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-sm text-blue-100">O envio depende do worker de WhatsApp configurado no servidor (variáveis <code>WHATSAPP_*</code>). Sem essa configuração, as mensagens permanecem com o status “Na fila” e nada é enviado ao cliente.{queued > 0 && <> Há <strong>{queued}</strong> mensagem(ns) na fila.</>}</div>
    <section className={panelClass}><div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">Caixa de saída ({items.length})</h2><button className={secondaryButtonClass} onClick={() => void load()}>Atualizar</button></div>
      <div className="grid gap-3">{items.map(item => <article key={item.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-800 p-4"><div><h3 className="font-semibold">{item.template} <span className={`text-xs font-normal ${statusTone[item.status]}`}>{statusLabel[item.status] ?? item.status}</span></h3><p className="mt-1 text-sm text-slate-400">Para {item.toPhone} · criada em {formatDateTime(item.createdAt)}{item.sentAt ? ` · enviada em ${formatDateTime(item.sentAt)}` : ''}</p>{item.error && <p className="mt-1 text-sm text-red-300">Erro: {item.error}</p>}</div>{item.status === 'FAILED' && item.toPhone !== 'redacted' && <button className={secondaryButtonClass} onClick={() => void retry(item)}>Reenviar</button>}</article>)}</div>
      {items.length === 0 && <p className="text-slate-400">Nenhuma mensagem na caixa de saída.</p>}</section>
  </AppShell>;
}
