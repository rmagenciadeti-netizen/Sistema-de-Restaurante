'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '../../components/app-shell';
import { CommercialOverview } from '../../components/commercial/overview';
import { ModuleCatalog } from '../../components/commercial/modules';
import { PromotionManager } from '../../components/commercial/promotions';
import { BillingManager, CommercialHistory } from '../../components/commercial/billing';
import { PageHeader, Tabs } from '../../components/ui';

const tabs = [
  { key: 'overview', label: '📊 Visão geral' }, { key: 'modules', label: '🧩 Módulos' }, { key: 'campaigns', label: '🔖 Promoções' },
  { key: 'coupons', label: '🏷️ Cupons' }, { key: 'billing', label: '🧾 Cobranças' }, { key: 'history', label: '🛡️ Auditoria' },
] as const;
type Tab = (typeof tabs)[number]['key'];

function CommercialContent({ requested }: { requested: string | null }) {
  const [tab, setTab] = useState<Tab>(() => tabs.find(item => item.key === requested)?.key ?? 'overview');
  return <AppShell title="Gestão comercial">
    <PageHeader title="Gestão comercial — planos, módulos e assinaturas" subtitle="Controle toda a oferta do RM Restaurant sem alterar código. Planos e clientes têm telas próprias em “Planos e preços” e “Clientes e assinaturas”." />
    <Tabs tabs={tabs.map(item => ({ key: item.key, label: item.label }))} value={tab} onChange={setTab} label="Gestão comercial" />
    {tab === 'overview' && <CommercialOverview />}
    {tab === 'modules' && <ModuleCatalog />}
    {tab === 'campaigns' && <PromotionManager kind="campaigns" />}
    {tab === 'coupons' && <PromotionManager kind="coupons" />}
    {tab === 'billing' && <BillingManager />}
    {tab === 'history' && <CommercialHistory />}
  </AppShell>;
}

// Keyed by the menu's ?tab= so each sidebar entry opens its own section.
function CommercialRoute() {
  const requested = useSearchParams().get('tab');
  return <CommercialContent key={requested ?? ''} requested={requested} />;
}

export default function CommercialPage() {
  return <Suspense fallback={null}><CommercialRoute /></Suspense>;
}
