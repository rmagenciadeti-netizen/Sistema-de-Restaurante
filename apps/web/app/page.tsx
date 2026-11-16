const modules = [
  'Master SaaS',
  'Empresas e unidades',
  'Funcionários e permissões',
  'PDV e comandas',
  'Cardápio e delivery',
  'Produção e KDS',
  'Estoque e compras',
  'Financeiro e fiscal',
  'CRM e WhatsApp',
  'Relatórios e auditoria',
];

export default function HomePage() {
  return (
    <main className="min-h-screen p-10">
      <div className="mx-auto max-w-6xl">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-sm">
          <p className="mb-4 text-sm font-medium uppercase tracking-[0.2em] text-blue-300">
            RM Restaurant SaaS
          </p>

          <h1 className="text-4xl font-bold text-white md:text-6xl">
            ERP modular para restaurantes em escala.
          </h1>

          <p className="mt-6 max-w-3xl text-lg text-slate-300">
            Plataforma preparada para multiempresa, multiunidade, PDV, delivery, produção,
            financeiro, WhatsApp, CRM e gestão SaaS com controle de custos e autonomia técnica.
          </p>

          <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {modules.map((module) => (
              <div
                key={module}
                className="rounded-xl border border-blue-500/20 bg-slate-900/50 p-4 text-sm text-slate-200 shadow-md"
              >
                {module}
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
