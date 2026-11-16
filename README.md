const modules = [
  {
    title: 'Master SaaS',
    description: 'Dashboard administrativo do proprietário',
    icon: '📊',
  },
  {
    title: 'Empresas e Unidades',
    description: 'Multiempresa, multiunidade e isolamento por tenant',
    icon: '🏢',
  },
  {
    title: 'Funcionários e Permissões',
    description: 'Cargos, escalas, comissões e acessos granulares',
    icon: '👥',
  },
  {
    title: 'PDV e Comandas',
    description: 'Caixas, mesas, pedidos e fechamento operacional',
    icon: '🧾',
  },
  {
    title: 'Produtos e Produção',
    description: 'Cardápio, setor de produção, KDS e impressão inteligente',
    icon: '🍽️',
  },
  {
    title: 'Delivery e CRM',
    description: 'WhatsApp, clientes, entregadores e canais digitais',
    icon: '📦',
  },
];

const overview = [
  { label: 'Empresas ativas', value: '194' },
  { label: 'Mês de receita', value: 'R$ 89.2k' },
  { label: 'Pedidos', value: '68.4k' },
  { label: 'Notas fiscais', value: '12.8k' },
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-slate-950 p-8 text-slate-100">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex items-center justify-between border-b border-slate-800 pb-6">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-blue-400">RM Restaurant SaaS</p>
            <h1 className="mt-2 text-3xl font-bold">ERP completo para restaurantes</h1>
          </div>
          <div className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-sm text-emerald-300">
            Sistema operacional online
          </div>
        </header>

        <section className="mb-8 grid gap-4 md:grid-cols-4">
          {overview.map((item) => (
            <div key={item.label} className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-lg">
              <div className="text-sm text-slate-400">{item.label}</div>
              <div className="mt-3 text-2xl font-bold text-white">{item.value}</div>
            </div>
          ))}
        </section>

        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {modules.map((module) => (
            <div key={module.title} className="rounded-2xl border border-slate-800 bg-slate-900 p-5 transition hover:border-blue-500/60 hover:bg-slate-800">
              <div className="mb-4 text-3xl">{module.icon}</div>
              <h2 className="text-xl font-semibold text-white">{module.title}</h2>
              <p className="mt-2 text-sm text-slate-300">{module.description}</p>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
