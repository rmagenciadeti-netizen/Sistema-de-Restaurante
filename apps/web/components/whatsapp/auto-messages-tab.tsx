'use client';

import { useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { AutoMessage } from '../../lib/types-whatsapp';
import { useAutoLoad } from '../../lib/use-auto-load';
import { Notice, panelClass, secondaryButtonClass, buttonClass } from '../app-shell';
import { Badge, EmptyState, Toggle, textareaClass } from '../ui';
import { Flash, friendlyError } from './common';

const sampleValues: Record<string, string> = {
  nome: 'Maria', cliente: 'Maria', pedido: '#128', codigo: '#128', total: 'R$ 89,90', restaurante: 'Restaurante Exemplo', loja: 'Restaurante Exemplo',
  horario: 'das 11h às 23h', horarios: 'Seg a Dom, das 11h às 23h', endereco: 'Rua das Flores, 123', tempo: '40 minutos', previsao: '40 minutos', data: '20/11/2026', hora: '19:30',
  pessoas: '4', mesa: '12', link: 'https://exemplo.com/loja', entregador: 'João', taxa: 'R$ 6,00', pagamento: 'PIX',
};
const maxBody = 1000;

function preview(body: string): string {
  return body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, name: string) => sampleValues[name.toLowerCase()] ?? `[${name}]`);
}

function AutoMessageCard({ item, globalOff, onSaved }: { item: AutoMessage; globalOff: boolean; onSaved: (message: string) => void }) {
  const [enabled, setEnabled] = useState(item.enabled);
  const [body, setBody] = useState(item.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const dirty = enabled !== item.enabled || body !== item.body;
  const invalid = body.trim().length === 0 || body.length > maxBody;

  function insert(variable: string) {
    const token = `{{${variable}}}`;
    const element = area.current;
    const start = element?.selectionStart ?? body.length; const end = element?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    setBody(next);
    const cursor = start + token.length;
    setTimeout(() => { element?.focus(); element?.setSelectionRange(cursor, cursor); }, 0);
  }
  async function save() {
    setBusy(true); setError(null);
    try { await api(`/whatsapp/auto-messages/${item.key}`, { method: 'PUT', body: JSON.stringify({ enabled, body }) }); onSaved(`“${item.title}” salva.`); } catch (e) { setError(friendlyError(e, 'Erro ao salvar a mensagem')); } finally { setBusy(false); }
  }
  async function reset() {
    if (!window.confirm('Restaurar o texto padrão desta mensagem? Suas alterações serão perdidas.')) return;
    setBusy(true); setError(null);
    try { await api(`/whatsapp/auto-messages/${item.key}/reset`, { method: 'POST' }); setBody(item.defaultBody); onSaved(`“${item.title}” restaurada para o texto padrão.`); } catch (e) { setError(friendlyError(e, 'Erro ao restaurar a mensagem')); } finally { setBusy(false); }
  }

  return <article className={`${panelClass} transition ${globalOff ? 'opacity-60' : ''}`}>
    <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h3 className="font-semibold text-slate-900">{item.title}</h3><p className="mt-0.5 text-sm text-slate-500">{item.description}</p></div>{dirty && <Badge tone="amber">Não salvo</Badge>}</div>
    <div className="mt-3"><Toggle label="Enviar esta mensagem" checked={enabled} onChange={setEnabled} /></div>
    <label className="mt-3 block text-sm font-medium text-slate-700">Texto da mensagem
      <textarea ref={area} rows={5} value={body} maxLength={maxBody + 200} className={textareaClass} onChange={event => setBody(event.target.value)} aria-invalid={invalid} />
    </label>
    <p className={`mt-1 text-right text-xs ${body.length > maxBody ? 'text-red-600' : 'text-slate-400'}`}>{body.length}/{maxBody}</p>
    {item.variables.length > 0 && <div className="mt-1"><p className="text-xs font-semibold text-slate-600">Variáveis (clique para inserir no cursor):</p>
      <div className="mt-1 flex flex-wrap gap-1.5">{item.variables.map(variable => <button key={variable} type="button" onClick={() => insert(variable)} className="min-h-8 rounded-full border border-brand-300 bg-brand-50 px-3 py-1 font-mono text-xs text-brand-700 outline-none hover:bg-brand-100 focus-visible:ring-2 focus-visible:ring-brand-500">{`{{${variable}}}`}</button>)}</div></div>}
    <div className="mt-3 rounded-xl bg-slate-50 p-3"><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Prévia com valores de exemplo</p><p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{preview(body) || '—'}</p></div>
    {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
    <div className="mt-4 flex flex-wrap gap-2">
      <button type="button" className={`${buttonClass} min-h-11`} disabled={busy || !dirty || invalid} onClick={() => void save()}>Salvar</button>
      <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={busy || body === item.defaultBody} onClick={() => void reset()}>Restaurar padrão</button>
    </div>
  </article>;
}

export function AutoMessagesTab({ autoMessagesEnabled }: { autoMessagesEnabled: boolean }) {
  const [items, setItems] = useState<AutoMessage[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);

  async function load() {
    try { const result = await api<{ items: AutoMessage[] }>('/whatsapp/auto-messages'); setItems(Array.isArray(result?.items) ? result.items : []); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao carregar as mensagens automáticas'), kind: 'error' }); } finally { setLoaded(true); }
  }
  useAutoLoad(load);
  async function saved(message: string) { await load(); setFlash({ text: message, kind: 'success' }); }

  return <div>
    {flash && <Notice message={flash.text} kind={flash.kind} />}
    {!autoMessagesEnabled && <p role="alert" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"><strong>Mensagens automáticas desligadas.</strong> Nenhuma mensagem automática está sendo enviada. Os textos abaixo continuam editáveis; ligue a chave “Mensagens automáticas” no topo da página para voltar a enviar.</p>}
    <p className="mb-4 text-sm text-slate-600">Textos enviados automaticamente ao cliente (boas-vindas e avisos de pedido e reserva). Use as variáveis para personalizar.</p>
    <div className="grid gap-4 xl:grid-cols-2">{items.map(item => <AutoMessageCard key={`${item.key}:${item.body}:${item.enabled}`} item={item} globalOff={!autoMessagesEnabled} onSaved={message => void saved(message)} />)}</div>
    {loaded && items.length === 0 && <EmptyState icon="✉️" title="Nenhuma mensagem automática disponível" hint="Se o problema persistir, verifique se a API do WhatsApp está atualizada." />}
  </div>;
}
