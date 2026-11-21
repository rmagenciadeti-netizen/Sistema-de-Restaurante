'use client';

import type { TenantSettings } from '../../lib/settings';
import { panelClass } from '../app-shell';
import { Toggle } from '../ui';

type WhatsappSettings = TenantSettings['whatsapp'];

export function GeneralSwitches({ settings, saving, canEdit, aiConfigured, onChange }: { settings: WhatsappSettings | null; saving: boolean; canEdit: boolean; aiConfigured: boolean | undefined; onChange: (change: Partial<WhatsappSettings>) => void }) {
  const disabled = !settings || saving || !canEdit;
  return <section className={`${panelClass} mb-4 !p-4`} aria-label="Chaves gerais do WhatsApp">
    <div className="grid gap-3 lg:grid-cols-3">
      <Toggle label="Robô de atendimento" hint="Responde automaticamente cardápio, horários, entrega, pagamento, status do pedido, reservas e a base de conhecimento." checked={settings?.botEnabled ?? false} disabled={disabled} onChange={botEnabled => onChange({ botEnabled })} />
      <Toggle label="Mensagens automáticas" hint="Boas-vindas e avisos de pedido e reserva. Desligado, nada é enviado, mas os textos continuam editáveis." checked={settings?.autoMessagesEnabled ?? true} disabled={disabled} onChange={autoMessagesEnabled => onChange({ autoMessagesEnabled })} />
      <Toggle label="Interação com IA" hint="A IA só responde sobre o restaurante, usando cardápio, horários e a base de conhecimento. A pergunta do cliente é enviada ao provedor de IA configurado no servidor." checked={settings?.aiFallback ?? false} disabled={disabled} onChange={aiFallback => onChange({ aiFallback })} />
    </div>
    {aiConfigured === false && <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">A IA ainda não foi ativada para a plataforma (o administrador do RM configura o provedor no RM Painel Admin); enquanto isso o robô usa só as regras e a base de conhecimento.</p>}
    {settings?.aiFallback && <p className="mt-3 text-xs text-slate-500">Privacidade: com a IA ligada, o texto da pergunta do cliente e dados públicos do cardápio são enviados ao provedor de IA configurado no servidor.</p>}
    {!canEdit && settings && <p className="mt-3 text-xs text-slate-500">Seu perfil pode apenas visualizar estas chaves.</p>}
  </section>;
}
