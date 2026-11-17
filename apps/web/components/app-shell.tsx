'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

const links = [
  { href: '/dashboard', label: 'Visão geral' },
  { href: '/companies', label: 'Empresas' },
  { href: '/units', label: 'Unidades' },
  { href: '/employees', label: 'Funcionários' },
  { href: '/products', label: 'Produtos e produção' },
  { href: '/inventory', label: 'Estoque e fichas' },
  { href: '/catalog', label: 'Adicionais e combos' },
  { href: '/orders', label: 'Pedidos / PDV' },
  { href: '/tables', label: 'Mesas e QR Code' },
  { href: '/kds', label: 'Cozinha (KDS)' },
  { href: '/production', label: 'Produção e impressão' },
  { href: '/delivery', label: 'Entregas' },
  { href: '/reservations', label: 'Reservas' },
  { href: '/customers', label: 'Clientes (CRM)' },
  { href: '/coupons', label: 'Cupons e promoções' },
  { href: '/purchasing', label: 'Compras e fornecedores' },
  { href: '/cash', label: 'Caixa e pagamentos' },
];

export function AppShell({ title, children }: { title: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<{ name?: string; role?: string } | null>(null);

  useEffect(() => {
    const token = localStorage.getItem('rm_restaurant_token');
    if (!token) { router.replace('/login'); return; }
    try { setUser(JSON.parse(localStorage.getItem('rm_restaurant_user') ?? '{}')); } catch { setUser({}); }
  }, [router]);

  function signOut() {
    localStorage.removeItem('rm_restaurant_token');
    localStorage.removeItem('rm_restaurant_user');
    router.replace('/login');
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 md:flex print:bg-white print:text-black">
      <aside className="print:hidden w-full border-b border-slate-800 bg-slate-900 p-5 md:min-h-screen md:w-64 md:border-b-0 md:border-r">
        <Link href="/dashboard" className="text-lg font-bold text-white">RM <span className="text-blue-400">Restaurant</span></Link>
        <p className="mt-1 text-xs text-slate-500">Gestão integrada</p>
        <nav className="mt-7 grid grid-cols-2 gap-2 md:grid-cols-1">
          {links.map((link) => <Link key={link.href} href={link.href} className={`rounded-lg px-3 py-2 text-sm ${pathname === link.href ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800'}`}>{link.label}</Link>)}
        </nav>
        <div className="mt-6 border-t border-slate-800 pt-4 text-xs text-slate-400">
          <div className="truncate">{user?.name ?? 'Usuário autenticado'}</div>
          <div className="mt-1">{user?.role ?? ''}</div>
          <button onClick={signOut} className="mt-4 text-blue-300 hover:text-white">Sair</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-5 md:p-8 print:p-0">
        <header className="mb-7 print:hidden border-b border-slate-800 pb-5"><p className="text-xs uppercase tracking-[0.25em] text-blue-400">RM Restaurant SaaS</p><h1 className="mt-2 text-2xl font-bold text-white">{title}</h1></header>
        {children}
      </main>
    </div>
  );
}

export function Notice({ message, kind = 'error' }: { message: string; kind?: 'error' | 'success' }) {
  return <div role="status" className={`mb-4 rounded-lg border px-4 py-3 text-sm ${kind === 'error' ? 'border-red-500/40 bg-red-500/10 text-red-200' : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'}`}>{message}</div>;
}

export function Field({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="block text-sm text-slate-300">{label}<input {...props} className={`mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-blue-500 ${props.className ?? ''}`} /></label>;
}

export const inputClass = 'mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-white outline-none focus:border-blue-500';
export const secondaryButtonClass = 'rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50';

export function Select({ label, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  return <label className="block text-sm text-slate-300">{label}<select {...props} className={`${inputClass} ${props.className ?? ''}`}>{children}</select></label>;
}

export function Check({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return <label className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" {...props} className="h-4 w-4 accent-blue-600" />{label}</label>;
}

export const panelClass = 'rounded-xl border border-slate-800 bg-slate-900 p-5';
export const buttonClass = 'rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50';
