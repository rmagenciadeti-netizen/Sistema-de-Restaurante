'use client';

import { useState } from 'react';
import { errorMessage, publicApi } from '../../lib/api';

const inputClass = 'mt-1 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-2.5 text-white outline-none placeholder:text-neutral-500 focus:border-brand-500';

// Public page: a restaurant asks for a demonstration or onboarding. No login required; the API validates, rate-limits and de-duplicates.
export default function DemoPage() {
  const [form, setForm] = useState({ name: '', company: '', email: '', phone: '', city: '', interest: '', message: '', kind: 'DEMO', website: '' });
  const [state, setState] = useState<{ kind: 'idle' | 'sent' | 'error'; text?: string }>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setState({ kind: 'idle' });
    const body = Object.fromEntries(Object.entries(form).filter(([, value]) => value !== ''));
    try { await publicApi('/public/leads', { method: 'POST', body: JSON.stringify(body) }); setState({ kind: 'sent' }); } catch (cause) { setState({ kind: 'error', text: errorMessage(cause, 'Não foi possível enviar. Tente novamente.') }); } finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-neutral-950 px-4 py-10 text-white">
    <div className="mx-auto max-w-xl">
      <p className="text-center text-xs uppercase tracking-[0.3em] text-brand-300">RM Agência de TI</p>
      <h1 className="mt-2 text-center font-serif text-3xl font-bold text-brand-300">RM Restaurant</h1>
      <p className="mt-2 text-center text-sm text-neutral-300">Muito mais que um sistema de restaurante. A inteligência por trás do seu negócio.</p>
      {state.kind === 'sent' ? <div role="status" className="mt-8 rounded-2xl border border-brand-500/40 bg-neutral-900 p-6 text-center"><p className="text-lg font-semibold text-brand-300">Solicitação recebida!</p><p className="mt-2 text-sm text-neutral-300">Nossa equipe entrará em contato em breve.</p></div>
        : <form onSubmit={submit} className="mt-8 space-y-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm">Seu nome<input required minLength={2} maxLength={120} className={inputClass} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
            <label className="block text-sm">Restaurante<input required minLength={2} maxLength={160} className={inputClass} value={form.company} onChange={event => setForm({ ...form, company: event.target.value })} /></label>
            <label className="block text-sm">E-mail<input required type="email" maxLength={160} className={inputClass} value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></label>
            <label className="block text-sm">WhatsApp / telefone<input required minLength={8} maxLength={30} className={inputClass} value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} /></label>
            <label className="block text-sm">Cidade<input maxLength={80} className={inputClass} value={form.city} onChange={event => setForm({ ...form, city: event.target.value })} /></label>
            <label className="block text-sm">Preciso de<select className={inputClass} value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value })}><option value="DEMO">Demonstração do sistema</option><option value="ONBOARDING">Contratar / implantar</option><option value="CONTACT">Falar com a equipe</option></select></label>
          </div>
          <label className="block text-sm">Interesse (plano ou módulo)<input maxLength={60} className={inputClass} placeholder="Ex.: RM PRO, Delivery…" value={form.interest} onChange={event => setForm({ ...form, interest: event.target.value })} /></label>
          <label className="block text-sm">Mensagem<textarea maxLength={1000} rows={3} className={inputClass} value={form.message} onChange={event => setForm({ ...form, message: event.target.value })} /></label>
          <div aria-hidden="true" className="absolute -left-[9999px]"><label>Não preencha<input tabIndex={-1} autoComplete="off" value={form.website} onChange={event => setForm({ ...form, website: event.target.value })} /></label></div>
          {state.kind === 'error' && <p role="alert" className="text-sm text-red-400">{state.text}</p>}
          <button disabled={busy} className="w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-neutral-950 hover:bg-brand-400 disabled:opacity-50">{busy ? 'Enviando…' : 'Solicitar contato'}</button>
          <p className="text-center text-xs text-neutral-500">Usamos seus dados apenas para retornar este contato.</p>
        </form>}
    </div>
  </main>;
}
