'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from '../../components/nav-link';
import { api, errorMessage, type Tenant } from '../../lib/api';
import { pathsOfModule } from '../../lib/menu-catalog';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Check, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, EmptyState, PageHeader } from '../../components/ui';

type ModuleRow = { key: string; name: string; description: string | null; category: string; dependsOn: string[]; globallyBlocked: boolean; enabled: boolean; source: string | null; apiRoutes: string[] };
type View = { tenant: { id: string; name: string; status: string }; restricted: boolean; license: { status: string; validUntil: string | null; planId: string | null } | null; modules: ModuleRow[] };

// Simple module management: choose the company, tick or untick modules, save. Keys, API routes and pages are linked automatically from the catalog.
export default function CompanyModulesPage() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [view, setView] = useState<View | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState(false);

  useAutoLoad(async () => {
    try { setTenants((await api<{ items: Tenant[] }>('/tenants')).items); } catch (cause) { setNotice({ text: errorMessage(cause, 'Erro ao carregar as empresas'), kind: 'error' }); }
  });

  const load = useCallback(async (id: string) => {
    setTenantId(id); setView(null); setNotice(null);
    if (!id) return;
    try {
      const result = await api<View>(`/tenants/${id}/modules`);
      const enabled = new Set(result.modules.filter(item => item.enabled).map(item => item.key));
      setView(result); setSelected(enabled); setSaved(enabled);
    } catch (cause) { setNotice({ text: errorMessage(cause, 'Erro ao carregar os módulos da empresa'), kind: 'error' }); }
  }, []);

  const byKey = useMemo(() => new Map((view?.modules ?? []).map(item => [item.key, item])), [view]);
  const categories = useMemo(() => Array.from(new Set((view?.modules ?? []).map(item => item.category))), [view]);
  const dirty = selected.size !== saved.size || Array.from(selected).some(key => !saved.has(key));

  // Ticking a module also ticks what it depends on; unticking one also unticks what depends on it.
  function toggle(key: string, on: boolean) {
    setSelected(current => {
      const next = new Set(current);
      const addWithDependencies = (item: string) => { if (next.has(item)) return; next.add(item); byKey.get(item)?.dependsOn.forEach(addWithDependencies); };
      const removeWithDependents = (item: string) => { next.delete(item); for (const other of view?.modules ?? []) if (other.dependsOn.includes(item) && next.has(other.key)) removeWithDependents(other.key); };
      if (on) addWithDependencies(key); else removeWithDependents(key);
      return next;
    });
  }

  async function save() {
    setBusy(true); setNotice(null);
    try {
      await api(`/tenants/${tenantId}/modules`, { method: 'PUT', body: JSON.stringify({ modules: Array.from(selected), reason: 'Liberação de módulos pelo painel' }) });
      setNotice({ text: 'Módulos salvos. A liberação já vale para a empresa.', kind: 'success' }); await load(tenantId);
    } catch (cause) { setNotice({ text: errorMessage(cause, 'Erro ao salvar os módulos'), kind: 'error' }); } finally { setBusy(false); }
  }

  return <AppShell title="Módulos por empresa">
    <PageHeader title="Módulos por empresa" subtitle="Escolha a empresa, marque os módulos e salve. Cada módulo já traz sua chave, as páginas e as rotas da API que ele libera; a validação é feita no servidor, conforme a licença do cliente." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      <div className="max-w-md"><Select label="Empresa" value={tenantId} onChange={event => void load(event.target.value)}><option value="">Selecione…</option>{tenants.map(item => <option key={item.id} value={item.id}>{item.name} ({item.slug})</option>)}</Select></div>
      {view && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={view.license?.status === 'ACTIVE' ? 'green' : view.license ? 'red' : 'neutral'}>{view.license ? `Licença ${view.license.status}` : 'Sem licença (todos os módulos abertos)'}</Badge>
        {view.license?.validUntil && <span className="text-xs text-slate-500">válida até {new Date(view.license.validUntil).toLocaleDateString('pt-BR')}</span>}
        <Link href="/licenses" className="ml-auto text-xs font-semibold text-brand-700 underline">Plano, valores, vencimento e limites</Link>
      </div>}
    </section>
    {view && (view.modules.length === 0 ? <EmptyState title="Nenhum módulo no catálogo" /> : <>
      {!view.restricted && <Notice message="Esta empresa ainda não tem licença: todos os módulos estão abertos. Ao salvar, a seleção abaixo passa a valer e o servidor bloqueia o que estiver desmarcado." />}
      {categories.map(category => <section key={category} className={`${panelClass} mb-4`}>
        <h2 className="mb-3 text-base font-bold">{category}</h2>
        <div className="grid gap-3 md:grid-cols-2">{view.modules.filter(item => item.category === category).map(item => <div key={item.key} className={`rounded-xl border p-3 ${selected.has(item.key) ? 'border-brand-400 bg-brand-50/40' : 'border-slate-200'}`}>
          <Check label={item.name} checked={selected.has(item.key)} disabled={item.globallyBlocked} onChange={event => toggle(item.key, event.target.checked)} />
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500"><Badge>{item.key}</Badge>{item.globallyBlocked && <Badge tone="red">Bloqueado na plataforma</Badge>}{item.source && <Badge tone="blue">{item.source === 'ADDON' ? 'Adicional' : 'Do plano'}</Badge>}</div>
          {item.description && <p className="mt-1 text-xs text-slate-600">{item.description}</p>}
          {item.dependsOn.length > 0 && <p className="mt-1 text-xs text-slate-500">Depende de: {item.dependsOn.map(key => byKey.get(key)?.name ?? key).join(', ')}</p>}
          <p className="mt-1 text-xs text-slate-500">Páginas: {pathsOfModule(item.key).join(', ') || '—'} · API: {item.apiRoutes.join(', ') || '—'}</p>
        </div>)}</div>
      </section>)}
      <div className="sticky bottom-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
        <span className="text-sm text-slate-600">{selected.size} de {view.modules.length} módulos marcados{dirty ? ' · alterações não salvas' : ''}</span>
        <button type="button" className={`${secondaryButtonClass} ml-auto`} onClick={() => setSelected(new Set(view.modules.filter(item => !item.globallyBlocked).map(item => item.key)))}>Marcar todos</button>
        <button type="button" className={secondaryButtonClass} onClick={() => setSelected(new Set(saved))} disabled={!dirty}>Desfazer</button>
        <button type="button" className={buttonClass} onClick={() => void save()} disabled={busy || !dirty}>{busy ? 'Salvando…' : 'Salvar módulos'}</button>
      </div>
    </>)}
  </AppShell>;
}
