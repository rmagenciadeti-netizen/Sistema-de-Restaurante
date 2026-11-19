'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { api, tokenStorageKey } from '../lib/api';
import { applyTheme, cachedTheme, cacheTheme, isThemedPath, liteWanted, THEME_EVENT, type AppearanceResponse } from '../lib/theme';
import { installFetchCache } from '../lib/fetch-cache';

// The appearance only changes when the user saves it (THEME_EVENT), so it is not re-requested on every screen change.
const APPEARANCE_TTL_MS = 10 * 60_000;
let lastAppearanceSync = 0;
let lastAppearanceToken: string | null = null;

// Single place that applies the visual theme: cached copy first (instant), then the effective theme from the API (personal > restaurant > RM default).
export function ThemeProvider() {
  const pathname = usePathname();
  // One shared request layer for the whole app: simultaneous identical GETs are merged and small reference data is reused briefly (see lib/fetch-cache.ts).
  useEffect(() => { installFetchCache(); }, []);
  useEffect(() => {
    const apply = () => { if (liteWanted()) document.documentElement.dataset.lite = '1'; else delete document.documentElement.dataset.lite; };
    apply();
    const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
    connection?.addEventListener('change', apply);
    return () => connection?.removeEventListener('change', apply);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (!isThemedPath(pathname)) { root.dataset.theme = 'light'; root.dataset.primary = 'gold'; root.dataset.sidebar = 'black'; root.dataset.public = '1'; return; }
    delete root.dataset.public;
    applyTheme(cachedTheme());
    let cancelled = false;
    async function sync(force = false) {
      const token = localStorage.getItem(tokenStorageKey);
      if (!token) return;
      // A different session (new login) always syncs; the same session reuses the answer for a while.
      if (!force && token === lastAppearanceToken && Date.now() - lastAppearanceSync < APPEARANCE_TTL_MS) return;
      lastAppearanceSync = Date.now(); lastAppearanceToken = token;
      try {
        const result = await api<AppearanceResponse>('/appearance');
        if (cancelled) return;
        cacheTheme(result.effective.value); applyTheme(result.effective.value);
      } catch { /* keep the cached theme */ }
    }
    void sync();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const reapply = () => applyTheme(cachedTheme());
    media.addEventListener('change', reapply);
    const forced = () => { void sync(true); };
    window.addEventListener(THEME_EVENT, forced);
    return () => { cancelled = true; media.removeEventListener('change', reapply); window.removeEventListener(THEME_EVENT, forced); };
  }, [pathname]);
  return null;
}
