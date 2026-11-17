'use client';

import { Suspense, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, storedUser } from '../../lib/api';
import type { SettingsResponse, TenantSettings } from '../../lib/settings';
import { MANAGEMENT_ROLES } from '../../lib/settings-helpers';
import type { WhatsappSession, WhatsappStats } from '../../lib/types-whatsapp';
import { useAutoLoad } from '../../lib/use-auto-load';
import { AppShell, Notice } from '../../components/app-shell';
import { PageHeader, StatCard, Tabs } from '../../components/ui';
import { AutoMessagesTab } from '../../components/whatsapp/auto-messages-tab';
import { BotSettingsPanel } from '../../components/whatsapp/bot-settings-panel';
import { Flash, friendlyError } from '../../components/whatsapp/common';
import { ConnectionTab } from '../../components/whatsapp/connection-tab';
import { ConversationsTab } from '../../components/whatsapp/conversations-tab';
import { GeneralSwitches } from '../../components/whatsapp/general-switches';
import { KnowledgePanel } from '../../components/whatsapp/knowledge-panel';
import { OutboxTab } from '../../components/whatsapp/outbox-tab';
import { SimulatorTab } from '../../components/whatsapp/simulator-tab';

type WhatsappSettings = TenantSettings['whatsapp'];
const tabs = [
  { key: 'connection', label: 'Conexão' },
  { key: 'conversations', label: 'Conversas' },
  { key: 'auto', label: 'Mensagens automáticas' },
  { key: 'bot', label: 'Robô e conhecimento' },
  { key: 'simulator', label: 'Testar robô' },
  { key: 'outbox', label: 'Caixa de saída' },
] as const;
type TabKey = (typeof tabs)[number]['key'];
const isTab = (value: string | null): value is TabKey => tabs.some(tab => tab.key === value);
const count = (value: number | undefined) => (value === undefined ? '—' : value);

function WhatsappCenter() {
  const params = useSearchParams();
  const initial = params.get('tab');
  const [tab, setTab] = useState<TabKey>(isTab(initial) ? initial : 'connection');
  const [session, setSession] = useState<WhatsappSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [stats, setStats] = useState<WhatsappStats | null>(null);
  const [wa, setWa] = useState<WhatsappSettings | null>(null);
  const [role, setRole] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Flash>(null);
  const waRef = useRef<WhatsappSettings | null>(null);
  const sessionInFlight = useRef(false);
  const statsInFlight = useRef(false);

  async function loadSession() {
    if (sessionInFlight.current) return;
    sessionInFlight.current = true;
    try { setSession(await api<WhatsappSession>('/whatsapp/session')); setSessionError(null); } catch (e) { setSessionError(friendlyError(e, 'Erro ao carregar o status da conexão')); } finally { sessionInFlight.current = false; }
  }
  async function loadStats() {
    if (statsInFlight.current) return;
    statsInFlight.current = true;
    try { setStats(await api<WhatsappStats>('/whatsapp/stats')); } catch { /* os cartões ficam com "—" */ } finally { statsInFlight.current = false; }
  }
  async function loadSettings() {
    try {
      const result = await api<SettingsResponse>('/settings');
      const value = { ...result.settings.whatsapp, autoMessagesEnabled: result.settings.whatsapp.autoMessagesEnabled ?? true };
      waRef.current = value; setWa(value); setRole(storedUser().role);
    } catch (e) { setNotice({ text: friendlyError(e, 'Erro ao carregar as configurações do robô'), kind: 'error' }); }
  }

  const polling = tab === 'connection' && (session?.status === 'CONNECTING' || session?.status === 'QR_READY');
  useAutoLoad(loadSession, polling ? 2000 : 10000);
  useAutoLoad(loadStats, 15000);
  useAutoLoad(loadSettings);

  async function saveWhatsapp(change: Partial<WhatsappSettings>, successText = 'Configuração salva.') {
    const previous = waRef.current;
    if (!previous) return false;
    const optimistic = { ...previous, ...change };
    waRef.current = optimistic; setWa(optimistic); setSaving(true); setNotice(null);
    try {
      const result = await api<{ section: string; value: WhatsappSettings }>('/settings/whatsapp', { method: 'PUT', body: JSON.stringify(optimistic) });
      const value = { ...optimistic, ...result.value };
      waRef.current = value; setWa(value); setNotice({ text: successText, kind: 'success' });
      return true;
    } catch (e) {
      waRef.current = previous; setWa(previous); setNotice({ text: friendlyError(e, 'Não foi possível salvar a configuração'), kind: 'error' });
      return false;
    } finally { setSaving(false); }
  }

  function changeTab(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href); url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url);
  }

  const canEdit = MANAGEMENT_ROLES.includes(role ?? '');
  const autoMessagesEnabled = wa?.autoMessagesEnabled ?? true;

  return <>
    <PageHeader title="WhatsApp e robô de atendimento" subtitle="Conecte o número do restaurante, acompanhe as conversas, ajuste as mensagens automáticas e ensine o robô." />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <StatCard label="Conversas" value={count(stats?.conversations)} />
      <StatCard label="Recebidas hoje" value={count(stats?.inboundToday)} />
      <StatCard label="Respostas do robô hoje" value={count(stats?.botRepliesToday)} />
      <StatCard label="Aguardando atendente" value={count(stats?.handoffOpen)} tone={stats && stats.handoffOpen > 0 ? 'dark' : 'default'} />
      <StatCard label="Sem resposta" value={count(stats?.unanswered)} hint="perguntas que o robô não soube" />
      <StatCard label="Na fila de envio" value={count(stats?.outboundQueued)} />
    </div>
    <GeneralSwitches settings={wa} saving={saving} canEdit={canEdit} aiConfigured={session?.aiConfigured} onChange={change => void saveWhatsapp(change)} />
    <Tabs tabs={[...tabs]} value={tab} onChange={changeTab} label="Seções do WhatsApp" />
    {tab === 'connection' && <ConnectionTab session={session} loadError={sessionError} onSession={setSession} />}
    {tab === 'conversations' && <ConversationsTab onChanged={() => void loadStats()} />}
    {tab === 'auto' && <AutoMessagesTab autoMessagesEnabled={autoMessagesEnabled} />}
    {tab === 'bot' && <div className="grid gap-4">
      {wa ? <BotSettingsPanel settings={wa} canEdit={canEdit} saving={saving} onSave={change => saveWhatsapp(change, 'Configurações do robô salvas.')} /> : <p className="text-sm text-slate-500">Carregando configurações do robô…</p>}
      <KnowledgePanel canEdit={canEdit} onChanged={() => void loadStats()} />
    </div>}
    {tab === 'simulator' && <SimulatorTab />}
    {tab === 'outbox' && <OutboxTab onChanged={() => void loadStats()} />}
  </>;
}

export default function WhatsappPage() {
  return <AppShell title="WhatsApp">
    <Suspense fallback={<p className="text-sm text-slate-500">Carregando…</p>}><WhatsappCenter /></Suspense>
  </AppShell>;
}
