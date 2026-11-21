'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, formatDateTime } from '../../lib/api';
import type { WhatsappSession, WhatsappSessionStatus } from '../../lib/types-whatsapp';
import { Notice, buttonClass, panelClass, secondaryButtonClass } from '../app-shell';
import { Badge, dangerButtonClass } from '../ui';
import { Flash, displayPhone, friendlyError } from './common';

const statusInfo: Record<WhatsappSessionStatus, { label: string; tone: 'neutral' | 'gold' | 'green' | 'red' | 'blue' | 'amber' }> = {
  DISCONNECTED: { label: 'Desconectado', tone: 'neutral' },
  CONNECTING: { label: 'Conectando…', tone: 'blue' },
  QR_READY: { label: 'Aguardando leitura do QR Code', tone: 'amber' },
  CONNECTED: { label: 'Conectado', tone: 'green' },
  LOGGED_OUT: { label: 'Sessão encerrada', tone: 'neutral' },
  ERROR: { label: 'Erro na conexão', tone: 'red' },
};

export function ConnectionTab({ session, loadError, onSession }: { session: WhatsappSession | null; loadError: string | null; onSession: (session: WhatsappSession) => void }) {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const qr = session?.qr ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!qr) return undefined;
    QRCode.toDataURL(qr, { width: 320, margin: 2, errorCorrectionLevel: 'M' })
      .then(image => { if (!cancelled) setQrImage(image); })
      .catch(() => { if (!cancelled) setQrImage(null); });
    return () => { cancelled = true; };
  }, [qr]);

  async function run(path: string, body: unknown, success: string) {
    setBusy(true); setFlash(null);
    try {
      const result = await api<WhatsappSession | undefined>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (result && typeof result === 'object' && 'status' in result) onSession(result);
      setFlash({ text: success, kind: 'success' });
    } catch (e) { setFlash({ text: friendlyError(e, 'Não foi possível concluir a ação'), kind: 'error' }); } finally { setBusy(false); }
  }
  function logout() {
    if (window.confirm('Sair do WhatsApp? O aparelho será desconectado e será preciso ler um novo QR Code para voltar a conectar.')) void run('/whatsapp/session/disconnect', { logout: true }, 'Saindo do WhatsApp…');
  }

  const status = session?.status ?? 'DISCONNECTED';
  const info = statusInfo[status];
  const pending = status === 'CONNECTING' || status === 'QR_READY';
  const canConnect = status === 'DISCONNECTED' || status === 'LOGGED_OUT' || status === 'ERROR';
  const managerOffline = session !== null && !session.managerOnline;

  return <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <section className={panelClass}>
      <h2 className="text-lg font-semibold text-slate-900">Conexão do número</h2>
      {loadError && <p role="alert" className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{loadError}</p>}
      {flash && <div className="mt-3"><Notice message={flash.text} kind={flash.kind} /></div>}
      {managerOffline && <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"><strong>O serviço de sessões do WhatsApp está iniciando ou indisponível no servidor.</strong> Ele volta sozinho em instantes; se persistir, avise o suporte do RM. O QR Code aparece assim que o serviço responder.</p>}
      {!session && !loadError && <p className="mt-3 text-sm text-slate-500">Carregando…</p>}
      {session && <>
        <div className="mt-4 flex flex-wrap items-center gap-3"><Badge tone={info.tone}>{info.label}</Badge>{session.cloudConfigured && <Badge tone="gold">Cloud API configurada</Badge>}</div>
        {status === 'CONNECTED' && <dl className="mt-4 grid gap-2 text-sm text-slate-700">
          <div><dt className="inline font-semibold">Número: </dt><dd className="inline">{displayPhone(session.phone)}</dd></div>
          {session.pushName && <div><dt className="inline font-semibold">Nome no WhatsApp: </dt><dd className="inline">{session.pushName}</dd></div>}
          {session.connectedAt && <div><dt className="inline font-semibold">Conectado desde: </dt><dd className="inline">{formatDateTime(session.connectedAt)}</dd></div>}
        </dl>}
        {session.lastError && status !== 'CONNECTED' && <p className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">Último erro: {session.lastError}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          {canConnect && <button type="button" className={`${buttonClass} min-h-11`} disabled={busy} onClick={() => void run('/whatsapp/session/connect', undefined, 'Iniciando conexão…')}>Conectar</button>}
          {(pending || status === 'ERROR') && <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={busy} onClick={() => void run('/whatsapp/session/renew', undefined, 'Gerando um novo QR Code…')}>Renovar QR Code</button>}
          {pending && <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={busy} onClick={() => void run('/whatsapp/session/disconnect', { logout: false }, 'Conexão cancelada.')}>Cancelar</button>}
          {status === 'CONNECTED' && <button type="button" className={`${secondaryButtonClass} min-h-11`} disabled={busy} onClick={() => void run('/whatsapp/session/disconnect', { logout: false }, 'Desconectado. O login continua salvo.')}>Desconectar (mantém o login)</button>}
          {(status === 'CONNECTED' || status === 'ERROR') && <button type="button" className={`${dangerButtonClass} min-h-11`} disabled={busy} onClick={logout}>Sair do WhatsApp</button>}
        </div>
        {status === 'CONNECTED' && <p className="mt-3 text-xs text-slate-500">“Desconectar” pausa o robô, mas o número continua pareado e reconecta sem novo QR Code. “Sair do WhatsApp” remove o pareamento.</p>}
      </>}
      <p className="mt-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Conexão por QR Code usa o WhatsApp Web (não oficial). Use um número dedicado ao restaurante, evite mensagens em massa; o WhatsApp pode restringir números que violem seus termos. Para uso oficial, configure a Cloud API.</p>
    </section>

    <section className={panelClass} aria-live="polite">
      <h2 className="text-lg font-semibold text-slate-900">Conectar por QR Code</h2>
      {status === 'QR_READY' && qr ? <div className="mt-4 grid place-items-center">
        {qrImage ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated locally */}
          <img src={qrImage} alt="QR Code para conectar o WhatsApp" className="h-72 w-72 max-w-full rounded-2xl border border-slate-200 bg-white p-2 shadow-sm" />
        </> : <p className="text-sm text-slate-500">Gerando QR Code…</p>}
        <p className="mt-2 text-xs text-slate-500">O código é renovado automaticamente enquanto esta tela estiver aberta. Se não ler a tempo, use “Renovar QR Code”.</p>
      </div> : <p className="mt-4 rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-sm text-slate-500">
        {status === 'CONNECTED' ? 'WhatsApp conectado. Não é preciso ler um QR Code.' : status === 'CONNECTING' ? 'Preparando a conexão… o QR Code aparece aqui em instantes.' : 'Clique em “Conectar” para gerar um QR Code.'}
      </p>}
      <ol className="mt-5 list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>Abra esta tela: o QR Code aparece sozinho (ou clique em <strong>Conectar</strong>).</li>
        <li>No celular: <strong>WhatsApp › Aparelhos conectados › Conectar um aparelho</strong>.</li>
        <li>Escaneie o QR Code exibido nesta tela.</li>
        <li>Pronto: o status muda para “Conectado”.</li>
      </ol>
    </section>
  </div>;
}
