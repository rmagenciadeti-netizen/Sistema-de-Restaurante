'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, isAdminApp, tokenStorageKey, userStorageKey } from '../lib/api';
import { alwaysVisibleHrefs, flows, menuGroups, moduleIcon, moduleLabel, pathOf, topTabs, type MenuGroup } from '../lib/menu-catalog';
import { isStoreOpen, type SettingsResponse, type TenantSettings } from '../lib/settings';

export { flows, moduleIcon, moduleLabel };

type Me = { name?: string; role?: string; tenant?: { name?: string; slug?: string; license?: { status: string; validUntil: string | null } | null } | null };
const MANAGER_ROLES = ['ADMIN', 'MANAGER'];
// Paths that appear in the menu both with and without a query string (e.g. /reports, /history) highlight only the matching entry.
const groupsWithQuery = new Set(menuGroups.flatMap(group => group.items).filter(item => item.href.includes('?')).map(item => pathOf(item.href)));

function Chevron({ open }: { open: boolean }) {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className={`h-4 w-4 transition ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>;
}
const MenuIcon = () => <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>;

function licenseNote(license?: { status: string; validUntil: string | null } | null) {
  if (!license) return null;
  if (license.status !== 'ACTIVE') return { text: 'Licença inativa', tone: 'text-red-300' };
  if (!license.validUntil) return { text: 'Licença ativa', tone: 'text-emerald-300' };
  const date = new Date(license.validUntil);
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  return { text: `Licença expira em ${date.toLocaleDateString('pt-BR')}`, tone: days <= 15 ? 'text-amber-300' : 'text-emerald-300' };
}

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<Me | null>(null);
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<string[]>(() => isAdminApp ? [] : ['Movimento']);
  const [query, setQuery] = useState('');
  const [statusError, setStatusError] = useState('');
  const [search, setSearch] = useState('');

  const masterMode = isAdminApp;

  useEffect(() => { setSearch(window.location.search); }, [pathname]);

  useEffect(() => {
    const token = localStorage.getItem(tokenStorageKey);
    if (!token) { router.replace('/login'); return; }
    let stored: Me = {};
    try { stored = JSON.parse(localStorage.getItem(userStorageKey) ?? '{}'); } catch { /* keep empty */ }
    if (isAdminApp && stored.role !== 'MASTER_ADMIN') { router.replace('/login'); return; }
    setUser(stored);
    if (isAdminApp || stored.role === 'MASTER_ADMIN') return;
    let active = true;
    api<{ user: { tenant?: Me['tenant'] } }>('/auth/me').then(result => { if (active && result.user?.tenant) setUser(current => ({ ...current, tenant: result.user.tenant })); }).catch(() => undefined);
    api<SettingsResponse>('/settings').then(result => { if (active) setSettings(result.settings); }).catch(() => undefined);
    return () => { active = false; };
  }, [router]);

  const hidden = useMemo(() => new Set(settings?.menuLayout.hidden ?? []), [settings]);
  const groups = useMemo<MenuGroup[]>(() => menuGroups.map(group => ({
    ...group,
    items: group.items.filter(item => (masterMode ? item.masterOnly || item.href === '/dashboard' : !item.masterOnly) && (masterMode || alwaysVisibleHrefs.includes(item.href) || !hidden.has(item.href))),
  })).filter(group => group.items.length > 0), [masterMode, hidden]);

  const needle = query.trim().toLowerCase();
  const visibleGroups = useMemo(() => needle ? groups.map(group => ({ ...group, items: group.items.filter(item => item.label.toLowerCase().includes(needle)) })).filter(group => group.items.length > 0) : groups, [groups, needle]);
  const activeGroup = groups.find(group => group.items.some(item => pathOf(item.href) === pathname))?.title;
  const expanded = (title: string) => Boolean(needle) || title === activeGroup || openGroups.includes(title);
  const toggleGroup = (title: string) => setOpenGroups(current => current.includes(title) ? current.filter(item => item !== title) : [...current, title]);

  function signOut() {
    localStorage.removeItem(tokenStorageKey);
    localStorage.removeItem(userStorageKey);
    router.replace('/login');
  }

  const open = settings ? isStoreOpen(settings.hours) : null;
  const canToggleStore = MANAGER_ROLES.includes(user?.role ?? '');
  async function toggleStore() {
    if (!settings || !canToggleStore) return;
    setStatusError('');
    const mode = open ? 'CLOSED' : 'OPEN';
    try {
      await api(`/settings/hours`, { method: 'PUT', body: JSON.stringify({ ...settings.hours, mode }) });
      setSettings({ ...settings, hours: { ...settings.hours, mode } });
    } catch { setStatusError('Não foi possível alterar o status da loja'); }
  }

  const related = masterMode ? [] : flows.filter(flow => flow.hrefs.includes(pathname));
  const initials = user?.name?.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'RM';
  const brand = masterMode ? 'RM Painel Admin' : user?.tenant?.name ?? 'RM Restaurant';
  const license = licenseNote(user?.tenant?.license);
  const sidebarVisible = mobileOpen ? 'block' : 'hidden';

  return (
    <div className="min-h-screen bg-[var(--rm-workspace)] text-slate-900 print:bg-white print:text-black">
      <header className="sticky top-0 z-40 flex min-h-16 items-center gap-2 bg-neutral-950 px-3 text-white shadow-lg shadow-black/20 sm:gap-3 sm:px-4 print:hidden">
        <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/15 text-brand-300 hover:bg-white/10 md:hidden" onClick={() => { setCollapsed(false); setMobileOpen(value => !value); }} aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'} aria-expanded={mobileOpen}><MenuIcon /></button>
        <button type="button" className="hidden h-10 w-10 shrink-0 place-items-center rounded-lg border border-white/15 text-brand-300 hover:bg-white/10 md:grid" onClick={() => setCollapsed(value => !value)} aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'} aria-expanded={!collapsed}><MenuIcon /></button>
        <Link href="/dashboard" className="flex min-w-0 shrink-0 items-center gap-2.5 font-semibold" title={brand}>
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-brand-400/60 bg-brand-500/10 font-serif text-sm font-bold text-brand-300">RM</span>
          <span className="hidden max-w-44 truncate text-sm lg:block">{brand}</span>
        </Link>
        {!masterMode && <nav aria-label="Acesso rápido" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {topTabs.map(item => <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined} className={`flex shrink-0 flex-col items-center gap-0.5 rounded-lg px-3 py-1.5 text-[11px] font-semibold leading-tight transition sm:px-4 ${pathname === item.href ? 'text-brand-300' : 'text-neutral-200 hover:bg-white/10'}`}>
            <span aria-hidden="true" className="text-lg leading-none">{item.icon}</span>{item.label}
            <span className={`h-0.5 w-6 rounded-full ${pathname === item.href ? 'bg-brand-400' : 'bg-transparent'}`} />
          </Link>)}
        </nav>}
        {masterMode && <p className="min-w-0 flex-1 truncate text-xs uppercase tracking-[0.22em] text-brand-300">Central de administração</p>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {!masterMode && open !== null && <button type="button" onClick={() => void toggleStore()} disabled={!canToggleStore} title={canToggleStore ? 'Alternar loja aberta/fechada' : 'Somente gerentes alteram o status'} className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold sm:flex ${open ? 'border-emerald-400/40 bg-emerald-500/10 text-emerald-300' : 'border-red-400/40 bg-red-500/10 text-red-300'} ${canToggleStore ? 'hover:brightness-125' : 'cursor-default'}`}>
            <span className={`h-2 w-2 rounded-full ${open ? 'bg-emerald-400' : 'bg-red-400'}`} />{open ? 'Aberto' : 'Fechado'}
          </button>}
          {!masterMode && <Link href="/cash" className="hidden rounded-lg border border-white/15 px-3 py-2 text-xs font-medium text-neutral-100 hover:bg-white/10 md:block">💳 Caixa</Link>}
          <div className="relative">
            <button type="button" onClick={() => setProfileOpen(value => !value)} aria-expanded={profileOpen} aria-haspopup="menu" className="flex items-center gap-2 rounded-full border border-white/15 py-1 pl-1 pr-3 text-xs font-semibold hover:bg-white/10">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-500 text-xs font-bold text-neutral-950">{initials}</span>
              <span className="hidden max-w-28 truncate sm:block">{user?.name ?? 'Perfil'}</span>
            </button>
            {profileOpen && <div role="menu" className="absolute right-0 mt-2 w-60 overflow-hidden rounded-xl border border-white/10 bg-neutral-900 text-sm text-neutral-100 shadow-2xl">
              <div className="border-b border-white/10 px-4 py-3"><p className="truncate font-semibold">{user?.name ?? 'Usuário'}</p><p className="mt-0.5 text-[10px] uppercase tracking-wider text-neutral-400">{user?.role ?? ''}</p></div>
              <Link role="menuitem" href="/change-password" onClick={() => setProfileOpen(false)} className="block px-4 py-2.5 hover:bg-white/10">Alterar senha</Link>
              {!masterMode && <Link role="menuitem" href="/downloads" onClick={() => setProfileOpen(false)} className="block px-4 py-2.5 hover:bg-white/10">Downloads e ajuda</Link>}
              <button role="menuitem" type="button" onClick={signOut} className="block w-full px-4 py-2.5 text-left text-red-300 hover:bg-white/10">Sair da conta</button>
            </div>}
          </div>
        </div>
      </header>
      <div className="md:flex">
        <aside className={`${sidebarVisible} print:hidden w-full shrink-0 overflow-y-auto border-b border-neutral-800 bg-neutral-900 p-3 text-neutral-200 md:sticky md:top-16 md:block md:h-[calc(100vh-4rem)] md:border-b-0 md:border-r ${collapsed ? 'md:w-[72px] md:px-2' : 'md:w-[264px]'}`}>
          {!collapsed && <label className="sr-only" htmlFor="menu-search">Buscar no menu</label>}
          {!collapsed && <input id="menu-search" type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar no menu…" className="mb-3 w-full rounded-lg border border-white/10 bg-neutral-950 px-3 py-2 text-xs text-white outline-none placeholder:text-neutral-500 focus:border-brand-500" />}
          <nav aria-label="Menu principal" className="space-y-1">
            {visibleGroups.map(group => {
              const single = group.items.length === 1 && group.title === 'Início';
              const isOpen = expanded(group.title) || collapsed;
              return <section key={group.title}>
                {single
                  ? <Link href={group.items[0].href} onClick={() => setMobileOpen(false)} title={collapsed ? group.items[0].label : undefined} aria-current={pathname === group.items[0].href ? 'page' : undefined} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] font-semibold transition ${collapsed ? 'md:justify-center md:px-2' : ''} ${pathname === group.items[0].href ? 'bg-brand-500 text-neutral-950' : 'text-neutral-100 hover:bg-white/[0.07]'}`}><span aria-hidden="true" className="w-5 text-center text-base">{group.icon}</span>{!collapsed && <span>{group.items[0].label}</span>}</Link>
                  : <>
                    {!collapsed && <button type="button" onClick={() => toggleGroup(group.title)} aria-expanded={isOpen} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-[13px] font-semibold text-neutral-100 transition hover:bg-white/[0.07]"><span aria-hidden="true" className="w-5 text-center text-base">{group.icon}</span><span className="min-w-0 flex-1 truncate">{group.title}</span><Chevron open={isOpen} /></button>}
                    {isOpen && <div className={`${collapsed ? '' : 'ml-4 border-l border-white/10 pl-2'} space-y-0.5 pb-1`}>
                      {group.items.map(link => {
                        const current = pathOf(link.href) === pathname && (!link.href.includes('?') ? !search || !groupsWithQuery.has(pathOf(link.href)) : search === link.href.slice(link.href.indexOf('?')));
                        return <Link key={link.href} href={link.href} title={collapsed ? link.label : undefined} aria-label={collapsed ? link.label : undefined} onClick={() => setMobileOpen(false)} aria-current={current ? 'page' : undefined} className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] transition ${collapsed ? 'md:justify-center md:px-2' : ''} ${current ? 'bg-brand-500/15 font-semibold text-brand-300 ring-1 ring-brand-500/40' : 'text-neutral-300 hover:bg-white/[0.07] hover:text-white'}`}><span aria-hidden="true" className="w-5 shrink-0 text-center text-sm">{link.icon}</span>{!collapsed && <span className="min-w-0 flex-1">{link.label}</span>}</Link>;
                      })}
                    </div>}
                  </>}
              </section>;
            })}
            {visibleGroups.length === 0 && <p className="px-3 py-4 text-xs text-neutral-500">Nenhum item encontrado.</p>}
          </nav>
          {!collapsed && <div className="mt-6 rounded-xl border border-white/10 bg-neutral-950 p-4 text-center">
            <p className="font-serif text-lg font-bold tracking-tight text-brand-300">RM Restaurant</p>
            <p className="mt-0.5 text-[10px] uppercase tracking-[0.22em] text-neutral-500">Gestão gastronômica</p>
            {license && <p className={`mt-3 text-xs ${license.tone}`}>{license.text}</p>}
          </div>}
        </aside>
        <main className="min-w-0 flex-1 p-3 sm:p-5 md:p-6 print:p-0">
          <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500 print:hidden">
            <Link href="/dashboard" className="font-semibold text-brand-700 hover:text-brand-600">🏠 Início</Link><span aria-hidden="true">/</span>
            <span className="text-base font-bold tracking-tight text-slate-900">{title}</span>
            {statusError && <span role="status" className="ml-auto text-red-700">{statusError}</span>}
          </div>
          <h1 className="sr-only">{title}</h1>
          {related.map(flow => <nav key={flow.title} aria-label={`Atalhos: ${flow.title}`} className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm print:hidden">
            <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{flow.title}</span>
            {flow.hrefs.map((href, index) => <span key={href} className="flex items-center gap-2">
              {index > 0 && <span aria-hidden="true" className="text-brand-400/60">›</span>}
              <Link href={href} aria-current={pathname === href ? 'page' : undefined} className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${pathname === href ? 'bg-neutral-950 text-brand-300' : 'text-slate-700 hover:bg-slate-100 hover:text-brand-700'}`}><span aria-hidden="true">{moduleIcon(href)}</span>{moduleLabel(href)}</Link>
            </span>)}
          </nav>)}
          {children}
        </main>
      </div>
    </div>
  );
}

export function Notice({ message, kind = 'error' }: { message: string; kind?: 'error' | 'success' }) {
  return <div role="status" className={`mb-4 rounded-xl border px-4 py-3 text-sm ${kind === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-emerald-200 bg-emerald-50 text-emerald-800'}`}>{message}</div>;
}

export function Field({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="block text-sm font-medium text-slate-700">{label}<input {...props} className={`mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15 ${props.className ?? ''}`} /></label>;
}

export const inputClass = 'mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-slate-900 outline-none transition focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15';
export const secondaryButtonClass = 'rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-brand-400 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50';

export function Select({ label, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <label className="block text-sm text-slate-700">{label}<select {...props} className={`${inputClass} ${props.className ?? ''}`}>{children}</select></label>;
}

export function Check({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" {...props} className="h-4 w-4 accent-brand-600" />{label}</label>;
}

export const panelClass = 'rm-surface rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-black/[0.03] sm:p-6';
export const buttonClass = 'rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-neutral-950 shadow-sm transition hover:bg-brand-400 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-50';
