'use client';

import { useState } from 'react';
import { api, ListResponse } from '../../lib/api';
import type { AgentTone, TenantSettings, WhatsappAgentSettings } from '../../lib/settings';
import type { AgentAction, AgentStatus } from '../../lib/types-whatsapp';
import { useAutoLoad } from '../../lib/use-auto-load';
import { Field, Notice, buttonClass, inputClass, panelClass } from '../app-shell';
import { Badge, StatCard, Toggle, textareaClass } from '../ui';
import { Flash, friendlyError, shortTime } from './common';

type WhatsappSettings = TenantSettings['whatsapp'];
const tones: { key: AgentTone; label: string }[] = [{ key: 'FRIENDLY', label: 'Simpático e caloroso' }, { key: 'FORMAL', label: 'Formal' }, { key: 'CASUAL', label: 'Descontraído' }, { key: 'CONCISE', label: 'Direto e objetivo' }];
const bounds = { maxPartySize: [1, 100], maxOrderTotal: [0, 99999], orderChangeWindowMinutes: [0, 240] } as const;
const toolLabel: Record<string, string> = {
  create_reservation: 'Reserva criada', modify_reservation: 'Reserva alterada', cancel_reservation: 'Reserva cancelada', place_order: 'Pedido criado', modify_order: 'Pedido alterado', cancel_order: 'Pedido cancelado',
  request_human_handoff: 'Passou para atendente', set_message_preferences: 'Preferência de mensagens', report_unanswered: 'Pergunta sem resposta',
};
const actionLabel = (tool: string) => toolLabel[tool] ?? tool;

