'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, errorMessage, formatDateTime, isAdminApp, type Tenant } from '../../lib/api';
import { outcomeLabels, outcomeTone, statusLabels, type Capabilities, type SessionDetail, type SessionListItem } from '../../lib/types-migration';
import { AppShell, buttonClass, Check, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs } from '../../components/ui';
import dynamic from 'next/dynamic';
import { PanelSkeleton } from '../../components/ui';
const AuditStep = dynamic(() => import('../../components/migration/audit-step').then(module => module.AuditStep), { loading: () => <PanelSkeleton lines={5} /> });
const FilesStep = dynamic(() => import('../../components/migration/files-step').then(module => module.FilesStep), { loading: () => <PanelSkeleton lines={5} /> });
const MappingStep = dynamic(() => import('../../components/migration/mapping-step').then(module => module.MappingStep), { loading: () => <PanelSkeleton lines={5} /> });
const PreviewStep = dynamic(() => import('../../components/migration/preview-step').then(module => module.PreviewStep), { loading: () => <PanelSkeleton lines={5} /> });
const RunStep = dynamic(() => import('../../components/migration/run-step').then(module => module.RunStep), { loading: () => <PanelSkeleton lines={5} /> });






const tabs = [{ key: 'files', label: '1 · Arquivos e análise' }, { key: 'mapping', label: '2 · Mapeamento' }, { key: 'preview', label: '3 · Pré-visualização' }, { key: 'run', label: '4 · Execução' }, { key: 'audit', label: '5 · Auditoria e relatório' }] as const;
type Tab = (typeof tabs)[number]['key'];
const stepFor = (status: string): Tab => ({ DRAFT: 'files', ANALYZED: 'mapping', PREVIEWED: 'preview', APPROVED: 'run', RUNNING: 'run', INTERRUPTED: 'run' } as Record<string, Tab>)[status] ?? 'audit';

