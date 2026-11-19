import type { ReactNode } from 'react';
import './palettes.css';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';
import { PwaRegister } from '../components/pwa-register';
import { themeBootScript } from '../lib/theme';

export const metadata = {
  title: 'RM Restaurant SaaS',
  description: 'ERP SaaS multiempresa para restaurantes',
  manifest: '/manifest.webmanifest',
  icons: { apple: '/icons/apple-touch-icon.png' },
  appleWebApp: { capable: true, title: 'RM Restaurant', statusBarStyle: 'black-translucent' as const },
};
export const viewport = { themeColor: '#0b0a08', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR" data-theme="dark" data-primary="gold" data-sidebar="black" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
      <body><ThemeProvider /><PwaRegister />{children}</body>
    </html>
  );
}
