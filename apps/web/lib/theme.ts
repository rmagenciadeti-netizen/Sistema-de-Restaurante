import { isAdminApp } from './api';

export type ThemeMode = 'LIGHT' | 'DARK' | 'AUTO';
export type ThemePrimary = 'GOLD' | 'BLUE' | 'GREEN' | 'RED' | 'YELLOW' | 'PURPLE' | 'ORANGE';
export type ThemeSidebar = 'BLACK' | 'WHITE' | 'GRAY' | 'GRAPHITE' | 'NAVY' | 'FOREST';
export type ThemePreference = { mode: ThemeMode; primary: ThemePrimary; sidebar: ThemeSidebar };
export type AppearanceResponse = {
  tenant: (ThemePreference & { allowUserOverride: boolean }) | null;
  user: ThemePreference | null;
  effective: { source: 'USER' | 'TENANT' | 'DEFAULT'; value: ThemePreference };
};

export const DEFAULT_THEME: ThemePreference = { mode: 'DARK', primary: 'GOLD', sidebar: 'BLACK' };
export const themeCacheKey = isAdminApp ? 'rm_admin_theme' : 'rm_restaurant_theme';

export const modeOptions: { value: ThemeMode; label: string; icon: string }[] = [
  { value: 'LIGHT', label: 'Claro', icon: '☀️' }, { value: 'DARK', label: 'Escuro', icon: '🌙' }, { value: 'AUTO', label: 'Automático', icon: '🖥️' },
];
export const primaryOptions: { value: ThemePrimary; label: string; swatch: string }[] = [
  { value: 'GOLD', label: 'Dourado (padrão RM)', swatch: '#b89235' }, { value: 'BLUE', label: 'Azul', swatch: '#3b82f6' }, { value: 'GREEN', label: 'Verde', swatch: '#22c55e' },
  { value: 'RED', label: 'Vermelho', swatch: '#ef4444' }, { value: 'YELLOW', label: 'Amarelo', swatch: '#eab308' }, { value: 'PURPLE', label: 'Roxo', swatch: '#a855f7' }, { value: 'ORANGE', label: 'Laranja', swatch: '#f97316' },
];
export const sidebarOptions: { value: ThemeSidebar; label: string; swatch: string }[] = [
  { value: 'BLACK', label: 'Preto', swatch: '#0b0a08' }, { value: 'WHITE', label: 'Branco', swatch: '#ffffff' }, { value: 'GRAY', label: 'Cinza', swatch: '#3a3a40' },
  { value: 'GRAPHITE', label: 'Grafite', swatch: '#23262b' }, { value: 'NAVY', label: 'Azul-escuro', swatch: '#0f1f3d' }, { value: 'FOREST', label: 'Verde-escuro', swatch: '#0d2b1f' },
];

const PUBLIC_PREFIXES = ['/loja', '/m/'];
export const isThemedPath = (pathname: string) => !PUBLIC_PREFIXES.some(prefix => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`));

export function isThemePreference(value: unknown): value is ThemePreference {
  const item = value as Partial<ThemePreference> | null;
  return Boolean(item) && modeOptions.some(option => option.value === item!.mode) && primaryOptions.some(option => option.value === item!.primary) && sidebarOptions.some(option => option.value === item!.sidebar);
}

export function resolveMode(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'AUTO' ? (prefersDark ? 'dark' : 'light') : mode === 'LIGHT' ? 'light' : 'dark';
}

// Applies the preference to a root element (the whole app, or a preview box) through data attributes consumed by globals.css and palettes.css.
export function applyTheme(theme: ThemePreference, root: HTMLElement = document.documentElement) {
  const prefersDark = typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = resolveMode(theme.mode, prefersDark);
  root.dataset.primary = theme.primary.toLowerCase();
  root.dataset.sidebar = theme.sidebar.toLowerCase();
}

export function cacheTheme(theme: ThemePreference) {
  try { localStorage.setItem(themeCacheKey, JSON.stringify(theme)); } catch { /* storage unavailable */ }
}
export function cachedTheme(): ThemePreference {
  try { const raw = JSON.parse(localStorage.getItem(themeCacheKey) ?? 'null'); if (isThemePreference(raw)) return raw; } catch { /* ignore */ }
  return DEFAULT_THEME;
}

// "Lite" visual mode: Save-Data, slow connections (2G/3G), low-memory devices or prefers-reduced-data turn off blur, aurora/grid layers and decorative animation. Nothing functional changes.
export function liteWanted(): boolean {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string }; deviceMemory?: number };
  const connection = nav.connection;
  return Boolean(connection?.saveData || /(^|-)[23]g/.test(connection?.effectiveType ?? '') || (nav.deviceMemory && nav.deviceMemory <= 2) || window.matchMedia('(prefers-reduced-data: reduce)').matches);
}

export const THEME_EVENT = 'rm-theme-refresh';
export const refreshTheme = () => window.dispatchEvent(new Event(THEME_EVENT));

// Runs before first paint (inline in <head>) so the saved theme never flashes the default one.
export const themeBootScript = `(function(){try{var p=location.pathname;var d=document.documentElement;var n=navigator,c=n.connection;if((c&&(c.saveData||/(^|-)[23]g/.test(c.effectiveType||'')))||(n.deviceMemory&&n.deviceMemory<=2)||matchMedia('(prefers-reduced-data: reduce)').matches)d.dataset.lite='1';if(p==='/loja'||p.indexOf('/loja/')===0||p.indexOf('/m/')===0){d.dataset.theme='light';d.dataset.public='1';return;}var t=JSON.parse(localStorage.getItem(${JSON.stringify(themeCacheKey)})||'null');if(!t)return;d.dataset.theme=t.mode==='AUTO'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t.mode==='LIGHT'?'light':'dark';d.dataset.primary=String(t.primary).toLowerCase();d.dataset.sidebar=String(t.sidebar).toLowerCase();}catch(e){}})();`;