function MigrationCenter({ initialTenant }: { initialTenant: string }) {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState(initialTenant);
  const [history, setHistory] = useState<SessionListItem[]>([]);
  const [historyView, setHistoryView] = useState({ page: 1, total: 0, status: '' });
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [tab, setTab] = useState<Tab>('files');
  const [form, setForm] = useState({ label: '', sourceSystem: '', sourceUnknown: false, unitId: '' });
  const [units, setUnits] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => { if (!tenantId) { setUnits([]); return; } api<{ items: Array<{ id: string; name: string }> }>(`/migrations/tenants/${tenantId}/units`).then(result => setUnits(result.items)).catch(() => setUnits([])); }, [tenantId]);
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const notify = useCallback((text: string, ok = false) => { setSuccess(ok); setMessage(text); }, []);
  const base = session ? `/migrations/tenants/${session.tenantId}/sessions/${session.id}` : '';

  useEffect(() => {
    let active = true;
    Promise.all([api<Capabilities>('/migrations/capabilities'), api<{ items: Tenant[] }>('/tenants')])
      .then(([capabilities, companies]) => { if (!active) return; setCaps(capabilities); setTenants(companies.items); })
      .catch(error => { if (active) notify(errorMessage(error, 'Falha ao carregar o motor de migração')); });
    return () => { active = false; };
  }, [notify]);

  const HISTORY_PAGE_SIZE = 25;
  const loadHistory = useCallback(async () => {
    if (!tenantId) { setHistory([]); return; }
    try {
      const query = new URLSearchParams({ page: String(historyView.page), pageSize: String(HISTORY_PAGE_SIZE), ...(historyView.status ? { status: historyView.status } : {}) });
      const result = await api<{ items: SessionListItem[]; total: number }>(`/migrations/tenants/${tenantId}/sessions?${query}`);
      setHistory(result.items); setHistoryView(current => current.total === result.total ? current : { ...current, total: result.total });
    } catch (error) { notify(errorMessage(error, 'Falha ao carregar o histórico')); }
  }, [tenantId, notify, historyView.page, historyView.status]);
  useEffect(() => { setSession(null); void loadHistory(); }, [loadHistory]);

  const reload = useCallback(async () => {
    if (!session) return;
    try { setSession(await api<SessionDetail>(`/migrations/tenants/${session.tenantId}/sessions/${session.id}`)); } catch (error) { notify(errorMessage(error, 'Falha ao atualizar a sessão')); }
  }, [session?.id, session?.tenantId, notify]); // eslint-disable-line react-hooks/exhaustive-deps

  async function open(id: string) {
    try { const detail = await api<SessionDetail>(`/migrations/tenants/${tenantId}/sessions/${id}`); setSession(detail); setTab(stepFor(detail.status)); setMessage(''); } catch (error) { notify(errorMessage(error, 'Falha ao abrir a sessão')); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    try {
      const created = await api<SessionDetail>(`/migrations/tenants/${tenantId}/sessions`, { method: 'POST', body: JSON.stringify({ label: form.label, sourceUnknown: form.sourceUnknown, unitId: form.unitId || null, ...(form.sourceSystem && !form.sourceUnknown ? { sourceSystem: form.sourceSystem } : {}) }) });
      setForm({ label: '', sourceSystem: '', sourceUnknown: false, unitId: '' }); await loadHistory(); await open(created.id);
    } catch (error) { notify(errorMessage(error, 'Falha ao criar a sessão')); }
  }
  // After each state change the panel moves to the step that needs attention.
  const statusKey = session?.status;
  useEffect(() => { if (statusKey) setTab(current => (statusKey === 'ANALYZED' && current === 'files') || ['PREVIEWED', 'APPROVED'].includes(statusKey) ? stepFor(statusKey) : current); }, [statusKey]);

  const tenant = tenants.find(item => item.id === tenantId);
  return <AppShell title="Migração de dados">
    <PageHeader title="RM SMART MIGRATION" subtitle="Central inteligente de migração de dados: leitura de arquivos e backups, mapeamento automático, conferência, execução segura e auditoria — sempre em um único restaurante por vez."
      actions={session ? <button type="button" className={secondaryButtonClass} onClick={() => { setSession(null); void loadHistory(); }}>‹ Todas as migrações</button> : undefined} />
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    {!session && <>
      <section className={`${panelClass} mb-4`}>
        <Select label="Restaurante de destino" value={tenantId} onChange={event => { setHistoryView({ page: 1, total: 0, status: '' }); setTenantId(event.target.value); }}><option value="">Selecione o restaurante…</option>{tenants.map(item => <option key={item.id} value={item.id}>{item.name} ({item.slug})</option>)}</Select>
        {caps && <p className="mt-2 text-xs text-slate-500">Motor v{caps.engineVersion}. Módulos migráveis nesta versão: {caps.entities.map(entity => entity.label).join(', ')}. Ainda fora do escopo: {caps.unsupportedModules.join('; ')}.</p>}
      </section>
      {tenantId && <>
        <section className={`${panelClass} mb-4`}><h3 className="mb-3 text-base font-semibold">Nova migração para {tenant?.name ?? 'o restaurante'}</h3>
          <form onSubmit={event => void create(event)} className="grid gap-3 md:grid-cols-3">
            <Field label="Identificação da migração" required minLength={2} placeholder="Ex.: Importação do sistema antigo" value={form.label} onChange={event => setForm({ ...form, label: event.target.value })} />
            <Field label="Sistema de origem" disabled={form.sourceUnknown} placeholder="Nome do sistema, se conhecido" value={form.sourceSystem} onChange={event => setForm({ ...form, sourceSystem: event.target.value })} />
            <Select label="Unidade de destino (vendas, financeiro, estoque inicial)" value={form.unitId} onChange={event => setForm({ ...form, unitId: event.target.value })}><option value="">Toda a empresa (sem unidade específica)</option>{units.map(unit => <option key={unit.id} value={unit.id}>{unit.name}</option>)}</Select>
            <div className="flex items-end gap-4"><Check label="Origem desconhecida" checked={form.sourceUnknown} onChange={event => setForm({ ...form, sourceUnknown: event.target.checked })} /><button className={buttonClass} disabled={!caps}>Criar sessão</button></div>
          </form></section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3"><h3 className="text-base font-semibold">Histórico de migrações ({historyView.total})</h3>
          <div className="w-56"><Select label="Filtrar por situação" value={historyView.status} onChange={event => setHistoryView({ page: 1, total: historyView.total, status: event.target.value })}><option value="">Todas</option>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></div></div>
        {history.length === 0 ? <EmptyState icon="🔄" title="Nenhuma migração para este restaurante" hint="Crie uma sessão acima para enviar arquivos e iniciar a análise." /> :
          <DataTable columns={[{ label: 'Migração' }, { label: 'Origem' }, { label: 'Situação' }, { label: 'Resultado' }, { label: 'Criada em' }, { label: '' }]}>
            {history.map(item => <tr key={item.id}><td className="font-medium">{item.label}</td><td>{item.sourceUnknown ? 'Desconhecida' : item.sourceSystem ?? '—'}</td><td><Badge tone="gold">{statusLabels[item.status]}</Badge></td><td>{item.outcome ? <Badge tone={outcomeTone(item.outcome)}>{outcomeLabels[item.outcome]}</Badge> : '—'}</td><td className="text-xs text-slate-500">{formatDateTime(item.createdAt)}</td><td className="text-right"><button type="button" className={secondaryButtonClass} onClick={() => void open(item.id)}>Abrir</button></td></tr>)}
          </DataTable>}
        {historyView.total > HISTORY_PAGE_SIZE && <div className="mt-2 flex items-center gap-2 text-xs text-slate-600"><button type="button" className={secondaryButtonClass} disabled={historyView.page <= 1} onClick={() => setHistoryView({ ...historyView, page: historyView.page - 1 })}>‹ Anteriores</button><span>Página {historyView.page} de {Math.ceil(historyView.total / HISTORY_PAGE_SIZE)}</span><button type="button" className={secondaryButtonClass} disabled={historyView.page * HISTORY_PAGE_SIZE >= historyView.total} onClick={() => setHistoryView({ ...historyView, page: historyView.page + 1 })}>Próximas ›</button></div>}
      </>}
    </>}
    {session && caps && <>
      <section className={`${panelClass} mb-4`}><div className="flex flex-wrap items-center gap-3"><h3 className="text-base font-semibold">{session.label}</h3><Badge tone="gold">{statusLabels[session.status]}</Badge>{session.outcome && <Badge tone={outcomeTone(session.outcome)}>{outcomeLabels[session.outcome]}</Badge>}<span className="text-sm text-slate-600">Restaurante: <b>{tenant?.name ?? session.tenantId}</b>{session.unitId ? ` · unidade: ${units.find(unit => unit.id === session.unitId)?.name ?? session.unitId.slice(0, 8)}` : ''} · origem: {session.sourceUnknown ? 'desconhecida' : session.sourceSystem ?? 'não informada'}</span></div></section>
      <Tabs tabs={tabs.map(item => ({ key: item.key, label: item.label }))} value={tab} onChange={setTab} label="Etapas da migração" />
      {(() => { const props = { base, session, caps, reload, notify }; return tab === 'files' ? <FilesStep {...props} /> : tab === 'mapping' ? <MappingStep {...props} /> : tab === 'preview' ? <PreviewStep {...props} /> : tab === 'run' ? <RunStep {...props} /> : <AuditStep {...props} />; })()}
    </>}
  </AppShell>;
}

function MigrationsRoute() {
  const params = useSearchParams();
  return <MigrationCenter initialTenant={params.get('tenantId') ?? ''} />;
}
// Second line of defence (the restaurant app already answers 404 in proxy.ts and the API requires MASTER_ADMIN): never render the module outside the RM Painel Admin.
export default function MigrationsPage() {
  if (!isAdminApp) return <main className="grid min-h-screen place-items-center p-6 text-center"><p className="text-sm text-slate-600">Esta área é exclusiva do RM Painel Admin.</p></main>;
  return <Suspense fallback={null}><MigrationsRoute /></Suspense>;
}
