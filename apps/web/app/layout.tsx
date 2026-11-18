import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'RM Restaurant SaaS',
  description: 'ERP SaaS multiempresa para restaurantes',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body className="bg-[var(--rm-workspace)] text-neutral-100">{children}</body>
    </html>
  );
}
