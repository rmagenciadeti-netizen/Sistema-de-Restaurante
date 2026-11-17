'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { releaseActionLabels, type ReleaseAction, type ReleaseResult } from '../lib/types-settings';
import { buttonClass, inputClass, secondaryButtonClass } from './app-shell';
import { textareaClass } from './ui';

type Props = { open: boolean; action: ReleaseAction; orderId?: string; defaultReason?: string; fixedReason?: boolean; onAuthorized: (releaseId: string) => void; onCancel: () => void };

export function releaseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return 'Senha incorreta. Confira e tente novamente.';
    if (error.status === 409) return 'Esta empresa ainda não tem senha de administrador. Defina uma em Configurações da empresa › PDV.';
    if (error.status === 429) return 'Muitas tentativas incorretas. Aguarde alguns minutos antes de tentar de novo.';
  }
  return error instanceof Error ? error.message : 'Não foi possível validar a senha.';
}

const focusable = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]';

export function PasswordReleaseDialog({ open, action, orderId, defaultReason, fixedReason = false, onAuthorized, onCancel }: Props) {
  const titleId = useId(); const errorId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState(''); const [reason, setReason] = useState(defaultReason ?? '');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement as HTMLElement | null;
    passwordRef.current?.focus();
    return () => { previous?.focus?.(); };
  }, [open]);

  if (!open) return null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true); setError('');
    try {
      const result = await api<ReleaseResult>('/releases', { method: 'POST', body: JSON.stringify({ action, password, reason: reason.trim() || undefined, orderId }) });
      setPassword(''); setReason('');
      onAuthorized(result.id);
    } catch (e) {
      setError(releaseErrorMessage(e)); setPassword(''); passwordRef.current?.focus();
    } finally { setBusy(false); }
  }

  function cancel() { setPassword(''); setReason(''); setError(''); onCancel(); }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') { event.stopPropagation(); cancel(); return; }
    if (event.key !== 'Tab') return;
    const nodes = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(focusable) ?? []);
    if (nodes.length === 0) return;
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onMouseDown={event => { if (event.target === event.currentTarget) cancel(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-5 shadow-2xl">
      <form onSubmit={submit}>
        <h2 id={titleId} className="text-lg font-bold text-slate-900">Liberação por senha</h2>
        <p className="mt-1 text-sm text-slate-600">Ação: <strong>{releaseActionLabels[action]}</strong>. Peça a senha de administrador para continuar.</p>
        <label className="mt-4 block text-sm font-medium text-slate-700">Senha de administrador
          <input ref={passwordRef} type="password" autoComplete="off" value={password} onChange={event => setPassword(event.target.value)} maxLength={60} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : undefined} className={inputClass} />
        </label>
        <label className="mt-3 block text-sm font-medium text-slate-700">Motivo (opcional)
          <textarea value={reason} onChange={event => setReason(event.target.value)} readOnly={fixedReason} maxLength={300} rows={2} className={textareaClass} />
        </label>
        {error && <p id={errorId} role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}{' '}{error.includes('Configurações') && <Link href="/settings" className="font-semibold underline">Abrir configurações</Link>}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={cancel} className={secondaryButtonClass}>Cancelar</button>
          <button type="submit" disabled={busy || !password} className={buttonClass}>{busy ? 'Validando…' : 'Liberar'}</button>
        </div>
      </form>
    </div>
  </div>;
}
