'use client';

import { useEffect, useRef, useState } from 'react';
import { api, errorMessage, storedUser } from '../lib/api';
import { MANAGEMENT_ROLES } from '../lib/settings-helpers';
import { applyTheme, DEFAULT_THEME, modeOptions, primaryOptions, refreshTheme, sidebarOptions, type AppearanceResponse, type ThemePreference } from '../lib/theme';
import { buttonClass, Check, Notice, secondaryButtonClass } from './app-shell';
import { RmLogo } from './rm-logo';

type Scope = 'TENANT' | 'USER';
type Message = { text: string; kind: 'error' | 'success' };

function OptionButton({ active, onClick, children, label }: { active: boolean; onClick: () => void; children?: React.ReactNode; label: string }) {
  return <button type="button" onClick={onClick} aria-pressed={active} title={label} className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition ${active ? 'border-brand-500 bg-brand-50 text-brand-700 ring-2 ring-brand-500/30' : 'border-slate-300 bg-white text-slate-700 hover:border-brand-400'}`}>{children}{label}</button>;
}

// Miniature of the real layout, themed through the same data attributes as the app; it shows unsaved choices in real time.
function Preview({ theme }: { theme: ThemePreference }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current) applyTheme(theme, ref.current); }, [theme]);
  return <div ref={ref} aria-label="Pré-visualização" className="rm-canvas overflow-hidden rounded-2xl border border-slate-300">
    <div className="rm-chrome flex items-center gap-2 border-b border-brand-500/50 px-3 py-2 text-white"><RmLogo variant="mark" className="h-6 w-7" /><span className="text-xs font-semibold">RM Restaurant</span><span className="ml-auto rounded-full bg-brand-500 px-2 py-0.5 text-[10px] font-bold text-neutral-950">Aberto</span></div>
    <div className="flex min-h-48">
      <div className="rm-chrome w-28 shrink-0 space-y-1 border-r border-brand-500/30 p-2 text-[11px] text-neutral-200">
        <p className="rounded-md bg-brand-500 px-2 py-1.5 font-semibold text-neutral-950">Dashboard</p>
        <p className="rounded-md bg-brand-500/15 px-2 py-1.5 text-brand-300 ring-1 ring-brand-500/40">PDV</p>
        <p className="px-2 py-1.5">Estoque</p><p className="px-2 py-1.5">Financeiro</p>
      </div>
      <div className="min-w-0 flex-1 space-y-2 p-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-brand-500/40 bg-white p-2"><p className="text-[10px] text-slate-500">Indicador</p><div className="mt-1 h-2 w-3/4 rounded-full bg-brand-500" /></div>
          <div className="rounded-xl border border-brand-500/40 bg-white p-2"><p className="text-[10px] text-slate-500">Meta</p><div className="mt-1 h-2 w-1/2 rounded-full bg-brand-300" /></div>
        </div>
        <div className="rounded-xl border border-brand-500/40 bg-white p-2"><p className="text-[10px] font-semibold text-slate-900">Gráfico</p>
          <div className="mt-2 flex h-12 items-end gap-1">{[40, 65, 50, 85, 60, 95, 75].map((height, index) => <span key={index} className="flex-1 rounded-t bg-brand-500" style={{ height: `${height}%` }} />)}</div></div>
        <div className="flex gap-2"><span className="rounded-lg bg-brand-500 px-3 py-1 text-[11px] font-semibold text-neutral-950">Botão</span><span className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-[11px] text-slate-700">Secundário</span></div>
      </div>
    </div>
  </div>;
}

export function AppearancePanel() {
  const role = storedUser().role;
  const canManage = MANAGEMENT_ROLES.includes(role ?? '');
  const [data, setData] = useState<AppearanceResponse | null>(null);
  const [scope, setScope] = useState<Scope>('USER');
  const [draft, setDraft] = useState<ThemePreference>(DEFAULT_THEME);
  const [allowOverride, setAllowOverride] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  function seed(result: AppearanceResponse, nextScope: Scope) {
    const source = nextScope === 'TENANT' ? result.tenant : result.user ?? result.effective.value;
    setDraft({ mode: source?.mode ?? DEFAULT_THEME.mode, primary: source?.primary ?? DEFAULT_THEME.primary, sidebar: source?.sidebar ?? DEFAULT_THEME.sidebar });
    setAllowOverride(result.tenant?.allowUserOverride ?? true);
  }
  useEffect(() => {
    let cancelled = false;
    api<AppearanceResponse>('/appearance').then(result => {
      if (cancelled) return;
      const initial: Scope = result.tenant && canManage ? 'TENANT' : 'USER';
      setData(result); setScope(initial); seed(result, initial);
    }).catch(error => { if (!cancelled) setMessage({ text: errorMessage(error, 'Erro ao carregar a aparência'), kind: 'error' }); });
    return () => { cancelled = true; };
  }, [canManage]);

  const tenantScope = scope === 'TENANT' && data?.tenant;
  const personalBlocked = scope === 'USER' && data?.tenant?.allowUserOverride === false;
  const disabled = busy || !data || personalBlocked;

  function changeScope(next: Scope) { if (!data) return; setScope(next); seed(data, next); setMessage(null); }

  async function persist(theme: ThemePreference, okText: string) {
    setBusy(true); setMessage(null);
    try {
      const result = tenantScope
        ? (await api('/settings/appearance', { method: 'PUT', body: JSON.stringify({ ...theme, allowUserOverride: allowOverride }) }), await api<AppearanceResponse>('/appearance'))
        : await api<AppearanceResponse>('/appearance/me', { method: 'PUT', body: JSON.stringify(theme) });
      setData(result); seed(result, scope); refreshTheme();
      setMessage({ text: okText, kind: 'success' });
    } catch (error) { setMessage({ text: errorMessage(error, 'Erro ao salvar a aparência'), kind: 'error' }); } finally { setBusy(false); }
  }

  async function restoreDefault() {
    if (!window.confirm('Restaurar o padrão original RM (escuro, dourado e barra preta)? A alteração será aplicada imediatamente.')) return;
    setDraft(DEFAULT_THEME);
    await persist(DEFAULT_THEME, 'Padrão original RM restaurado.');
  }

  async function removePersonal() {
    setBusy(true); setMessage(null);
    try {
      const result = await api<AppearanceResponse>('/appearance/me', { method: 'DELETE' });
      setData(result); seed(result, 'USER'); refreshTheme();
      setMessage({ text: 'Preferência pessoal removida: vale o padrão do restaurante.', kind: 'success' });
    } catch (error) { setMessage({ text: errorMessage(error, 'Erro ao remover a preferência'), kind: 'error' }); } finally { setBusy(false); }
  }

  const dirtyDraft = (() => {
    const base = tenantScope ? data?.tenant : data?.user ?? null;
    return !base || base.mode !== draft.mode || base.primary !== draft.primary || base.sidebar !== draft.sidebar || (Boolean(tenantScope) && data?.tenant?.allowUserOverride !== allowOverride);
  })();
  const sourceLabel = data?.effective.source === 'USER' ? 'sua preferência pessoal' : data?.effective.source === 'TENANT' ? 'o padrão do restaurante' : 'o padrão RM';

  return <div className="space-y-5">
    {message && <Notice message={message.text} kind={message.kind} />}
    {data && <p className="text-sm text-slate-600">Em uso agora: <strong>{sourceLabel}</strong>. Prioridade: preferência pessoal › padrão do restaurante › padrão RM.</p>}
    {data?.tenant && <div className="flex flex-wrap gap-2" role="group" aria-label="Escopo da aparência">
      <OptionButton active={scope === 'USER'} onClick={() => changeScope('USER')} label="Minha preferência" />
      {canManage && <OptionButton active={scope === 'TENANT'} onClick={() => changeScope('TENANT')} label="Padrão do restaurante" />}
    </div>}
    {personalBlocked && <Notice message="O restaurante desativou a personalização individual: todos os usuários seguem o padrão do restaurante." />}
    <div className="grid gap-6 xl:grid-cols-[1fr_minmax(280px,420px)]">
      <div className="space-y-5">
        <fieldset disabled={disabled} className="space-y-2"><legend className="text-sm font-semibold text-slate-900">Modo de exibição</legend>
          <div className="flex flex-wrap gap-2">{modeOptions.map(option => <OptionButton key={option.value} active={draft.mode === option.value} onClick={() => setDraft({ ...draft, mode: option.value })} label={option.label}><span aria-hidden="true">{option.icon}</span></OptionButton>)}</div>
          <p className="text-xs text-slate-500">Automático acompanha a preferência de claro/escuro do dispositivo.</p></fieldset>
        <fieldset disabled={disabled} className="space-y-2"><legend className="text-sm font-semibold text-slate-900">Cor principal</legend>
          <div className="flex flex-wrap gap-2">{primaryOptions.map(option => <OptionButton key={option.value} active={draft.primary === option.value} onClick={() => setDraft({ ...draft, primary: option.value })} label={option.label}><span aria-hidden="true" className="h-4 w-4 rounded-full border border-black/20" style={{ background: option.swatch }} /></OptionButton>)}</div></fieldset>
        <fieldset disabled={disabled} className="space-y-2"><legend className="text-sm font-semibold text-slate-900">Cor da barra lateral e do topo</legend>
          <div className="flex flex-wrap gap-2">{sidebarOptions.map(option => <OptionButton key={option.value} active={draft.sidebar === option.value} onClick={() => setDraft({ ...draft, sidebar: option.value })} label={option.label}><span aria-hidden="true" className="h-4 w-4 rounded-full border border-slate-400" style={{ background: option.swatch }} /></OptionButton>)}</div>
          <p className="text-xs text-slate-500">Qualquer combinação com a cor principal mantém contraste e legibilidade.</p></fieldset>
        {tenantScope && <Check label="Permitir que cada usuário tenha sua própria aparência" checked={allowOverride} onChange={event => setAllowOverride(event.target.checked)} disabled={disabled} />}
        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          <button type="button" className={buttonClass} disabled={disabled || !dirtyDraft} onClick={() => void persist(draft, tenantScope ? 'Aparência do restaurante salva e aplicada.' : 'Sua preferência foi salva e aplicada.')}>{busy ? 'Salvando…' : 'Salvar preferências'}</button>
          <button type="button" className={secondaryButtonClass} disabled={disabled} onClick={() => void restoreDefault()}>Restaurar padrão original RM</button>
          {scope === 'USER' && data?.user && <button type="button" className={secondaryButtonClass} disabled={busy} onClick={() => void removePersonal()}>Usar o padrão do restaurante</button>}
        </div>
      </div>
      <div><p className="mb-2 text-sm font-semibold text-slate-900">Pré-visualização em tempo real</p><Preview theme={draft} /></div>
    </div>
  </div>;
}
