'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '../../lib/api';
import { AppShell, Notice, panelClass } from '../../components/app-shell';

type Summary = { totalCompanies?: number; activeCompanies?: number; trialCompanies?: number; suspendedCompanies?: number; users?: number; orders?: number; products?: number; employees?: number; openOrders?: number; note?: string };
export default function DashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null); const [error, setError] = useState(''); const router = useRouter();
  useEffect(() => { const user = (() => { try { return JSON.parse(localStorage.getItem('rm_restaurant_user') ?? '{}'); } catch { return {}; } })(); const endpoint = user.role === 'MASTER_ADMIN' ? '/dashboard/master' : '/dashboard/restaurant'; api<Summary>(endpoint).then(setSummary).catch(e => { if (e instanceof Error && (e as { status?: number }).status === 401) router.replace('/login'); else setError(e instanceof Error ? e.message : 'Erro ao carregar painel'); }); }, [router]);
  const isMaster = typeof window !== 'undefined' && (() => { try { return JSON.parse(localStorage.getItem('rm_restaurant_user') ?? '{}').role === 'MASTER_ADMIN'; } catch { return false; } })();
  const cards = isMaster ? [['Empresas', summary?.totalCompanies], ['Ativas', summary?.activeCompanies], ['Em teste', summary?.trialCompanies], ['Suspensas', summary?.suspendedCompanies], ['Usuários', summary?.users], ['Pedidos', summary?.orders]] : [['Produtos ativos', summary?.products], ['Funcionários', summary?.employees], ['Pedidos', summary?.orders], ['Pedidos abertos', summary?.openOrders]];
  return <AppShell title={isMaster ? 'Painel Master' : 'Painel do restaurante'}>
    {error && <Notice message={error} />}
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{cards.map(([label, value]) => <article key={String(label)} className={panelClass}><p className="text-sm text-slate-400">{label}</p><p className="mt-3 text-3xl font-bold">{value ?? '—'}</p></article>)}</section>
    {summary?.note && <p className="mt-5 text-sm text-slate-400">{summary.note}</p>}
    <section className={`${panelClass} mt-6`}><h2 className="text-lg font-semibold">Atalhos operacionais</h2><p className="mt-2 text-sm text-slate-400">Use a navegação para gerenciar empresas, unidades, equipe, catálogo, produção e pedidos. Os dados apresentados vêm da API e do PostgreSQL.</p></section>
  </AppShell>;
}