export function AgentTab({ settings, canEdit, saving, onSave }: { settings: WhatsappSettings; canEdit: boolean; saving: boolean; onSave: (change: Partial<WhatsappSettings>) => Promise<boolean> }) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [actions, setActions] = useState<AgentAction[]>([]);
  const [allActions, setAllActions] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const [form, setForm] = useState<WhatsappAgentSettings>(settings.agent);
  const [error, setError] = useState<string | null>(null);
  const [partySize, setPartySize] = useState(String(settings.agent.maxPartySize));
  const [maxTotal, setMaxTotal] = useState(String(settings.agent.maxOrderTotal));
  const [windowMin, setWindowMin] = useState(String(settings.agent.orderChangeWindowMinutes));

  useAutoLoad(async () => { try { setStatus(await api<AgentStatus>('/whatsapp/agent/status')); } catch (e) { setFlash({ text: friendlyError(e, 'Erro ao carregar o estado do atendente de IA'), kind: 'error' }); } }, 15000);
  useAutoLoad(async () => { try { setActions((await api<ListResponse<AgentAction>>(`/whatsapp/agent/actions?kind=${allActions ? 'ALL' : 'WRITE'}`)).items ?? []); } catch { /* o registro fica vazio */ } }, 10000);

  const numbers = { maxPartySize: Number(partySize), maxOrderTotal: Number(maxTotal), orderChangeWindowMinutes: Number(windowMin) };
  const next: WhatsappAgentSettings = { ...form, ...numbers };
  const dirty = (Object.keys(next) as (keyof WhatsappAgentSettings)[]).some(key => next[key] !== settings.agent[key]);
  const set = <K extends keyof WhatsappAgentSettings>(key: K, value: WhatsappAgentSettings[K]) => setForm(current => ({ ...current, [key]: value }));

  async function save() {
    const invalid = (Object.keys(bounds) as (keyof typeof bounds)[]).find(key => !Number.isFinite(numbers[key]) || (key === 'maxOrderTotal' ? false : !Number.isInteger(numbers[key])) || numbers[key] < bounds[key][0] || numbers[key] > bounds[key][1]);
    if (invalid) { setError(`Valor inválido: ${{ maxPartySize: 'pessoas por reserva (1 a 100)', maxOrderTotal: 'valor máximo do pedido (0 a 99999)', orderChangeWindowMinutes: 'prazo para alterar/cancelar (0 a 240 minutos)' }[invalid]}.`); return; }
    setError(null);
    await onSave({ agent: next });
  }

  const modeBadge = status ? status.mode === 'AI' ? <Badge tone="green">Atendente de IA ativo</Badge> : status.mode === 'CLASSIC' ? <Badge tone="amber">Modo clássico (sem IA)</Badge> : <Badge tone="neutral">Robô desligado</Badge> : null;
  return <div className="grid gap-4">
    {flash && <Notice message={flash.text} kind={flash.kind} />}
    <section className={panelClass}>
      <div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-semibold text-slate-900">Atendente de IA autônomo</h2>{modeBadge}</div>
      <p className="mt-2 text-sm text-slate-600">Um atendente de verdade dentro do WhatsApp: entende o cliente com as próprias palavras, muda de assunto junto com ele, consulta o cardápio, as taxas, os horários e a base de conhecimento reais e executa reservas e pedidos no sistema. Nada é inventado: preços, disponibilidade e status vêm sempre dos seus dados, e uma reserva ou um pedido só é confirmado ao cliente depois que o sistema registra.</p>
      {status && !status.available && status.botEnabled && <p role="alert" className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">O atendente de IA não está respondendo agora — {status.reason} Enquanto isso o robô clássico (por palavras-chave) atende os clientes.</p>}
      {status && !status.botEnabled && <p className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">O robô de atendimento está desligado na chave “Robô de atendimento”, no topo da página. Ligue-a para o atendente começar a responder.</p>}
      {status && !status.consent && <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">Falta autorizar o envio de dados a um provedor externo de IA (Configurações › IA › consentimento). A mensagem do cliente e os dados públicos do restaurante são enviados ao provedor configurado pela plataforma ({status.provider ?? 'não configurado'}).</p>}
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Modelo" value={<span className="text-base">{status?.model ?? '—'}</span>} hint={status?.provider ? `provedor ${status.provider}${status.toolCalling ? '' : ' (sem chamada de ferramentas)'}` : 'definido no RM Painel Admin'} />
        <StatCard label="Chamadas de IA hoje" value={status ? `${status.usage.callsToday}/${status.usage.dailyLimit}` : '—'} hint="limite diário do atendente" />
        <StatCard label="Operações hoje" value={status?.operationsToday ?? '—'} hint="reservas e pedidos feitos pelo atendente" />
        <StatCard label="Aguardando atendente" value={status?.handoffOpen ?? '—'} tone={status && status.handoffOpen > 0 ? 'dark' : 'default'} hint="conversas passadas para uma pessoa" />
      </div>
      <div className="mt-4"><Toggle label="Usar o atendente de IA" hint="Desligado, o robô volta a responder só por palavras-chave (cardápio, horários, entrega, pagamento, status e reserva guiada)." checked={form.enabled} disabled={!canEdit || saving} onChange={value => set('enabled', value)} /></div>
    </section>

    <section className={panelClass}>
      <h2 className="text-lg font-semibold text-slate-900">Personalidade e comportamento</h2>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <Field label="Nome do atendente (opcional)" maxLength={40} value={form.assistantName} disabled={!canEdit} placeholder="Ex.: Léo" onChange={event => set('assistantName', event.target.value)} />
        <label className="block text-sm font-medium text-slate-700">Jeito de falar
          <select className={inputClass} value={form.tone} disabled={!canEdit} onChange={event => set('tone', event.target.value as AgentTone)}>{tones.map(tone => <option key={tone.key} value={tone.key}>{tone.label}</option>)}</select>
        </label>
      </div>
      <div className="mt-3"><Toggle label="Usar emojis" hint="Poucos emojis, com naturalidade." checked={form.emojis} disabled={!canEdit} onChange={value => set('emojis', value)} /></div>
      <label className="mt-4 block text-sm font-medium text-slate-700">Instruções do seu restaurante (opcional)
        <textarea rows={4} maxLength={2000} value={form.instructions} disabled={!canEdit} className={textareaClass} placeholder="Ex.: Sempre ofereça a sobremesa do dia. Não aceitamos reservas às sextas depois das 21h. Chame os clientes de “você”." onChange={event => set('instructions', event.target.value)} />
      </label>
      <p className="text-right text-xs text-slate-400">{form.instructions.length}/2000 — as regras de segurança do sistema sempre valem sobre estas instruções.</p>
    </section>

    <section className={panelClass}>
      <h2 className="text-lg font-semibold text-slate-900">O que o atendente pode fazer</h2>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Toggle label="Reservas" hint="Consulta a disponibilidade de mesas e horários, cria, altera e cancela as reservas do próprio cliente." checked={form.allowReservations} disabled={!canEdit} onChange={value => set('allowReservations', value)} />
        <Toggle label="Pedidos para entrega e retirada" hint="Monta o pedido com o cardápio real, calcula a taxa e o total e cria o pedido só depois que o cliente confirma." checked={form.allowOrders} disabled={!canEdit} onChange={value => set('allowOrders', value)} />
        <Toggle label="Alterar e cancelar pedidos" hint="Só enquanto a cozinha não começou e dentro do prazo abaixo. Depois disso chama uma pessoa." checked={form.allowOrderChanges} disabled={!canEdit || !form.allowOrders} onChange={value => set('allowOrderChanges', value)} />
        <Toggle label="Confirmar reservas automaticamente" hint="Desligado, a reserva fica “aguardando confirmação” e a equipe confirma. Ligado, é confirmada quando há mesa livre." checked={form.autoConfirmReservations} disabled={!canEdit || !form.allowReservations} onChange={value => set('autoConfirmReservations', value)} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Field label="Máx. de pessoas por reserva" type="number" min={1} max={100} inputMode="numeric" value={partySize} disabled={!canEdit} onChange={event => setPartySize(event.target.value)} />
        <Field label="Valor máximo do pedido (R$)" type="number" min={0} max={99999} inputMode="decimal" value={maxTotal} disabled={!canEdit} onChange={event => setMaxTotal(event.target.value)} />
        <Field label="Prazo para alterar/cancelar (min)" type="number" min={0} max={240} inputMode="numeric" value={windowMin} disabled={!canEdit} onChange={event => setWindowMin(event.target.value)} />
      </div>
      <p className="mt-1 text-xs text-slate-500">Acima do valor máximo (0 = sem limite) ou do limite de pessoas, o atendente chama uma pessoa em vez de fechar sozinho. Ele nunca cobra pagamento nem aplica descontos.</p>
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
      {!canEdit && <p className="mt-2 text-sm text-slate-500">Seu perfil pode apenas visualizar estas configurações.</p>}
      <div className="mt-3"><button type="button" className={`${buttonClass} min-h-11`} disabled={!canEdit || saving || !dirty} onClick={() => void save()}>Salvar atendente de IA</button></div>
    </section>

    <section className={panelClass}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="text-lg font-semibold text-slate-900">Registro de ações</h2><p className="text-sm text-slate-600">{allActions ? 'Tudo o que o atendente consultou e executou.' : 'Reservas, pedidos e encaminhamentos que o atendente realizou de verdade.'}</p></div>
        <Toggle label="Mostrar também consultas" checked={allActions} onChange={setAllActions} />
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm"><thead><tr className="border-b border-slate-200 text-xs uppercase tracking-wider text-slate-500"><th className="py-2 pr-3">Quando</th><th className="py-2 pr-3">Cliente</th><th className="py-2 pr-3">Ação</th><th className="py-2 pr-3">Resultado</th><th className="py-2">Detalhe</th></tr></thead>
          <tbody>{actions.map(action => <tr key={action.id} className="border-b border-slate-100 align-top"><td className="py-2 pr-3 whitespace-nowrap text-slate-500">{shortTime(action.at)}</td><td className="py-2 pr-3">{action.customer ?? '—'}</td><td className="py-2 pr-3">{actionLabel(action.tool)}</td><td className="py-2 pr-3">{action.kind === 'PROPOSAL' ? <Badge tone="blue">Pediu confirmação</Badge> : action.ok ? <Badge tone="green">Feito</Badge> : <Badge tone="amber">Recusado</Badge>}</td><td className="py-2 text-slate-600">{action.summary}</td></tr>)}</tbody>
        </table>
        {actions.length === 0 && <p className="px-2 py-6 text-center text-sm text-slate-500">Nenhuma ação registrada ainda.</p>}
      </div>
    </section>
  </div>;
}
