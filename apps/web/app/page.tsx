'use client';

import { useEffect, useState } from 'react';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1';

type DashboardSummary = {
  totalCompanies?: number;
  activeCompanies?: number;
  trialCompanies?: number;
  suspendedCompanies?: number;
  users?: number;
  orders?: number;
  products?: number;
  note?: string;
};

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    async function load() {
      const token = localStorage.getItem('rm_restaurant_token');
      if (!token) {
        window.location.href = '/login';
        return;
      }

      try {
        const response = await fetch(`${apiBase}/dashboard/master`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          throw new Error('Sessão inválida ou expirada');
        }

        const payload = await response.json();
        setSummary(payload);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Erro ao carregar dashboard');
      } finally {
        setLoading(false);
      }
    }

    load();
  }, []);

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-200">Carregando dashboard...</div>;
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-red-300">
        {error}
      </div>
    );
  }

  const cards = [
    { label: 'Empresas cadastradas', value: summary?.totalCompanies ?? 0 },
    { label: 'Empresas ativas', value: summary?.activeCompanies ?? 0 },
    { label: 'Teste', value: summary?.trialCompanies ?? 0 },
    { label: 'Suspensas', value: summary?.suspendedCompanies ?? 0 },
    { label: 'Usuários', value: summary?.users ?? 0 },
    { label: 'Pedidos', value: summary?.orders ?? 0 },
    { label: 'Produtos', value: summary?.products ?? 0 },
  ];

  return (
    <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex items-center justify-between border-b border-slate-800 pb-6">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-blue-400">Painel Master</p>
            <h1 className="mt-2 text-3xl font-bold">RM Restaurant SaaS</h1>
          </div>
          <button
            onClick={() => {
              localStorage.removeItem('rm_restaurant_token');
              localStorage.removeItem('rm_restaurant_user');
              window.location.href = '/login';
            }}
            className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Sair
          </button>
        </header>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((card) => (
            <div key={card.label} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 shadow-lg">
              <div className="text-sm text-slate-400">{card.label}</div>
              <div className="mt-4 text-3xl font-bold text-white">{card.value}</div>
            </div>
          ))}
        </section>

        <section className="mt-8 rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <h2 className="text-xl font-semibold text-white">Resumo do sistema</h2>
          <p className="mt-3 text-sm text-slate-300">
            {summary?.note ?? 'Painel operacional com foco em multiempresa, unidades, produtos e pedidos.'}
          </p>
        </section>
      </div>
    </main>
  );
}
