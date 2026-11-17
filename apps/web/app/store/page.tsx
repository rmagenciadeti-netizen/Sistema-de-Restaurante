'use client';

import Link from 'next/link';
import { useState } from 'react';
import QRCode from 'qrcode';
import { api, errorMessage, storedUser } from '../../lib/api';
import { MANAGEMENT_ROLES } from '../../lib/settings-helpers';
import type { SettingsResponse, TenantSettings } from '../../lib/settings';
import { isStoreOpen } from '../../lib/settings';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Notice, panelClass, secondaryButtonClass } from '../../components/app-shell';
import { Badge, PageHeader } from '../../components/ui';

type Me = { user: { tenant?: { name?: string; slug?: string } | null } };
type Flash = { text: string; kind: 'error' | 'success' };

const modeText = { OPEN: 'Sempre aberta', CLOSED: 'Fechada manualmente', SCHEDULE: 'Seguindo o horário de funcionamento' } as const;

export default function StorePage() {
  const [slug, setSlug] = useState(''); const [name, setName] = useState(''); const [origin, setOrigin] = useState('');
  const [settings, setSettings] = useState<TenantSettings | null>(null); const [role, setRole] = useState<string | undefined>();
  const [qr, setQr] = useState(''); const [flash, setFlash] = useState<Flash | null>(null); const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [me, current] = await Promise.all([api<Me>('/auth/me'), api<SettingsResponse>('/settings')]);
      const tenantSlug = me.user.tenant?.slug ?? '';
      const base = window.location.origin;
      setSlug(tenantSlug); setName(me.user.tenant?.name ?? ''); setOrigin(base); setSettings(current.settings); setRole(storedUser().role);
      if (tenantSlug) setQr(await QRCode.toDataURL(`${base}/loja/${tenantSlug}`, { width: 360, margin: 2, errorCorrectionLevel: 'M' }));
    } catch (e) { setFlash({ text: errorMessage(e, 'Erro ao carregar os dados da loja'), kind: 'error' }); }
  }
  useAutoLoad(load);

  const url = slug ? `${origin}/loja/${slug}` : '';
  const canEdit = MANAGEMENT_ROLES.includes(role ?? '');
  const open = settings ? isStoreOpen(settings.hours) : null;

  async function copy() {
    try { await navigator.clipboard.writeText(url); setFlash({ text: 'Link copiado.', kind: 'success' }); } catch { setFlash({ text: 'Não foi possível copiar automaticamente. Selecione o link e copie manualmente.', kind: 'error' }); }
  }

  async function setMode(mode: TenantSettings['hours']['mode']) {
    if (!settings) return;
    setBusy(true); setFlash(null);
    try {
      const result = await api<{ section: string; value: TenantSettings['hours'] }>('/settings/hours', { method: 'PUT', body: JSON.stringify({ ...settings.hours, mode }) });
      setSettings({ ...settings, hours: result.value });
      setFlash({ text: mode === 'CLOSED' ? 'Loja fechada para novos pedidos imediatos.' : mode === 'OPEN' ? 'Loja aberta.' : 'A loja agora segue o horário de funcionamento.', kind: 'success' });
    } catch (e) { setFlash({ text: errorMessage(e, 'Erro ao alterar o status da loja'), kind: 'error' }); } finally { setBusy(false); }
  }

  const hours = settings?.hours;
  return <AppShell title="Link da loja virtual">
    <PageHeader title="Link da loja virtual" subtitle="Compartilhe o endereço abaixo (ou o QR Code) para que seus clientes façam pedidos de retirada e entrega sem instalar nada." />
    {flash && <Notice message={flash.text} kind={flash.kind} />}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        <section className={panelClass} aria-label="Endereço da loja">
          <h2 className="text-base font-bold text-slate-900">Endereço da loja{name ? ` · ${name}` : ''}</h2>
          {slug ? <>
            <label className="mt-3 block text-sm font-medium text-slate-700">Link público
              <input readOnly value={url} onFocus={event => event.currentTarget.select()} className="mt-1 w-full rounded-xl border border-slate-300 bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-900 outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15" />
            </label>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={() => void copy()}>📋 Copiar link</button>
              <a className={secondaryButtonClass} href={url} target="_blank" rel="noreferrer">↗ Abrir loja</a>
            </div>
          </> : <p className="mt-3 text-sm text-slate-500">Carregando o endereço da loja…</p>}
        </section>

        <section className={panelClass} aria-label="Status da loja">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">Status da loja</h2>
              <p className="mt-1 text-sm text-slate-500">{hours ? modeText[hours.mode] : 'Carregando…'}. Com a loja fechada, só é possível agendar pedidos{settings?.store.allowBuyWhenClosed ? ' — e você permitiu comprar mesmo fechado' : ''}.</p>
            </div>
            {open !== null && <Badge tone={open ? 'green' : 'red'}>{open ? '● Aberta agora' : '● Fechada agora'}</Badge>}
          </div>
          {hours && <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={!canEdit || busy || hours.mode === 'OPEN'} onClick={() => void setMode('OPEN')}>Abrir loja</button>
            <button type="button" className={secondaryButtonClass} disabled={!canEdit || busy || hours.mode === 'CLOSED'} onClick={() => void setMode('CLOSED')}>Fechar loja</button>
            <button type="button" className={secondaryButtonClass} disabled={!canEdit || busy || hours.mode === 'SCHEDULE'} onClick={() => void setMode('SCHEDULE')}>Seguir horário de funcionamento</button>
          </div>}
          {settings && !canEdit && <p className="mt-3 text-xs text-slate-500">Somente administradores e gerentes podem abrir ou fechar a loja.</p>}
        </section>

        {settings && <section className={panelClass} aria-label="Resumo das configurações">
          <h2 className="text-base font-bold text-slate-900">Como a loja está configurada</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-500">Retirada</dt><dd className="font-medium">{settings.fulfillment.allowPickup ? 'Habilitada' : 'Desabilitada'}</dd></div>
            <div><dt className="text-slate-500">Entrega</dt><dd className="font-medium">{settings.fulfillment.allowDelivery ? 'Habilitada' : 'Desabilitada'}</dd></div>
            <div><dt className="text-slate-500">Agendamento de pedidos</dt><dd className="font-medium">{settings.scheduling.enabled ? `Até ${settings.scheduling.maxDaysAhead} dia(s) à frente` : 'Desabilitado'}</dd></div>
            <div><dt className="text-slate-500">Aceite dos pedidos</dt><dd className="font-medium">{settings.store.autoAccept ? 'Automático' : 'Manual'}</dd></div>
            <div><dt className="text-slate-500">Cor da loja</dt><dd className="flex items-center gap-2 font-medium"><span aria-hidden="true" className="h-4 w-4 rounded-full border border-slate-300" style={{ background: settings.store.brandColor }} />{settings.store.brandColor}</dd></div>
          </dl>
          <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">Os pedidos chegam como “Aberto” em Pedidos. O pagamento escolhido pelo cliente é apenas informativo: ele só é registrado quando você receber no caixa ou na entrega.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href="/settings" className={secondaryButtonClass}>⚙ Configurar loja e entrega</Link>
            <Link href="/schedule-settings" className={secondaryButtonClass}>⏰ Agendamento de pedidos</Link>
          </div>
        </section>}
      </div>

      <aside className={`${panelClass} h-fit text-center`} aria-label="QR Code da loja">
        <h2 className="text-base font-bold text-slate-900">QR Code</h2>
        {qr ? <>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated locally */}
          <img src={qr} alt={`QR Code para ${url}`} className="mx-auto mt-3 w-full max-w-[260px] rounded-xl border border-slate-200 bg-white p-2" />
          <a href={qr} download={`qrcode-loja-${slug}.png`} className={`${secondaryButtonClass} mt-3 inline-block`}>⬇ Baixar PNG</a>
          <p className="mt-3 text-xs text-slate-500">Imprima e deixe no balcão, na embalagem ou nas redes sociais.</p>
        </> : <p className="mt-3 text-sm text-slate-500">Gerando QR Code…</p>}
      </aside>
    </div>
  </AppShell>;
}
