'use client';

import { useRef, useState } from 'react';
import { api, formatDateTime, ListResponse } from '../../lib/api';
import type { OutboxItem } from '../../lib/types-whatsapp';
import { useAutoLoad } from '../../lib/use-auto-load';
import { Notice, panelClass, secondaryButtonClass } from '../app-shell';
import { Badge } from '../ui';
import { Flash, friendlyError } from './common';

const statusLabel: Record<string, string> = { QUEUED: 'Na fila', SENT: 'Enviada', FAILED: 'Falhou' };
const statusTone: Record<string, 'amber' | 'green' | 'red'> = { QUEUED: 'amber', SENT: 'green', FAILED: 'red' };
const templateLabel: Record<string, string> = { free_text: 'Texto livre' };

export function OutboxTab({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [flash, setFlash] = useState<Flash>(null);
  const inFlight = useRef(false);

  async function load() {
    if (inFlight.current) return;
    inFlight.current = true;
    try { const result = await api<ListResponse<OutboxItem>>('/whatsapp/outbox'); setItems(Array.isArray(result?.items) ? result.items : []); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao carregar mensagens'), kind: 'error' }); } finally { inFlight.current = false; }
  }
  useAutoLoad(load, 15000);

  async function retry(item: OutboxItem) {
    try { await api(`/whatsapp/outbox/${item.id}/retry`, { method: 'POST' }); setFlash({ text: 'Mensagem recolocada na fila para novo envio.', kind: 'success' }); onChanged(); await load(); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao reenviar mensagem'), kind: 'error' }); }
  }
  const queued = items.filter(item => item.status === 'QUEUED').length;

  return <div>
    {flash && <Notice message={flash.text} kind={flash.kind} />}
    <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">O envio depende de uma conexão ativa (aba “Conexão”) ou do worker de WhatsApp configurado no servidor (variáveis <code>WHATSAPP_*</code>). Sem isso, as mensagens permanecem com o status “Na fila” e nada é enviado ao cliente.{queued > 0 && <> Há <strong>{queued}</strong> mensagem(ns) na fila.</>}</div>
    <section className={panelClass}>
      <div className="mb-4 flex items-center justify-between gap-2"><h2 className="text-lg font-semibold text-slate-900">Caixa de saída ({items.length})</h2><button type="button" className={`${secondaryButtonClass} min-h-10`} onClick={() => void load()}>Atualizar</button></div>
      <div className="grid gap-3">{items.map(item => <article key={item.id} className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 p-4">
        <div className="min-w-0">
          <h3 className="flex flex-wrap items-center gap-2 font-semibold text-slate-900">{templateLabel[item.template] ?? item.template} <Badge tone={statusTone[item.status] ?? 'neutral'}>{statusLabel[item.status] ?? item.status}</Badge></h3>
          <p className="mt-1 text-sm text-slate-500">Para {item.toPhone} · criada em {formatDateTime(item.createdAt)}{item.sentAt ? ` · enviada em ${formatDateTime(item.sentAt)}` : ''}</p>
          {item.payload?.text && <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-800">{item.payload.text}</p>}
          {item.error && <p className="mt-1 text-sm text-red-700">Erro: {item.error}</p>}
        </div>
        {item.status === 'FAILED' && item.toPhone !== 'redacted' && <button type="button" className={`${secondaryButtonClass} min-h-10`} onClick={() => void retry(item)}>Reenviar</button>}
      </article>)}</div>
      {items.length === 0 && <p className="text-slate-500">Nenhuma mensagem na caixa de saída.</p>}
    </section>
  </div>;
}
