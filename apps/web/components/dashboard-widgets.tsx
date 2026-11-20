'use client';

import Link from './nav-link';
import { useState } from 'react';
import { api, errorMessage, formatMoney } from '../lib/api';
import { askGuide } from '../lib/guide';

// Premium dashboard widgets (reference layout). They render only the values received or answers from the real /intelligence API.

export function RobotMascot({ className = '' }: { className?: string }) {
  return <svg viewBox="0 0 80 80" role="img" aria-label="Assistente RM" className={className}>
    <rect x="16" y="22" width="48" height="40" rx="14" fill="rgb(var(--sb))" stroke="rgb(var(--b-400))" strokeWidth="2.5" />
    <rect x="23" y="30" width="34" height="22" rx="9" fill="#0b0a08" />
    <circle cx="33" cy="41" r="4" fill="rgb(var(--b-400))" /><circle cx="47" cy="41" r="4" fill="rgb(var(--b-400))" />
    <path d="M34 48q6 4 12 0" stroke="rgb(var(--b-300))" strokeWidth="2" fill="none" strokeLinecap="round" />
    <line x1="40" y1="22" x2="40" y2="12" stroke="rgb(var(--b-400))" strokeWidth="2.5" /><circle cx="40" cy="10" r="3.5" fill="rgb(var(--b-300))" />
    <rect x="9" y="34" width="6" height="14" rx="3" fill="rgb(var(--b-500))" /><rect x="65" y="34" width="6" height="14" rx="3" fill="rgb(var(--b-500))" />
  </svg>;
}

export function GoalRing({ goal }: { goal: { goal: number; monthToDate: number; missing: number; remainingDays: number; perDay: number; reached: boolean } | null }) {
  const percent = goal ? Math.min(100, Math.round((goal.monthToDate / goal.goal) * 100)) : 0;
  const radius = 46; const circumference = 2 * Math.PI * radius;
  return <div className="flex flex-col items-center gap-3 text-center sm:flex-row sm:text-left xl:flex-col xl:text-center">
    <svg viewBox="0 0 120 120" role="img" aria-label={goal ? `Meta do mês: ${percent}% atingida` : 'Meta do mês não definida'} className="h-32 w-32 shrink-0 -rotate-90">
      <circle cx="60" cy="60" r={radius} fill="none" stroke="rgb(var(--s-200))" strokeWidth="11" />
      {goal && <circle cx="60" cy="60" r={radius} fill="none" stroke="rgb(var(--b-500))" strokeWidth="11" strokeLinecap="round" strokeDasharray={`${(percent / 100) * circumference} ${circumference}`} />}
      <text x="60" y="66" textAnchor="middle" transform="rotate(90 60 60)" className="fill-slate-900" fontSize="22" fontWeight="700">{goal ? `${percent}%` : '—'}</text>
    </svg>
    {goal
      ? <div className="min-w-0 text-sm"><p className="text-slate-600">Realizado <strong className="text-slate-900">{formatMoney(goal.monthToDate)}</strong></p><p className="text-slate-600">Meta <strong className="text-slate-900">{formatMoney(goal.goal)}</strong></p>
        <p className="mt-1 text-xs text-slate-500">{goal.reached ? 'Meta alcançada! 🎉' : `Faltam ${formatMoney(goal.missing)} · ${formatMoney(goal.perDay)}/dia em ${goal.remainingDays} dia(s)`}</p></div>
      : <p className="text-sm text-slate-600">Nenhuma meta mensal cadastrada. <Link href="/intelligence?tab=business" className="font-semibold text-brand-700 hover:text-brand-600">Definir meta ›</Link></p>}
  </div>;
}

export function BarList({ rows }: { rows: { label: string; value: number; tone?: 'primary' | 'warn' | 'good' }[] }) {
  const peak = Math.max(1, ...rows.map(row => Math.abs(row.value)));
  const color = { primary: 'bg-brand-500', warn: 'bg-red-500', good: 'bg-emerald-500' };
  return <ul className="space-y-3">{rows.map(row => <li key={row.label}>
    <div className="mb-1 flex justify-between gap-2 text-xs"><span className="text-slate-600">{row.label}</span><strong className="text-slate-900">{formatMoney(row.value)}</strong></div>
    <div className="h-2.5 rounded-full bg-slate-200"><div className={`h-full rounded-full ${color[row.tone ?? 'primary']}`} style={{ width: `${Math.max(2, (Math.abs(row.value) / peak) * 100)}%` }} /></div>
  </li>)}</ul>;
}

const quickQuestions = ['Quanto vendi hoje?', 'Qual produto vende mais?', 'Quais produtos preciso comprar?', 'Qual a previsão de faturamento do mês?'];

// Asks the real RM Assistente endpoint (answers come from the restaurant's own registered data).
export function AssistantPanel({ allowed }: { allowed: boolean }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ text: string; limitations: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function ask(text: string) {
    if (text.trim().length < 3) return;
    setBusy(true); setError(''); setAnswer(null);
    try {
      // How-to questions are taught by the guide (any plan, any profile); data questions need the Intelligence module.
      const guide = await askGuide(text, '/dashboard');
      if (guide) { setAnswer({ text: guide.answer, limitations: [guide.notice] }); return; }
      if (!allowed) { setError('Perguntas sobre os dados do negócio exigem o módulo RM Inteligência, que não está incluído no plano. Perguntas de "como fazer" continuam disponíveis.'); return; }
      const result = await api<{ answer: string; limitations: string[] }>('/intelligence/ask', { method: 'POST', body: JSON.stringify({ question: text }) }); setAnswer({ text: result.answer, limitations: result.limitations });
    }
    catch (cause) { setError(errorMessage(cause, 'Não foi possível consultar o assistente.')); } finally { setBusy(false); }
  }
  return <div className="flex h-full flex-col">
    <div className="flex items-center gap-3"><RobotMascot className="h-16 w-16 shrink-0" />
      <div><h3 className="text-sm font-bold text-slate-900">RM Assistente</h3><p className="text-xs text-slate-600">Pergunte sobre vendas, lucro, estoque e metas — ou como usar o sistema.</p></div></div>
    <>
      <div className="mt-3 flex flex-wrap gap-1.5">{quickQuestions.map(item => <button key={item} type="button" disabled={busy} onClick={() => { setQuestion(item); void ask(item); }} className="rounded-full border border-brand-500/40 bg-brand-50 px-2.5 py-1 text-[11px] font-medium text-brand-700 transition hover:border-brand-500 disabled:opacity-50">{item}</button>)}</div>
      <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); void ask(question); }}>
        <input value={question} onChange={event => setQuestion(event.target.value)} maxLength={300} placeholder="Pergunte algo…" aria-label="Pergunta ao RM Assistente" className="min-w-0 flex-1 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-500" />
        <button type="submit" disabled={busy || question.trim().length < 3} className="rounded-xl bg-brand-500 px-3 py-2 text-sm font-semibold text-neutral-950 disabled:opacity-50">{busy ? '…' : 'Enviar'}</button>
      </form>
      {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
      {answer && <div aria-live="polite" className="mt-3 rounded-xl border border-brand-500/30 bg-slate-50 p-3 text-sm text-slate-800"><p className="whitespace-pre-line">{answer.text}</p>{answer.limitations.map(item => <p key={item} className="mt-1 text-[11px] text-slate-500">ℹ️ {item}</p>)}</div>}
      <Link href="/intelligence?tab=assistant" className="mt-auto pt-3 text-xs font-semibold text-brand-700 hover:text-brand-600">Abrir conversa completa ›</Link>
    </>
  </div>;
}
