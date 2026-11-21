'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { AgentSession, AgentSimulateResponse, SimulateResponse } from '../../lib/types-whatsapp';
import { Notice, buttonClass, inputClass, panelClass, secondaryButtonClass } from '../app-shell';
import { Badge } from '../ui';
import { Flash, friendlyError } from './common';

type Line = { id: number; from: 'me' | 'bot'; text: string; intent?: string; handoff?: boolean; tools?: { tool: string; ok: boolean; kind: string; summary: string }[] };
const shortcuts = ['oi', 'quero reservar uma mesa pra sábado às 20h', 'quais formas de pagamento? e a taxa de entrega?', 'o que vocês têm de promoção?', 'quero um hambúrguer', 'status do meu pedido', 'falar com atendente'];

export function SimulatorTab() {
  const [lines, setLines] = useState<Line[]>([]);
  const [text, setText] = useState('');
  const [state, setState] = useState<unknown>(undefined);
  const [session, setSession] = useState<AgentSession | undefined>(undefined);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const counter = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [lines.length]);

  async function send(raw: string) {
    const message = raw.trim();
    if (!message || busy) return;
    if (message.length > 1000) { setFlash({ text: 'A mensagem pode ter no máximo 1000 caracteres.', kind: 'error' }); return; }
    setBusy(true); setFlash(null); setText('');
    const mine: Line = { id: ++counter.current, from: 'me', text: message };
    setLines(current => [...current, mine]);
    try {
      const ai = await api<AgentSimulateResponse>('/whatsapp/agent/simulate', { method: 'POST', body: JSON.stringify({ text: message, ...(session ? { session } : {}), ...(phone.replace(/\D/g, '').length >= 8 ? { phone } : {}) }) });
      if (ai.available) {
        setSession(ai.session);
        const lines: Line[] = ai.replies.map((reply, index) => ({ id: ++counter.current, from: 'bot', text: reply, intent: index === 0 ? 'atendente de IA' : undefined, handoff: index === ai.replies.length - 1 && ai.handoff ? true : undefined, tools: index === 0 ? ai.actions : undefined }));
        if (lines.length === 0) lines.push({ id: ++counter.current, from: 'bot', text: ai.ok ? '(o atendente não enviaria nenhuma resposta)' : `(o atendente de IA não respondeu: ${ai.reason ?? 'erro'}; o robô clássico responderia)`, tools: ai.actions });
        setLines(current => [...current, ...lines]);
        return;
      }
      const result = await api<SimulateResponse>('/whatsapp/bot/simulate', { method: 'POST', body: JSON.stringify({ text: message, ...(state === undefined ? {} : { state }) }) });
      setState(result?.state);
      const replies = Array.isArray(result?.replies) ? result.replies : [];
      const answers: Line[] = replies.map((reply, index) => ({ id: ++counter.current, from: 'bot', text: reply, intent: index === 0 ? result.intent : undefined, handoff: index === replies.length - 1 ? result.handoff : undefined }));
      if (answers.length === 0) answers.push({ id: ++counter.current, from: 'bot', text: '(o robô não enviaria nenhuma resposta)', intent: result?.intent, handoff: result?.handoff });
      setLines(current => [...current, ...answers]);
    } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao simular a resposta'), kind: 'error' }); } finally { setBusy(false); }
  }
  function restart() { setLines([]); setState(undefined); setSession(undefined); setText(''); setFlash(null); }

  return <section className={`${panelClass} !p-0`}>
    <header className="flex flex-wrap items-center justify-between gap-2 rounded-t-2xl bg-neutral-950 px-4 py-3 text-white">
      <div><h2 className="font-semibold">Testar robô</h2><p className="text-xs text-neutral-400">Simulação — nada é enviado nem gravado (reservas e pedidos são só simulados).</p></div>
      <button type="button" className={`${secondaryButtonClass} min-h-10`} onClick={restart}>Reiniciar conversa</button>
    </header>
    <div className="p-4">
      {flash && <Notice message={flash.text} kind={flash.kind} />}
      <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">Simulação — nada é enviado nem gravado (reservas e pedidos são só simulados). O robô responde como responderia a um cliente real, usando o cardápio, as configurações e a base de conhecimento atuais.</p>
      <div ref={scroller} className="h-[50vh] min-h-72 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-4" aria-live="polite">
        {lines.length === 0 && <p className="py-10 text-center text-sm text-slate-500">Digite uma mensagem ou use um atalho para começar a testar.</p>}
        {lines.map(line => <div key={line.id} className={`flex ${line.from === 'bot' ? 'justify-end' : 'justify-start'}`}>
          <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%] ${line.from === 'bot' ? 'rounded-br-sm bg-neutral-900 text-white' : 'rounded-bl-sm border border-slate-200 bg-white text-slate-900'}`}>
            {line.from === 'bot' && <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-300">Robô</p>}
            <p className="whitespace-pre-wrap break-words">{line.text}</p>
            {(line.intent || line.handoff || line.tools?.length) && <div className="mt-1.5 flex flex-wrap gap-1">{line.intent && <Badge tone="gold">{line.intent === 'atendente de IA' ? line.intent : `intenção: ${line.intent}`}</Badge>}{line.handoff && <Badge tone="amber">passaria para atendente</Badge>}{line.tools?.map((item, index) => <span key={index} title={item.summary}><Badge tone={item.ok ? 'blue' : 'amber'}>{item.tool}{item.kind === 'WRITE' || item.kind === 'PROPOSAL' ? ' (simulado)' : ''}</Badge></span>)}</div>}
          </div>
        </div>)}
        {busy && <p className="text-xs text-slate-400">O robô está respondendo…</p>}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Atalhos de mensagens">
        {shortcuts.map(item => <button key={item} type="button" disabled={busy} onClick={() => void send(item)} className="min-h-9 rounded-full border border-brand-300 bg-brand-50 px-3 py-1 text-xs font-medium text-brand-700 outline-none hover:bg-brand-100 focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50">{item}</button>)}
      </div>
      <form className="mt-3 flex items-end gap-2" onSubmit={event => { event.preventDefault(); void send(text); }}>
        <label className="block text-sm font-medium text-slate-700"><span className="sr-only">Telefone do cliente simulado</span><input value={phone} inputMode="tel" maxLength={20} placeholder="Telefone (opcional)" title="Informe o telefone de um cliente real para testar a consulta de pedidos e reservas dele" className={`${inputClass} !mt-0 w-40`} onChange={event => setPhone(event.target.value)} /></label>
        <label className="block flex-1 text-sm font-medium text-slate-700"><span className="sr-only">Mensagem do cliente</span><input value={text} maxLength={1000} placeholder="Digite como se fosse o cliente" className={`${inputClass} !mt-0`} onChange={event => setText(event.target.value)} /></label>
        <button type="submit" disabled={busy || !text.trim()} className={`${buttonClass} min-h-11`}>Enviar</button>
      </form>
    </div>
  </section>;
}
