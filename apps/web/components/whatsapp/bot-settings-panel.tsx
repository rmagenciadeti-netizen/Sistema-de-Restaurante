'use client';

import { useState } from 'react';
import type { TenantSettings } from '../../lib/settings';
import { Badge, Toggle, textareaClass } from '../ui';
import { Field, buttonClass, panelClass } from '../app-shell';

type WhatsappSettings = TenantSettings['whatsapp'];
const bounds = { greetingCooldownHours: [1, 168], handoffMinutes: [5, 1440], replyDelaySeconds: [0, 10] } as const;

export function BotSettingsPanel({ settings, canEdit, saving, onSave }: { settings: WhatsappSettings; canEdit: boolean; saving: boolean; onSave: (change: Partial<WhatsappSettings>) => Promise<boolean> }) {
  const [cooldown, setCooldown] = useState(String(settings.greetingCooldownHours));
  const [handoff, setHandoff] = useState(String(settings.handoffMinutes));
  const [delay, setDelay] = useState(String(settings.replyDelaySeconds));
  const [outside, setOutside] = useState(settings.replyOutsideHours);
  const [typing, setTyping] = useState(settings.humanizeTyping);
  const [footer, setFooter] = useState(settings.menuFooter);
  const [error, setError] = useState<string | null>(null);

  const values = { greetingCooldownHours: Number(cooldown), handoffMinutes: Number(handoff), replyDelaySeconds: Number(delay) };
  const dirty = values.greetingCooldownHours !== settings.greetingCooldownHours || values.handoffMinutes !== settings.handoffMinutes || values.replyDelaySeconds !== settings.replyDelaySeconds
    || outside !== settings.replyOutsideHours || typing !== settings.humanizeTyping || footer !== settings.menuFooter;

  async function save() {
    const invalid = (Object.keys(bounds) as (keyof typeof bounds)[]).find(key => !Number.isInteger(values[key]) || values[key] < bounds[key][0] || values[key] > bounds[key][1]);
    if (invalid) {
      const label = { greetingCooldownHours: 'Intervalo entre boas-vindas (1 a 168 horas)', handoffMinutes: 'Duração do atendimento humano (5 a 1440 minutos)', replyDelaySeconds: 'Atraso da resposta (0 a 10 segundos)' }[invalid];
      setError(`Valor inválido: ${label}.`); return;
    }
    if (footer.length > 200) { setError('O rodapé do cardápio pode ter no máximo 200 caracteres.'); return; }
    setError(null);
    await onSave({ ...values, replyOutsideHours: outside, humanizeTyping: typing, menuFooter: footer });
  }

  return <section className={panelClass}>
    <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold text-slate-900">Configurações do robô</h2><Badge tone={settings.botEnabled ? 'green' : 'neutral'}>{settings.botEnabled ? 'Robô ativo' : 'Robô desligado'}</Badge></div>
    <p className="mt-2 text-sm text-slate-600">Ligue ou desligue o robô na chave “Robô de atendimento”, no topo da página. Quando ativo, ele responde automaticamente sobre: cardápio e preços, busca de produto, horários, endereço, entrega e taxas, formas de pagamento, status do pedido, reservas, atendimento humano e a base de conhecimento abaixo.</p>
    <div className="mt-4 grid gap-4 sm:grid-cols-3">
      <Field label="Intervalo entre boas-vindas (horas)" type="number" min={1} max={168} inputMode="numeric" value={cooldown} disabled={!canEdit} onChange={event => setCooldown(event.target.value)} />
      <Field label="Duração do atendimento humano (min)" type="number" min={5} max={1440} inputMode="numeric" value={handoff} disabled={!canEdit} onChange={event => setHandoff(event.target.value)} />
      <Field label="Atraso da resposta (segundos)" type="number" min={0} max={10} inputMode="numeric" value={delay} disabled={!canEdit} onChange={event => setDelay(event.target.value)} />
    </div>
    <p className="mt-1 text-xs text-slate-500">Depois que um atendente assume uma conversa, o robô fica calado pelo tempo de “duração do atendimento humano”.</p>
    <div className="mt-4 grid gap-3 md:grid-cols-2">
      <Toggle label="Responder fora do horário de funcionamento" hint="Se desligado, o robô só responde com a mensagem “Fora do horário”." checked={outside} disabled={!canEdit} onChange={setOutside} />
      <Toggle label="Simular digitação" hint="Mostra “digitando…” e espera um instante antes de responder, para soar mais natural." checked={typing} disabled={!canEdit} onChange={setTyping} />
    </div>
    <label className="mt-4 block text-sm font-medium text-slate-700">Rodapé do cardápio (opcional)
      <textarea rows={2} maxLength={200} value={footer} disabled={!canEdit} className={textareaClass} placeholder="Ex.: Peça pelo nosso site e ganhe 5% de desconto" onChange={event => setFooter(event.target.value)} />
    </label>
    <p className="text-right text-xs text-slate-400">{footer.length}/200</p>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    {!canEdit && <p className="mt-2 text-sm text-slate-500">Seu perfil pode apenas visualizar estas configurações.</p>}
    <div className="mt-3"><button type="button" className={`${buttonClass} min-h-11`} disabled={!canEdit || saving || !dirty} onClick={() => void save()}>Salvar configurações</button></div>
  </section>;
}
