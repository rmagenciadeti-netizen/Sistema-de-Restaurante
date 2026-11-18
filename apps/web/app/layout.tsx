import type { ReactNode } from 'react';
import './palettes.css';
import './globals.css';
import { ThemeProvider } from '../components/theme-provider';
import { themeBootScript } from '../lib/theme';

export const metadata = {
  title: 'RM Restaurant SaaS',
  description: 'ERP SaaS multiempresa para restaurantes',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR" data-theme="dark" data-primary="gold" data-sidebar="black" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootScript }} /></head>
      <body><ThemeProvider />{children}</body>
    </html>
  );
}
