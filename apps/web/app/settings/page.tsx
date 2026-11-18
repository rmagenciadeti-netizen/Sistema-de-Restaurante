'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell, buttonClass, Notice, panelClass } from '../../components/app-shell';
import { FinancialSection, FulfillmentSection, HoursSection, CompanySection, MenuLayoutSection, OrderStatusesSection, OrdersSection, PdvSection, PrintingSection, ProductsSection, ScaleSection, StoreSection, TicketSection } from '../../components/settings-sections';
import { AppearancePanel } from '../../components/appearance-panel';
import { FiscalSettingsPanel } from '../../components/fiscal-settings-panel';
import { PageHeader, SideTabs } from '../../components/ui';
import { api } from '../../lib/api';
import type { SettingsSectionName } from '../../lib/settings';
import { invalidSlots, saveErrorMessage } from '../../lib/settings-helpers';
import { useSettings } from '../../lib/use-settings';

type TabKey = Exclude<SettingsSectionName, 'appearance'> | 'appearance' | 'fiscal';
type Tab = { key: TabKey; label: string; icon: string; title: string };
const tabs: Tab[] = [
  { key: 'company', label: 'Painel', icon: '🏢', title: 'Dados da empresa' },
  { key: 'appearance', label: 'Aparência e personalização', icon: '🎨', title: 'Aparência e personalização' },
  { key: 'menuLayout', label: 'Personalização do sistema', icon: '🎛️', title: 'Personalização do sistema' },
  { key: 'hours', label: 'Horário de funcionamento', icon: '🕒', title: 'Horário de funcionamento' },
  { key: 'fulfillment', label: 'Controle de entrega/retirada', icon: '🛵', title: 'Controle de entrega e retirada' },
  { key: 'store', label: 'Loja', icon: '🛍️', title: 'Loja virtual' },
  { key: 'products', label: 'Produtos', icon: '🍔', title: 'Produtos' },
  { key: 'orders', label: 'Pré-venda', icon: '🧾', title: 'Pré-venda e numeração de pedidos' },
  { key: 'pdv', label: 'PDV', icon: '🖥️', title: 'PDV (ponto de venda)' },
  { key: 'scale', label: 'Balança', icon: '⚖️', title: 'Balança' },
  { key: 'printing', label: 'Impressão', icon: '🖨️', title: 'Impressão' },
  { key: 'ticket', label: 'Ticket de retirada', icon: '🎫', title: 'Ticket de retirada' },
  { key: 'orderStatuses', label: 'Status dos pedidos', icon: '🔖', title: 'Status dos pedidos' },
  { key: 'financial', label: 'Financeiro', icon: '💰', title: 'Financeiro' },
  { key: 'fiscal', label: 'Fiscais', icon: '📑', title: 'Configurações fiscais' },
];

