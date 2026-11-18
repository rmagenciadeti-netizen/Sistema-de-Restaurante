'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { api, tokenStorageKey } from '../lib/api';
import { applyTheme, cachedTheme, cacheTheme, isThemedPath, THEME_EVENT, type AppearanceResponse } from '../lib/theme';

// Single place that applies the visual theme: cached copy first (instant), then the effective theme from the API (personal > restaurant > RM default).
export function ThemeProvider() {
  const pathname = usePathname();
  useEffect(() => {
    const root = document.documentElement;
    if (!isThemedPath(pathname)) { root.dataset.theme = 'light'; root.dataset.primary = 'gold'; root.dataset.sidebar = 'black'; root.dataset.public = '1'; return; }
    delete root.dataset.public;
    applyTheme(cachedTheme());
    let cancelled = false;
    async function sync() {
      if (!localStorage.getItem(tokenStorageKey)) return;
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
    window.addEventListener(THEME_EVENT, sync);
    return () => { cancelled = true; media.removeEventListener('change', reapply); window.removeEventListener(THEME_EVENT, sync); };
  }, [pathname]);
  return null;
}
