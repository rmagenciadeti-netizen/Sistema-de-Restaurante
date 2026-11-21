'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ListResponse } from '../../lib/api';
import type { ChatMessage, ConversationAgentInfo, ConversationFilter, WhatsappConversation } from '../../lib/types-whatsapp';
import { useAutoLoad } from '../../lib/use-auto-load';
import { Notice, inputClass, panelClass, secondaryButtonClass, buttonClass } from '../app-shell';
import { Badge, EmptyState } from '../ui';
import { Flash, displayPhone, friendlyError, shortTime, sourceLabel } from './common';

const filters: { key: ConversationFilter; label: string }[] = [{ key: 'all', label: 'Todas' }, { key: 'handoff', label: 'Aguardando atendente' }, { key: 'unread', label: 'Não lidas' }];
type Pending = { id: string; body: string; at: number };
const conversationName = (conversation: WhatsappConversation) => conversation.name || displayPhone(conversation.phone);

export function ConversationsTab({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<WhatsappConversation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<ConversationFilter>('all');
  const [selected, setSelected] = useState<WhatsappConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [showChat, setShowChat] = useState(false);
  const [agentInfo, setAgentInfo] = useState<ConversationAgentInfo | null>(null);
  const [showAgent, setShowAgent] = useState(false);
  const selectedId = useRef<string | null>(null);
  const query = useRef({ q: '', filter: 'all' as ConversationFilter });
  const listInFlight = useRef(false);
  const messagesInFlight = useRef(false);
  const messagesSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const showAgentRef = useRef(false);

  async function loadList() {
    if (listInFlight.current) return;
    listInFlight.current = true;
    const { q: search, filter: kind } = query.current;
    try {
      const params = new URLSearchParams({ filter: kind }); if (search.trim()) params.set('q', search.trim());
      const result = await api<ListResponse<WhatsappConversation>>(`/whatsapp/conversations?${params}`);
      if (query.current.q !== search || query.current.filter !== kind) return;
      const list = Array.isArray(result?.items) ? result.items : [];
      setItems(list);
      setSelected(current => (current ? list.find(item => item.id === current.id) ?? current : current));
      setLoaded(true);
    } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao carregar conversas'), kind: 'error' }); setLoaded(true); } finally { listInFlight.current = false; }
  }

  async function loadAgentInfo(id: string) {
    try { const info = await api<ConversationAgentInfo>(`/whatsapp/conversations/${id}/agent`); if (selectedId.current === id) setAgentInfo(info); } catch { if (selectedId.current === id) setAgentInfo(null); }
  }
  async function loadMessages(id: string, force = false) {
    if (messagesInFlight.current && !force) return;
    messagesInFlight.current = true;
    const seq = ++messagesSeq.current;
    try {
      const result = await api<{ items: ChatMessage[] }>(`/whatsapp/conversations/${id}/messages`);
      if (seq !== messagesSeq.current || selectedId.current !== id) return;
      const list = Array.isArray(result?.items) ? result.items : [];
      setMessages(list);
      setPending(current => current.filter(item => Date.now() - item.at < 30000 && !list.some(message => message.direction === 'OUT' && message.body === item.body)));
    } catch (e) { if (selectedId.current === id) setFlash({ text: friendlyError(e, 'Erro ao carregar mensagens'), kind: 'error' }); } finally { if (seq === messagesSeq.current) messagesInFlight.current = false; }
  }

  useAutoLoad(async () => { await loadList(); if (selectedId.current) { await loadMessages(selectedId.current); if (showAgentRef.current) await loadAgentInfo(selectedId.current); } }, 5000);

  const bubbleCount = messages.length + pending.length;
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [bubbleCount, selected?.id]);

  function changeSearch(value: string) {
    setQ(value); query.current.q = value;
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => { listInFlight.current = false; void loadList(); }, 350);
  }
  function changeFilter(value: ConversationFilter) { setFilter(value); query.current.filter = value; listInFlight.current = false; void loadList(); }
  function select(conversation: WhatsappConversation) {
    selectedId.current = conversation.id; messagesSeq.current += 1; messagesInFlight.current = false;
    setSelected(conversation); setMessages([]); setPending([]); setText(''); setFlash(null); setShowChat(true); setAgentInfo(null); if (showAgentRef.current) void loadAgentInfo(conversation.id);
    void loadMessages(conversation.id, true).then(() => { void loadList(); onChanged(); });
  }

  async function send() {
    const body = text.trim();
    if (!selected || !body || sending) return;
    if (body.length > 1000) { setFlash({ text: 'A mensagem pode ter no máximo 1000 caracteres.', kind: 'error' }); return; }
    const id = selected.id;
    setSending(true); setFlash(null);
    try {
      await api(`/whatsapp/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text: body }) });
      setText('');
      setPending(current => [...current, { id: `pending-${Date.now()}`, body, at: Date.now() }]);
      setSelected(current => (current && current.id === id ? { ...current, handoff: true } : current));
      void loadMessages(id, true); void loadList(); onChanged();
    } catch (e) { setFlash({ text: friendlyError(e, 'Não foi possível enviar a mensagem'), kind: 'error' }); } finally { setSending(false); }
  }

  async function patch(change: { handoff?: boolean; optOut?: boolean }) {
    if (!selected) return;
    setBusy(true); setFlash(null);
    try {
      const updated = await api<WhatsappConversation | undefined>(`/whatsapp/conversations/${selected.id}`, { method: 'PATCH', body: JSON.stringify(change) });
      const next = { ...selected, ...change, ...(updated && typeof updated === 'object' && 'id' in updated ? updated : {}) };
      setSelected(next); setItems(current => current.map(item => (item.id === next.id ? next : item)));
      onChanged();
    } catch (e) { setFlash({ text: friendlyError(e, 'Não foi possível atualizar a conversa'), kind: 'error' }); } finally { setBusy(false); }
  }

  const bubbles = [...messages, ...pending.map(item => ({ id: item.id, direction: 'OUT' as const, source: 'STAFF' as const, body: item.body, createdAt: '' }))];

  return <div>
    {flash && <Notice message={flash.text} kind={flash.kind} />}
    <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
      <section className={`${panelClass} !p-3 ${showChat ? 'hidden md:block' : 'block'}`} aria-label="Lista de conversas">
        <label className="block text-sm font-medium text-slate-700">Buscar conversa<input type="search" className={inputClass} placeholder="Nome ou telefone" value={q} onChange={event => changeSearch(event.target.value)} /></label>
        <div role="group" aria-label="Filtrar conversas" className="mt-3 flex flex-wrap gap-1">
          {filters.map(option => <button key={option.key} type="button" aria-pressed={filter === option.key} onClick={() => changeFilter(option.key)} className={`min-h-9 rounded-lg px-3 py-1.5 text-xs font-semibold outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${filter === option.key ? 'bg-neutral-950 text-brand-300' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{option.label}</button>)}
        </div>
        <ul className="mt-3 max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
          {items.map(conversation => <li key={conversation.id}>
            <button type="button" onClick={() => select(conversation)} aria-current={selected?.id === conversation.id ? 'true' : undefined} className={`flex w-full min-h-16 items-start gap-3 rounded-xl px-3 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${selected?.id === conversation.id ? 'bg-brand-50' : 'hover:bg-slate-50'}`}>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-slate-900">{conversationName(conversation)}</span>{conversation.handoff && <Badge tone="amber">Atendente</Badge>}{conversation.optOut && <Badge tone="red">Bloqueada</Badge>}</span>
                <span className="mt-0.5 block truncate text-xs text-slate-500">{conversation.lastMessage ?? 'Sem mensagens'}</span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1"><span className="text-[11px] text-slate-400">{shortTime(conversation.lastMessageAt)}</span>{conversation.unread > 0 && <span aria-label={`${conversation.unread} não lidas`} className="grid h-5 min-w-5 place-items-center rounded-full bg-brand-500 px-1 text-[11px] font-bold text-neutral-950">{conversation.unread}</span>}</span>
            </button>
          </li>)}
        </ul>
        {loaded && items.length === 0 && <p className="px-2 py-8 text-center text-sm text-slate-500">Nenhuma conversa encontrada.</p>}
      </section>

      <section className={`${panelClass} flex min-h-[28rem] flex-col !p-0 ${showChat ? 'flex' : 'hidden md:flex'}`} aria-label="Conversa">
        {!selected ? <div className="grid flex-1 place-items-center p-6"><EmptyState icon="💬" title="Selecione uma conversa" hint="Escolha um cliente na lista para ver as mensagens e atender." /></div> : <>
          <header className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl bg-neutral-950 px-4 py-3 text-white">
            <div className="flex min-w-0 items-center gap-2">
              <button type="button" onClick={() => setShowChat(false)} className="rounded-lg px-2 py-1 text-brand-300 outline-none focus-visible:ring-2 focus-visible:ring-brand-500 md:hidden" aria-label="Voltar para a lista">‹ Voltar</button>
              <div className="min-w-0"><h3 className="truncate font-semibold">{conversationName(selected)}</h3><p className="text-xs text-neutral-400">{displayPhone(selected.phone)}{selected.handoff ? ' · atendimento humano' : ' · robô responde'}{selected.optOut ? ' · mensagens automáticas bloqueadas' : ''}</p></div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => void patch({ handoff: !selected.handoff })} className={`${selected.handoff ? secondaryButtonClass : buttonClass} min-h-10`}>{selected.handoff ? 'Devolver ao robô' : 'Assumir atendimento'}</button>
              <button type="button" disabled={busy} onClick={() => void patch({ optOut: !selected.optOut })} className={`${secondaryButtonClass} min-h-10`}>{selected.optOut ? 'Liberar mensagens automáticas' : 'Bloquear mensagens automáticas'}</button>
            </div>
          </header>
          <div className="border-b border-slate-200 bg-white px-4 py-2 text-xs">
            <button type="button" aria-expanded={showAgent} className="font-semibold text-brand-700 outline-none focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => { const next = !showAgent; showAgentRef.current = next; setShowAgent(next); if (next && selected) void loadAgentInfo(selected.id); }}>{showAgent ? '▾' : '▸'} O que o atendente de IA sabe e fez nesta conversa</button>
            {showAgent && (agentInfo ? <div className="mt-2 grid gap-1 text-slate-700">
              {agentInfo.handoff && <p><strong>Motivo do atendimento humano:</strong> {agentInfo.handoff.reason} — {agentInfo.handoff.summary}</p>}
              {agentInfo.profile.name && <p><strong>Nome:</strong> {agentInfo.profile.name}</p>}
              {agentInfo.profile.addresses.length > 0 && <p><strong>Endereços:</strong> {agentInfo.profile.addresses.join(' | ')}</p>}
              {agentInfo.facts.length > 0 && <p><strong>Lembra que:</strong> {agentInfo.facts.join('; ')}</p>}
              {(agentInfo.reservation.partySize || agentInfo.reservation.date) && <p><strong>Reserva em andamento:</strong> {agentInfo.reservation.partySize ?? '?'} pessoa(s), {agentInfo.reservation.date ?? '?'} {agentInfo.reservation.time ?? ''}</p>}
              {agentInfo.order.items.length > 0 && <p><strong>Pedido em andamento:</strong> {agentInfo.order.items.map(item => `${item.quantity}x ${item.name}`).join(', ')}</p>}
              {agentInfo.pending.map(item => <p key={item.action}><strong>Aguardando o cliente confirmar:</strong> {item.summary}</p>)}
              {agentInfo.actions.length > 0 && <p><strong>Ações:</strong> {agentInfo.actions.slice(0, 6).map(action => `${action.tool}${action.ok ? '' : ' (recusada)'}`).join(', ')}</p>}
              {!agentInfo.handoff && !agentInfo.profile.name && agentInfo.turns === 0 && <p className="text-slate-500">O atendente de IA ainda não conversou com este cliente.</p>}
            </div> : <p className="mt-2 text-slate-500">Carregando…</p>)}
          </div>
          <div ref={scroller} className="flex-1 space-y-2 overflow-y-auto bg-slate-50 p-4" style={{ maxHeight: '55vh' }} aria-live="polite">
            {bubbles.length === 0 && <p className="py-8 text-center text-sm text-slate-500">Nenhuma mensagem ainda.</p>}
            {bubbles.map(message => {
              const mine = message.direction === 'OUT';
              return <div key={message.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${mine ? (message.source === 'STAFF' ? 'rounded-br-sm bg-brand-500 text-neutral-950' : 'rounded-br-sm bg-neutral-900 text-white') : 'rounded-bl-sm border border-slate-200 bg-white text-slate-900'}`}>
                  {mine && <p className={`mb-0.5 text-[10px] font-semibold uppercase tracking-wider ${message.source === 'STAFF' ? 'text-neutral-800' : 'text-brand-300'}`}>{sourceLabel[message.source] ?? message.source}</p>}
                  <p className="whitespace-pre-wrap break-words">{message.body}</p>
                  <p className={`mt-1 text-right text-[10px] ${mine ? 'opacity-70' : 'text-slate-400'}`}>{message.createdAt ? shortTime(message.createdAt) : 'enviando…'}</p>
                </div>
              </div>;
            })}
          </div>
          <form className="flex items-end gap-2 border-t border-slate-200 p-3" onSubmit={event => { event.preventDefault(); void send(); }}>
            <label className="block flex-1 text-sm font-medium text-slate-700"><span className="sr-only">Mensagem</span>
              <textarea rows={2} maxLength={1000} value={text} placeholder="Escreva uma mensagem (Enter envia, Shift+Enter quebra a linha)" className={`${inputClass} !mt-0 resize-none`} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
            </label>
            <button type="submit" disabled={sending || !text.trim()} className={`${buttonClass} min-h-11`}>Enviar</button>
          </form>
          <p className="px-4 pb-3 text-xs text-slate-500">Ao enviar uma mensagem você assume o atendimento e o robô para de responder esta conversa.</p>
        </>}
      </section>
    </div>
  </div>;
}
