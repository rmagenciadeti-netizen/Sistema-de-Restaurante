'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, clearSessionCookie, errorMessage, isAdminApp, tokenStorageKey, userStorageKey } from '../../lib/api';
import { buttonClass, Field, Notice } from '../../components/app-shell';

export default function ChangePasswordPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    if (newPassword !== confirmPassword) { setMessage('As senhas novas não coincidem.'); return; }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) });
      clearSessionCookie();
      localStorage.removeItem(tokenStorageKey);
      localStorage.removeItem(userStorageKey);
      router.replace('/login');
    } catch (error) { setMessage(errorMessage(error, 'Não foi possível alterar a senha.')); }
    finally { setBusy(false); }
  }

  return <main className="grid min-h-screen bg-[var(--rm-workspace)] lg:grid-cols-2">
    <section className="relative flex min-h-56 flex-col justify-center overflow-hidden bg-neutral-950 px-8 py-8 text-white sm:px-12 lg:min-h-screen lg:px-16">
      <div aria-hidden="true" className="pointer-events-none absolute -right-36 top-1/4 h-96 w-96 rounded-full border border-brand-400/20 shadow-[0_0_100px_rgba(184,146,53,0.12)]" />
      <p className="text-sm font-semibold uppercase tracking-[0.25em]"><span className="text-brand-300">RM</span> {isAdminApp ? 'Painel Admin' : 'Restaurant'}</p>
      <div className="mt-8 h-1 w-16 rounded-full bg-brand-400" />
      <h1 className="mt-5 max-w-lg text-3xl font-semibold leading-tight sm:text-4xl">Proteja sua conta.</h1>
      <p className="mt-4 max-w-md text-sm leading-6 text-neutral-300">Por segurança, defina uma senha pessoal antes de continuar.</p>
    </section>
    <section className="flex items-center justify-center px-5 py-10 sm:px-12 lg:px-14">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-black/[0.06] sm:p-9">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">Primeiro acesso</p>
        <h2 className="mt-3 text-3xl font-bold text-slate-900">Alterar senha</h2>
        <p className="mb-8 mt-2 text-sm text-slate-600">A nova senha precisa ter ao menos 12 caracteres.</p>
        {message && <Notice message={message} />}
        <form onSubmit={submit} className="space-y-5">
          <Field label="Senha atual" type="password" autoComplete="current-password" required maxLength={200} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
          <Field label="Nova senha" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={newPassword} onChange={event => setNewPassword(event.target.value)} />
          <Field label="Confirme a nova senha" type="password" autoComplete="new-password" required minLength={12} maxLength={72} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} />
          <button type="submit" className={`${buttonClass} w-full`} disabled={busy}>{busy ? 'Salvando...' : 'Salvar nova senha'}</button>
        </form>
      </div>
    </section>
  </main>;
}
