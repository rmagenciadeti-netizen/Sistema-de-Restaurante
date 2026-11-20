'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from './nav-link';
import { errorMessage } from '../lib/api';
import { askGuide, explainPage, guideTopic, type GuideResult } from '../lib/guide';

type Message = { role: 'user' | 'assistant'; text: string; guide?: GuideResult };
const starters = ['Como cadastro um produto?', 'Como faço o fechamento do caixa?', 'Como emito uma nota fiscal?', 'Como libero acesso para um funcionário?'];

// Help button of the RM Assistente: explains the current screen and teaches procedures step by step. Read-only; opens from the top bar on any screen.
export function GuideHelp() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (box.current && !box.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages]);

  const push = (message: Message) => setMessages(current => [...current, message]);
  async function run(user: string, job: () => Promise<GuideResult | null>) {
    if (busy) return;
    push({ role: 'user', text: user }); setBusy(true); setQuestion('');
    try {
      const result = await job();
      push(result ? { role: 'assistant', text: result.answer, guide: result } : { role: 'assistant', text: 'Esta pergunta parece ser sobre os dados do seu restaurante. Use o RM Assistente em RM INTELLIGENCE › RM Assistente.' });
    } catch (cause) { push({ role: 'assistant', text: errorMessage(cause, 'Não foi possível responder agora.') }); } finally { setBusy(false); }
  }
  const ask = (text: string) => { if (text.trim().length >= 3) void run(text.trim(), () => askGuide(text.trim(), pathname)); };

  return <div ref={box} className="relative">
    <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-label="Ajuda: aprender a usar esta tela" title="Ajuda: aprender a usar esta tela" className="grid h-10 w-10 place-items-center rounded-lg border border-white/15 text-sm font-bold text-brand-300 hover:bg-white/10">?</button>
    {open && <div role="dialog" aria-label="RM Assistente — ajuda" className="absolute right-0 z-50 mt-2 flex max-h-[80vh] w-[26rem] max-w-[92vw] flex-col rounded-xl border border-white/15 bg-neutral-950 p-3 text-sm text-white shadow-xl">
      <div className="mb-2 flex items-center justify-between"><strong>RM Assistente — como usar o sistema</strong><button type="button" className="text-xs text-neutral-400 hover:text-white" onClick={() => setOpen(false)}>Fechar</button></div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        <button type="button" disabled={busy} onClick={() => void run('Explicar esta tela', async () => explainPage(pathname))} className="rounded-full border border-brand-500/50 bg-brand-500/10 px-2.5 py-1 text-xs text-brand-200 hover:bg-brand-500/20">📍 Explicar esta tela</button>
        {starters.map(item => <button key={item} type="button" disabled={busy} onClick={() => ask(item)} className="rounded-full border border-white/20 px-2.5 py-1 text-xs text-neutral-200 hover:bg-white/10">{item}</button>)}
      </div>
      <div role="log" aria-live="polite" className="min-h-24 flex-1 space-y-2 overflow-y-auto rounded-lg bg-white/5 p-2">
        {messages.length === 0 && <p className="text-xs text-neutral-400">Pergunte como fazer qualquer tarefa (ex.: &ldquo;como cadastro um fornecedor?&rdquo;) ou peça para explicar a tela em que você está. Eu só ensino; não altero nada no sistema.</p>}
        {messages.map((message, index) => <div key={index} className={message.role === 'user' ? 'ml-auto max-w-[90%] rounded-xl bg-brand-500 px-3 py-1.5 text-xs font-medium text-neutral-950' : 'rounded-xl border border-white/10 bg-neutral-900 px-3 py-2 text-xs text-neutral-100'}>
          <p className="whitespace-pre-line">{message.text}</p>
          {message.guide?.topic && message.guide.kind !== 'fallback' && <Link href={message.guide.topic.href} onClick={() => setOpen(false)} className="mt-2 inline-block font-semibold text-brand-300 underline">Abrir esta tela ›</Link>}
          {message.guide && message.guide.related.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{message.guide.related.map(item => <button key={item.id} type="button" disabled={busy} onClick={() => void run(item.title, () => guideTopic(item.id))} className="rounded-full border border-white/20 px-2 py-0.5 text-[11px] text-neutral-200 hover:bg-white/10">{item.title}</button>)}</div>}
          {message.guide && <p className="mt-2 text-[10px] text-neutral-500">{message.guide.notice}</p>}
        </div>)}
        {busy && <p className="text-xs text-neutral-400">Consultando o guia…</p>}
        <div ref={endRef} />
      </div>
      <form className="mt-2 flex gap-2" onSubmit={event => { event.preventDefault(); ask(question); }}>
        <input aria-label="Pergunta sobre como usar o sistema" value={question} maxLength={300} onChange={event => setQuestion(event.target.value)} placeholder="Como faço…?" className="min-w-0 flex-1 rounded-lg border border-white/20 bg-neutral-900 px-3 py-2 text-xs text-white placeholder:text-neutral-500" />
        <button disabled={busy || question.trim().length < 3} className="rounded-lg bg-brand-500 px-3 py-2 text-xs font-semibold text-neutral-950 disabled:opacity-50">Perguntar</button>
      </form>
    </div>}
  </div>;
}
