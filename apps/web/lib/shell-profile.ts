'use client';

import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { api, ApiError, userStorageKey } from './api';
import type { SettingsResponse, TenantSettings } from './settings';

// What the shell (top bar, side menu, dashboard tiles) needs to know about the signed-in profile: licensed modules, permitted AI specialists, hidden menu entries, store hours.
// One shared store per browser session, so moving between screens never resets it and the menu is never rebuilt from "nothing" on every page:
//   1. the last known profile (localStorage, per user) is applied before the first paint;
//   2. the API answers are applied silently on top (stale-while-revalidate);
//   3. a transient failure keeps what was known instead of replacing it with an empty/reduced version.
// Until there is either a cached or a fresh profile, `ready` is false and the UI shows placeholders, never a partial or temporary menu.
export type ShellTenant = { name?: string; slug?: string; license?: { status: string; validUntil: string | null } | null } | null | undefined;
export type ShellProfile = {
  ready: boolean;
  tenant: ShellTenant;
  // undefined = not known yet, null = unrestricted (company without a licence row), array = contracted modules.
  enabledModules: string[] | null | undefined;
  // null = not known yet; the API decides (licence AND role).
  aiDomains: string[] | null;
  menuHidden: string[] | null;
  sidebarLayout: string | null;
  hours: TenantSettings['hours'] | null;
};
export const EMPTY_PROFILE: ShellProfile = { ready: false, tenant: undefined, enabledModules: undefined, aiDomains: null, menuHidden: null, sidebarLayout: null, hours: null };

type Persisted = Pick<ShellProfile, 'tenant' | 'enabledModules' | 'aiDomains' | 'menuHidden' | 'sidebarLayout' | 'hours'>;
const CACHE_PREFIX = 'rm_shell_profile:';

let state: ShellProfile = EMPTY_PROFILE;
let cacheKey: string | null = null;
let inflight: Promise<void> | null = null;
let loadedAt = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function currentKey(): string | null {
  try {
    const user = JSON.parse(localStorage.getItem(userStorageKey) ?? 'null') as { id?: string } | null;
    return user?.id ? `${CACHE_PREFIX}${userStorageKey}:${user.id}` : null;
  } catch { return null; }
}

function set(patch: Partial<ShellProfile>) {
  state = { ...state, ...patch };
  if (cacheKey) {
    const { tenant, enabledModules, aiDomains, menuHidden, sidebarLayout, hours } = state;
    const data: Persisted = { tenant, enabledModules, aiDomains, menuHidden, sidebarLayout, hours };
    try { localStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* storage unavailable */ }
  }
  emit();
}

// Applies the last known profile of the signed-in user (synchronously, before paint). Another user/session starts from scratch.
export function hydrateShellProfile() {
  const key = currentKey();
  if (key === cacheKey && cacheKey !== null) return;
  cacheKey = key; state = EMPTY_PROFILE;
  if (key) {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Persisted> | null;
      if (raw && typeof raw === 'object') state = { ...EMPTY_PROFILE, ...raw, ready: true };
    } catch { /* ignore a corrupted cache */ }
  }
  emit();
}

export function resetShellProfile() {
  if (cacheKey) { try { localStorage.removeItem(cacheKey); } catch { /* ignore */ } }
  cacheKey = null; state = EMPTY_PROFILE; loadedAt = 0; emit();
}

// A 4xx answer is a definitive "no"; anything else (network, 5xx) is transient and must not change what is shown.
const definitive = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function withRetry<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; definitive: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return { ok: true, value: await call() }; }
    catch (error) { if (definitive(error)) return { ok: false, definitive: true }; if (attempt < 2) await sleep(1200 * (attempt + 1)); }
  }
  return { ok: false, definitive: false };
}

async function load() {
  const [me, ai, settings] = await Promise.all([
    withRetry(() => api<{ user: { tenant?: ShellTenant; enabledModules?: string[] | null } }>('/auth/me')),
    withRetry(() => api<{ available: { key: string }[] }>('/ai/domains')),
    withRetry(() => api<SettingsResponse>('/settings')),
  ]);
  const patch: Partial<ShellProfile> = {};
  if (me.ok) { if (me.value.user?.tenant) patch.tenant = me.value.user.tenant; patch.enabledModules = me.value.user?.enabledModules ?? null; }
  else if (state.enabledModules === undefined) patch.enabledModules = null; // same as before: with no answer the menu is not restricted (the API enforces modules on every request)
  if (ai.ok) patch.aiDomains = ai.value.available.map(item => item.key);
  else if (ai.definitive) patch.aiDomains = [];
  if (settings.ok) { patch.menuHidden = settings.value.settings.menuLayout.hidden; patch.sidebarLayout = settings.value.settings.company.sidebarLayout; patch.hours = settings.value.settings.hours; }
  else if (state.menuHidden === null) patch.menuHidden = [];
  set({ ...patch, ready: true });
  if (me.ok || ai.ok || settings.ok) loadedAt = Date.now();
}

// Always revalidates in the background; concurrent callers share one round of requests.
export function refreshShellProfile(): Promise<void> {
  if (!inflight) inflight = load().finally(() => { inflight = null; });
  return inflight;
}

// Moving between screens must not repeat the same three requests every time: the profile is re-checked at most once per minute (and when the tab becomes visible again).
// The API enforces licence and role on every call; this data only shapes the menu.
export function refreshShellProfileIfStale(maxAgeMs = 60_000): Promise<void> {
  if (!state.ready || Date.now() - loadedAt >= maxAgeMs) return refreshShellProfile();
  return Promise.resolve();
}

export const getShellProfile = () => state;
export function patchShellHours(hours: TenantSettings['hours']) { set({ hours }); }

export function useShellProfile(enabled = true): ShellProfile {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => EMPTY_PROFILE);
  useLayoutEffect(() => { if (enabled) hydrateShellProfile(); }, [enabled]);
  useEffect(() => {
    if (!enabled) return undefined;
    void refreshShellProfileIfStale();
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshShellProfileIfStale(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [enabled]);
  return snapshot;
}
