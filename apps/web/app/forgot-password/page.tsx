'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError, publicApi } from '../../lib/api';
import { buttonClass, Field, Notice } from '../../components/app-shell';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);
    try {
      const result = await publicApi<{ message: string }>('/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim() }),
      });
      setMessage(result.message);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível solicitar a recuperação.');
    } finally {
      setLoading(false);
    }
  }

  return <main className="flex min-h-screen items-center justify-center bg-[var(--rm-workspace)] px-5 py-12">
    <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-black/[0.06] sm:p-9">
      <div className="mb-7 grid h-11 w-11 place-items-center rounded-xl border border-brand-400/40 bg-brand-50 font-serif text-lg font-bold text-brand-700">RM</div>
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Recuperação segura</p>
      <h1 className="mt-3 text-3xl font-bold text-slate-900">Esqueceu a senha?</h1>
      <p className="mb-7 mt-2 text-sm leading-6 text-slate-600">Informe o e-mail cadastrado. Se a conta estiver ativa, enviaremos um link válido por 30 minutos.</p>
      {error && <Notice message={error} />}
      {message ? <Notice message={message} kind="success" /> : <form onSubmit={submit} className="space-y-5">
        <Field label="E-mail cadastrado" type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => setEmail(event.target.value)} />
        <button type="submit" className={`${buttonClass} w-full`} disabled={loading}>{loading ? 'Enviando...' : 'Enviar link de recuperação'}</button>
      </form>}
      <Link href="/login" className="mt-6 block text-center text-sm text-brand-700 underline">Voltar ao login</Link>
    </section>
  </main>;
}
