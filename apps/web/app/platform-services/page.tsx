'use client';

import { useState } from 'react';
import { api, errorMessage, formatDateTime } from '../../lib/api';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, StatCard } from '../../components/ui';

type Preset = { key: string; label: string; baseUrl: string; suggestedModel: string; kind: string };
type AiStatus = { status: 'NOT_CONFIGURED' | 'CONFIGURED_UNVERIFIED' | 'VERIFIED' | 'FAILED'; source: string; provider: string | null; model: string | null; baseUrl: string | null; validatedAt: string | null; lastError: string | null; keyStored: boolean; environmentConfigured: boolean; presets: Preset[]; note: string };
type WaOverview = { managerOnline: boolean; managerHost: string | null; summary: { total: number; connected: number; waitingQr: number; connecting: number; problems: number }; items: { tenantId: string; name: string; slug: string; status: string; phone: string | null; lastError: string | null; connectedAt: string | null }[] };
const statusTone = { NOT_CONFIGURED: 'neutral', CONFIGURED_UNVERIFIED: 'amber', VERIFIED: 'green', FAILED: 'red' } as const;
const statusText = { NOT_CONFIGURED: 'Não configurada', CONFIGURED_UNVERIFIED: 'Configurada, não validada', VERIFIED: 'Validada com chamada real', FAILED: 'Falha na validação' } as const;
const waStatus: Record<string, string> = { CONNECTED: 'Conectado', QR_READY: 'Aguardando QR', CONNECTING: 'Conectando', DISCONNECTED: 'Desconectado', LOGGED_OUT: 'Sessão encerrada', ERROR: 'Erro' };

