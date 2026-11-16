export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-950 px-6 text-slate-100">
      <div className="max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 p-10 text-center shadow-2xl">
        <p className="text-xs uppercase tracking-[0.35em] text-blue-400">RM Restaurant SaaS</p>
        <h1 className="mt-5 text-4xl font-bold text-white md:text-6xl">ERP modular para restaurantes</h1>
        <p className="mt-5 text-base text-slate-300 md:text-lg">
          Multiempresa, PDV, produção, delivery, financeiro, fiscal, WhatsApp e dashboard do proprietário em uma mesma plataforma.
        </p>
        <div className="mt-8 flex justify-center gap-4">
          <a href="/login" className="rounded-xl bg-blue-600 px-6 py-3 font-semibold text-white transition hover:bg-blue-500">
            Entrar
          </a>
          <a href="/dashboard" className="rounded-xl border border-slate-700 bg-slate-800 px-6 py-3 font-semibold text-slate-200 transition hover:bg-slate-700">
            Dashboard
          </a>
        </div>
      </div>
    </main>
  );
}
