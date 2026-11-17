'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ApiError, publicApi } from '../../lib/api';
import { buttonClass, Field, Notice } from '../../components/app-shell';

function ResetPasswordForm() {
  const search = useSearchParams();
  const token = search.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setMessage('');
    if (password !== confirmation) {
      setError('As senhas não coincidem.');
      return;
    }
    setLoading(true);
    try {
      await publicApi('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, newPassword: password }) });
      setMessage('Senha redefinida. Entre novamente com a nova senha.');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Não foi possível redefinir a senha.');
    } finally {
      setLoading(false);
    }
  }

  return <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-black/[0.06] sm:p-9">
    <div className="mb-7 grid h-11 w-11 place-items-center rounded-xl border border-brand-400/40 bg-brand-50 font-serif text-lg font-bold text-brand-700">RM</div>
    <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Recuperação segura</p>
    <h1 className="mt-3 text-3xl font-bold text-slate-900">Criar nova senha</h1>
    <p className="mb-7 mt-2 text-sm leading-6 text-slate-600">Use de 12 a 72 bytes e pelo menos três tipos de caracteres. O link expira após 30 minutos e só pode ser usado uma vez.</p>
    {error && <Notice message={error} />}
    {message ? <Notice message={message} kind="success" /> : <form onSubmit={submit} className="space-y-5">
      {!token && <Notice message="Link inválido ou ausente. Solicite uma nova recuperação." />}
      <Field label="Nova senha" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={password} onChange={event => setPassword(event.target.value)} />
      <Field label="Confirmar nova senha" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
      <button type="submit" className={`${buttonClass} w-full`} disabled={loading || !token}>{loading ? 'Salvando...' : 'Redefinir senha'}</button>
    </form>}
    <Link href="/login" className="mt-6 block text-center text-sm text-brand-700 underline">Voltar ao login</Link>
  </section>;
}

export default function ResetPasswordPage() {
  return <main className="flex min-h-screen items-center justify-center bg-[var(--rm-workspace)] px-5 py-12">
    <Suspense fallback={<p className="text-sm text-slate-600">Carregando...</p>}><ResetPasswordForm /></Suspense>
  </main>;
}