function SettingsContent() {
  const initialTab = useSearchParams().get('tab');
  const { draft, hasAdminPassword, setHasAdminPassword, role, canEdit, notice, setNotice, saving, isDirty, patch, save } = useSettings();
  const [tab, setTab] = useState<TabKey>(tabs.find(item => item.key === initialTab)?.key ?? 'company');
  const [passwordBusy, setPasswordBusy] = useState(false);
  const current = tabs.find(item => item.key === tab)!;
  const isFiscal = tab === 'fiscal' || tab === 'appearance';
  const dirty = (key: TabKey) => key !== 'fiscal' && key !== 'appearance' && isDirty(key);

  function problem(): string | null {
    if (!draft) return null;
    if (tab === 'hours' && invalidSlots(draft.hours.weekly).length > 0) return 'Corrija as faixas de horário: o início deve ser anterior ao fim.';
    if (tab === 'store' && !/^#[0-9a-fA-F]{6}$/.test(draft.store.brandColor)) return 'Informe a cor da loja no formato #RRGGBB.';
    if (tab === 'store' && !/^(\d{8,20})?$/.test(draft.store.metaPixelId)) return 'O ID do Pixel deve ter de 8 a 20 dígitos.';
    if (tab === 'orderStatuses' && draft.orderStatuses.items.some(item => !item.title.trim())) return 'Todos os status precisam de um título.';
    if (tab === 'scale') {
      if (!/^\d{1,2}$/.test(draft.scale.prefix)) return 'O prefixo da balança deve ter 1 ou 2 dígitos.';
      if (draft.scale.barcodeLength - draft.scale.prefix.length - draft.scale.codeLength - 1 < 1) return 'O formato do código de barras não deixa espaço para peso/preço.';
    }
    return null;
  }

  async function submit() {
    const issue = problem();
    if (issue) { setNotice({ text: issue, kind: 'error' }); return; }
    if (tab === 'fiscal' || tab === 'appearance') return;
    await save(tab, `${current.title}: configurações salvas.`);
  }

  async function setAdminPassword(password: string | null) {
    setPasswordBusy(true); setNotice(null);
    try {
      const result = await api<{ hasAdminPassword: boolean }>('/settings/admin-password', { method: 'POST', body: JSON.stringify({ password }) });
      setHasAdminPassword(result.hasAdminPassword);
      setNotice({ text: password === null ? 'Senha de administrador removida.' : 'Senha de administrador definida.', kind: 'success' });
      return true;
    } catch (e) { setNotice({ text: saveErrorMessage(e, 'Erro ao salvar a senha'), kind: 'error' }); return false; } finally { setPasswordBusy(false); }
  }

  const disabled = !canEdit || saving;
  const renderSection = () => {
    if (tab === 'appearance') return <AppearancePanel />;
    if (tab === 'fiscal') return <FiscalSettingsPanel canEdit={role === 'ADMIN' || role === 'MANAGER'} />;
    if (!draft) return <p className="text-sm text-slate-500">Carregando configurações…</p>;
    switch (tab) {
      case 'company': return <CompanySection value={draft.company} disabled={disabled} onChange={change => patch('company', change)} />;
      case 'menuLayout': return <MenuLayoutSection value={draft.menuLayout} disabled={disabled} onChange={change => patch('menuLayout', change)} onMessage={(text, kind) => setNotice({ text, kind })} />;
      case 'hours': return <HoursSection value={draft.hours} disabled={disabled} onChange={change => patch('hours', change)} />;
      case 'fulfillment': return <FulfillmentSection value={draft.fulfillment} disabled={disabled} onChange={change => patch('fulfillment', change)} />;
      case 'store': return <StoreSection value={draft.store} disabled={disabled} onChange={change => patch('store', change)} />;
      case 'products': return <ProductsSection value={draft.products} disabled={disabled} onChange={change => patch('products', change)} />;
      case 'orders': return <OrdersSection value={draft.orders} disabled={disabled} onChange={change => patch('orders', change)} />;
      case 'pdv': return <PdvSection value={draft.pdv} disabled={disabled} onChange={change => patch('pdv', change)} orderStatuses={draft.orderStatuses} password={{ hasPassword: hasAdminPassword, canManage: role === 'ADMIN', busy: passwordBusy, onSet: setAdminPassword }} />;
      case 'scale': return <ScaleSection value={draft.scale} disabled={disabled} onChange={change => patch('scale', change)} />;
      case 'printing': return <PrintingSection value={draft.printing} disabled={disabled} onChange={change => patch('printing', change)} />;
      case 'ticket': return <TicketSection value={draft.ticket} disabled={disabled} onChange={change => patch('ticket', change)} />;
      case 'orderStatuses': return <OrderStatusesSection value={draft.orderStatuses} disabled={disabled} onChange={change => patch('orderStatuses', change)} />;
      case 'financial': return <FinancialSection value={draft.financial} disabled={disabled} onChange={change => patch('financial', change)} />;
      default: return null;
    }
  };

  return <AppShell title="Configurações da empresa">
    <PageHeader title="Configurações da empresa" subtitle="Preferências gerais do restaurante. Cada aba é salva separadamente; algumas preferências só têm efeito nos módulos que as utilizam."
      actions={isFiscal ? undefined : <button type="button" onClick={() => void submit()} disabled={!canEdit || saving || !draft || !dirty(tab)} className={buttonClass}>{saving ? 'Salvando…' : 'Salvar'}</button>} />
    {notice && tab !== 'appearance' && <Notice message={notice.text} kind={notice.kind} />}
    {draft && !canEdit && tab !== 'appearance' && <Notice message="Seu perfil pode apenas consultar as configurações; somente administradores e gerentes podem alterá-las." />}
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <SideTabs tabs={tabs.map(item => ({ key: item.key, label: dirty(item.key) ? `${item.label} •` : item.label, icon: item.icon }))} value={tab} onChange={setTab} />
      <section className={`${panelClass} min-w-0 flex-1`} aria-labelledby="settings-title">
        <h3 id="settings-title" className="mb-4 border-b border-slate-200 pb-3 text-base font-bold text-slate-900">{current.title}{dirty(tab) && <span className="ml-2 text-xs font-semibold text-amber-700">alterações não salvas</span>}</h3>
        {renderSection()}
      </section>
    </div>
  </AppShell>;
}

// Re-mounts when ?tab= changes so menu links (e.g. Configurações fiscais) open the right tab even from within this page.
function SettingsRoute() {
  return <SettingsContent key={useSearchParams().get('tab') ?? ''} />;
}

export default function SettingsPage() {
  return <Suspense fallback={null}><SettingsRoute /></Suspense>;
}
