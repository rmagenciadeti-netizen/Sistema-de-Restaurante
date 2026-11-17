'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, isAdminApp, publicApi, tokenStorageKey, userStorageKey } from '../../lib/api';
import { buttonClass, Field, Notice } from '../../components/app-shell';

type LoginUser = { id: string; name: string; email: string; role: string; tenantId: string | null; unitId: string | null; mustChangePassword: boolean };
type LoginResponse = {
  accessToken?: string;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  mfaChallenge?: string;
  mfaSetupToken?: string;
  mustChangePassword: boolean;
  user: LoginUser;
};

export default function LoginPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<'login' | 'verify' | 'setup' | 'recovery'>('login');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [scopedToken, setScopedToken] = useState('');
  const [secret, setSecret] = useState('');
  const [otpauthUri, setOtpauthUri] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [pendingToken, setPendingToken] = useState('');
  const [pendingUser, setPendingUser] = useState<LoginUser | null>(null);
  const [pendingPasswordChange, setPendingPasswordChange] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  function finishLogin(accessToken: string, user: LoginUser, mustChangePassword: boolean) {
    localStorage.setItem(userStorageKey, JSON.stringify(user));
    localStorage.setItem(tokenStorageKey, accessToken);
    router.replace(mustChangePassword ? '/change-password' : '/dashboard');
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setLoading(true);
    try {
      const result = await publicApi<LoginResponse>(isAdminApp ? '/auth/master-login' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier: identifier.trim(), password }),
      });
      if (isAdminApp && result.user.role !== 'MASTER_ADMIN') throw new ApiError('Acesso exclusivo do administrador da plataforma.', 401);
      if (result.mfaSetupRequired && result.mfaSetupToken) {
        setScopedToken(result.mfaSetupToken);
        setPendingUser(result.user);
        setPendingPasswordChange(result.mustChangePassword);
        const setup = await publicApi<{ secret: string; otpauthUri: string }>('/auth/master/mfa/setup', {
          method: 'POST',
          headers: { Authorization: `Bearer ${result.mfaSetupToken}` },
        });
        setSecret(setup.secret);
        setOtpauthUri(setup.otpauthUri);
        setPhase('setup');
      } else if (result.mfaRequired && result.mfaChallenge) {
        setScopedToken(result.mfaChallenge);
        setPendingUser(result.user);
        setPendingPasswordChange(result.mustChangePassword);
        setPhase('verify');
      } else if (result.accessToken) {
        finishLogin(result.accessToken, result.user, result.mustChangePassword);
      } else {
        throw new ApiError('Resposta de autenticação inválida.', 500);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setMessage('E-mail ou senha incorretos.');
      else if (error instanceof ApiError && error.status === 403) setMessage(isAdminApp ? 'Acesso negado ao Painel Admin. Verifique a autenticação da conta Master.' : 'Empresa indisponível. Entre em contato com o administrador.');
      else if (error instanceof ApiError && error.status === 429) setMessage('Muitas tentativas. Tente novamente mais tarde.');
      else setMessage(error instanceof Error ? error.message : 'Não foi possível entrar. Verifique a conexão e tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage('');
    setLoading(true);
    try {
      if (phase === 'verify') {
        const result = await publicApi<{ accessToken: string; mustChangePassword: boolean; user: LoginUser }>('/auth/master/mfa/verify', {
          method: 'POST',
          headers: { Authorization: `Bearer ${scopedToken}` },
          body: JSON.stringify({ code }),
        });
        if (!pendingUser) throw new ApiError('Sessão de autenticação inválida.', 401);
        finishLogin(result.accessToken, pendingUser, result.mustChangePassword);
      } else if (phase === 'setup') {
        const result = await publicApi<{ accessToken: string; mustChangePassword: boolean; user: LoginUser; recoveryCodes: string[] }>('/auth/master/mfa/confirm', {
          method: 'POST',
          headers: { Authorization: `Bearer ${scopedToken}` },
          body: JSON.stringify({ code }),
        });
        if (!pendingUser) throw new ApiError('Sessão de autenticação inválida.', 401);
        setRecoveryCodes(result.recoveryCodes);
        setPendingToken(result.accessToken);
        setPendingPasswordChange(result.mustChangePassword);
        setPhase('recovery');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível verificar o código.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen bg-[var(--rm-workspace)] lg:grid-cols-2">
      <section className="relative flex min-h-56 flex-col justify-between overflow-hidden bg-neutral-950 px-8 py-8 text-white sm:px-12 lg:min-h-screen lg:px-16 lg:py-14">
        <div aria-hidden="true" className="pointer-events-none absolute -right-36 top-1/4 h-96 w-96 rounded-full border border-brand-400/20 shadow-[0_0_100px_rgba(184,146,53,0.12)]" />
        <p className="text-sm font-semibold uppercase tracking-[0.25em]"><span className="text-brand-300">RM</span> {isAdminApp ? 'Painel Admin' : 'Restaurant'}</p>
        <div className="my-10 max-w-lg">
          <div className="mb-5 h-1 w-16 rounded-full bg-brand-400" />
          <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">{isAdminApp ? <>Controle da plataforma.<br />Clientes conectados.</> : <>Gestão completa.<br />Operação conectada.</>}</h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-neutral-300">{isAdminApp ? 'Área exclusiva dos administradores autorizados do RM Restaurant SaaS.' : 'Acesse o ambiente de gestão do seu restaurante com segurança.'}</p>
        </div>
        <p className="text-xs tracking-wide text-neutral-500">RM Agência de TI · Restaurant SaaS</p>
      </section>
      <section className="flex items-center justify-center px-5 py-10 sm:px-12 lg:px-14">
        <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-black/[0.06] sm:p-9">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-700">{isAdminApp ? 'Acesso administrativo exclusivo' : 'Acesso à plataforma'}</p>
          <h2 className="mt-3 text-3xl font-bold text-slate-900">{isAdminApp ? 'RM Painel Admin' : 'Bem-vindo'}</h2>
          <p className="mb-8 mt-2 text-sm text-slate-600">
            {phase === 'login' ? 'Entre com seu e-mail ou nome de usuário.' : phase === 'setup' ? 'Configure um aplicativo autenticador para proteger a conta Master.' : phase === 'recovery' ? 'Guarde estes códigos. Cada código pode ser usado uma única vez.' : 'Digite o código do aplicativo autenticador ou um código de recuperação.'}
          </p>
          {message && <Notice message={message} />}
          {phase === 'login' && <form onSubmit={submit} className="space-y-5">
              <Field label="E-mail ou nome de usuário" type="text" autoComplete="username" required value={identifier} onChange={event => setIdentifier(event.target.value)} />
              <Field label="Senha" type="password" autoComplete="current-password" required maxLength={200} value={password} onChange={event => setPassword(event.target.value)} />
              <button type="submit" className={`${buttonClass} w-full`} disabled={loading}>{loading ? 'Entrando...' : 'Entrar'}</button>
              <a className="block text-center text-sm text-brand-700 underline" href="/forgot-password">Esqueci minha senha</a>
            </form>}
          {phase === 'setup' && <div className="space-y-5">
              <p className="text-sm font-medium text-slate-800">Adicione esta conta no seu aplicativo autenticador usando a chave:</p>
              <code className="block break-all rounded-lg bg-slate-100 p-4 text-sm font-semibold tracking-wider text-slate-900">{secret}</code>
              <a className="block break-all text-xs text-brand-700 underline" href={otpauthUri}>Abrir no aplicativo autenticador compatível</a>
              <form onSubmit={submitCode} className="space-y-4">
                <Field label="Código de 6 dígitos" type="text" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value)} />
                <button type="submit" className={`${buttonClass} w-full`} disabled={loading}>{loading ? 'Verificando...' : 'Ativar autenticação'}</button>
              </form>
            </div>}
          {phase === 'verify' && <form onSubmit={submitCode} className="space-y-5">
              <Field label="Código autenticador ou de recuperação" type="text" autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value)} />
              <button type="submit" className={`${buttonClass} w-full`} disabled={loading}>{loading ? 'Verificando...' : 'Verificar e entrar'}</button>
            </form>}
          {phase === 'recovery' && <div className="space-y-5">
              <ul className="grid grid-cols-2 gap-2 rounded-lg bg-slate-100 p-4 font-mono text-sm text-slate-900">
                {recoveryCodes.map(recoveryCode => <li key={recoveryCode}>{recoveryCode}</li>)}
              </ul>
              <p className="text-xs text-slate-600">Os códigos não serão exibidos novamente. Armazene-os em um local seguro.</p>
              <button type="button" className={`${buttonClass} w-full`} onClick={() => pendingUser && finishLogin(pendingToken, pendingUser, pendingPasswordChange)}>Salvei os códigos e continuar</button>
            </div>}
        </div>
      </section>
    </main>
  );
}
