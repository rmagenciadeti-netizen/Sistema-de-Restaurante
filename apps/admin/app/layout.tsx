import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RM Painel Admin',
  description: 'Administração central do ecossistema RM Restaurant SaaS',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
