'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const tabs = [
  { href: '/monitor', label: 'Pedidos', icon: '🧾' },
  { href: '/comandas', label: 'Comandas', icon: '🪑' },
  { href: '/pdv', label: 'PDV', icon: '🛒' },
];
const extras = [{ href: '/scheduled', label: 'Agendadas' }, { href: '/history', label: 'Histórico' }];

// Counter-side switcher shared by the operation screens: three large tabs plus quick links to schedule and history.
export function OpsNav() {
  const pathname = usePathname();
  return <nav aria-label="Operação de balcão" className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-neutral-950 p-2 shadow-md print:hidden">
    <div className="flex flex-1 gap-1">
      {tabs.map(tab => <Link key={tab.href} href={tab.href} aria-current={pathname === tab.href ? 'page' : undefined} className={`flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-bold transition sm:flex-none sm:px-8 ${pathname === tab.href ? 'bg-brand-500 text-neutral-950 shadow' : 'text-neutral-200 hover:bg-white/10'}`}><span aria-hidden="true">{tab.icon}</span>{tab.label}</Link>)}
    </div>
    <div className="flex gap-1">
      {extras.map(link => <Link key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined} className={`flex min-h-12 items-center rounded-xl px-3 text-xs font-semibold transition ${pathname === link.href ? 'bg-white/15 text-brand-300' : 'text-neutral-300 hover:bg-white/10'}`}>{link.label}</Link>)}
    </div>
  </nav>;
}