// RM Painel Admin: platform services. The AI provider is chosen here (key stored encrypted, never shown again) and proven with a real call;
// the WhatsApp (QR) sessions of every restaurant are monitored. No credentials are displayed.
export default function PlatformServicesPage() {
  const [ai, setAi] = useState<AiStatus | null>(null);
  const [wa, setWa] = useState<WaOverview | null>(null);
  const [form, setForm] = useState({ provider: 'openai', model: '', baseUrl: '', apiKey: '' });
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (cause: unknown, fallback: string) => setNotice({ text: errorMessage(cause, fallback), kind: 'error' });

  async function load() {
    try {
      const status = await api<AiStatus>('/platform/ai');
      setAi(status);
      setForm(current => ({ ...current, provider: status.provider ?? current.provider, model: status.model ?? current.model, baseUrl: status.baseUrl ?? '' }));
    } catch (cause) { fail(cause, 'Falha ao carregar o provedor de IA'); }
    try { setWa(await api<WaOverview>('/tenants/whatsapp/sessions')); } catch { setWa(null); }
  }
  useAutoLoad(load, 30_000);

  const preset = ai?.presets.find(item => item.key === form.provider);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const result = await api<AiStatus>('/platform/ai', { method: 'PUT', body: JSON.stringify({ provider: form.provider, model: form.model, baseUrl: form.baseUrl || null, ...(form.apiKey ? { apiKey: form.apiKey } : {}) }) });
      setAi(result); setForm(current => ({ ...current, apiKey: '' })); setNotice({ text: 'Provedor salvo. Use "Testar conexão" para validar com uma chamada real.', kind: 'success' });
    } catch (cause) { fail(cause, 'Falha ao salvar'); } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setNotice(null);
    try {
      const result = await api<{ ok: boolean; latencyMs: number }>('/platform/ai/test', { method: 'POST' });
      setNotice({ text: `Conexão validada em ${result.latencyMs} ms.`, kind: 'success' });
    } catch (cause) { fail(cause, 'O teste falhou'); } finally { setBusy(false); await load(); }
  }
  async function remove() {
    if (!window.confirm('Remover a configuração de IA salva no painel? Se houver variáveis de ambiente (AI_API_KEY/AI_MODEL), elas passam a valer.')) return;
    try { setAi(await api<AiStatus>('/platform/ai', { method: 'DELETE' })); setNotice({ text: 'Configuração removida.', kind: 'success' }); } catch (cause) { fail(cause, 'Falha ao remover'); }
  }

  return <AppShell title="Serviços da plataforma">
    <PageHeader title="Serviços da plataforma" subtitle="Provedor de IA e monitoramento do WhatsApp (QR Code) de todos os restaurantes. Chaves ficam criptografadas no servidor e nunca são exibidas." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <section className={`${panelClass} mb-6`}>
      <div className="mb-3 flex flex-wrap items-center gap-3"><h2 className="text-base font-bold">Provedor de IA</h2>{ai && <Badge tone={statusTone[ai.status]}>{statusText[ai.status]}</Badge>}{ai && ai.source !== 'none' && <Badge tone="blue">{ai.source === 'platform' ? 'Salvo no painel' : ai.source === 'environment' ? 'Variáveis do servidor' : ai.source}</Badge>}</div>
      {ai && <p className="mb-3 text-sm text-slate-600">{ai.note}{ai.lastError ? ` Último erro: ${ai.lastError}` : ''}{ai.validatedAt ? ` Validada em ${formatDateTime(ai.validatedAt)}.` : ''}</p>}
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Select label="Provedor" value={form.provider} onChange={event => { const next = ai?.presets.find(item => item.key === event.target.value); setForm({ ...form, provider: event.target.value, model: next?.suggestedModel ?? form.model, baseUrl: '' }); }}>{ai?.presets.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</Select>
        <Field label="Modelo" required value={form.model} onChange={event => setForm({ ...form, model: event.target.value })} />
        <Field label={preset?.key === 'custom' ? 'Endereço da API (https)' : 'Endereço da API (opcional)'} required={preset?.key === 'custom'} placeholder={preset?.baseUrl || 'https://…/v1'} value={form.baseUrl} onChange={event => setForm({ ...form, baseUrl: event.target.value })} />
        <Field label={ai?.keyStored ? 'Nova chave de API (deixe em branco para manter a atual)' : 'Chave de API'} type="password" autoComplete="off" required={!ai?.keyStored} value={form.apiKey} onChange={event => setForm({ ...form, apiKey: event.target.value })} />
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2"><button className={buttonClass} disabled={busy}>Salvar</button><button type="button" className={secondaryButtonClass} disabled={busy || !ai || ai.status === 'NOT_CONFIGURED'} onClick={() => void test()}>Testar conexão</button>{ai?.keyStored && <button type="button" className={secondaryButtonClass} onClick={() => void remove()}>Remover do painel</button>}</div>
      </form>
      <p className="mt-2 text-xs text-slate-500">O provedor vale para toda a plataforma. Cada restaurante ainda precisa dar consentimento para IA externa, e há limites de uso por empresa, usuário e módulo.</p>
    </section>
    <section className={panelClass}>
      <div className="mb-3 flex flex-wrap items-center gap-3"><h2 className="text-base font-bold">WhatsApp (QR Code) — sessões</h2>{wa && <Badge tone={wa.managerOnline ? 'green' : 'red'}>{wa.managerOnline ? 'Serviço de sessões ativo' : 'Serviço de sessões parado'}</Badge>}</div>
      {!wa ? <EmptyState title="Sem dados" /> : <>
        <div className="mb-4 grid gap-3 sm:grid-cols-4"><StatCard label="Sessões" value={wa.summary.total} /><StatCard label="Conectadas" value={wa.summary.connected} /><StatCard label="Aguardando QR" value={wa.summary.waitingQr} /><StatCard label="Com problema" value={wa.summary.problems} /></div>
        {wa.items.length === 0 ? <EmptyState title="Nenhum restaurante iniciou uma conexão" /> : <DataTable columns={[{ label: 'Empresa' }, { label: 'Situação' }, { label: 'Número' }, { label: 'Conectado desde' }, { label: 'Último erro' }]}>
          {wa.items.map(item => <tr key={item.tenantId}><td>{item.name}<div className="text-xs text-slate-500">{item.slug}</div></td><td>{waStatus[item.status] ?? item.status}</td><td>{item.phone ?? '—'}</td><td>{item.connectedAt ? formatDateTime(item.connectedAt) : '—'}</td><td className="text-xs">{item.lastError ?? '—'}</td></tr>)}
        </DataTable>}
      </>}
    </section>
  </AppShell>;
}
