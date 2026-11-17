'use client';

import { AppShell, buttonClass, Field, Notice, panelClass } from '../../components/app-shell';
import { NumberField } from '../../components/settings-sections';
import { PageHeader, Toggle } from '../../components/ui';
import { WeekSlots } from '../../components/week-slots';
import { invalidSlots } from '../../lib/settings-helpers';
import { useSettings } from '../../lib/use-settings';

export default function ScheduleSettingsPage() {
  const { draft, canEdit, notice, setNotice, saving, isDirty, patch, save } = useSettings();
  const value = draft?.scheduling;
  const disabled = !canEdit || saving;

  async function submit() {
    if (!value) return;
    if (invalidSlots(value.slots).length > 0) { setNotice({ text: 'Corrija as faixas de horário: o início deve ser anterior ao fim.', kind: 'error' }); return; }
    if (Boolean(value.blockedFrom) !== Boolean(value.blockedTo)) { setNotice({ text: 'Informe as duas datas do período de bloqueio ou limpe ambas.', kind: 'error' }); return; }
    if (value.blockedFrom && value.blockedTo && value.blockedFrom > value.blockedTo) { setNotice({ text: 'No período de bloqueio, a data inicial deve ser anterior ou igual à final.', kind: 'error' }); return; }
    await save('scheduling', 'Agendamento de pedidos salvo.');
  }

  return <AppShell title="Agendamento de pedidos">
    <PageHeader title="Agendamento de pedidos" subtitle="Permita que clientes e atendentes marquem pedidos para outro dia ou horário. O pedido só entra na produção na antecedência definida abaixo."
      actions={<button type="button" onClick={() => void submit()} disabled={!canEdit || saving || !value || !isDirty('scheduling')} className={buttonClass}>{saving ? 'Salvando…' : 'Salvar'}</button>} />
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    {draft && !canEdit && <Notice message="Seu perfil pode apenas consultar; somente administradores e gerentes podem alterar o agendamento." />}
    {!value ? <p className="text-sm text-slate-500">Carregando…</p> : <div className="space-y-4">
      <section className={panelClass} aria-label="Regras gerais">
        <Toggle label="Habilitar agendamento de pedidos" hint="Desligado: nenhum pedido pode ser agendado." checked={value.enabled} disabled={disabled} onChange={enabled => patch('scheduling', { enabled })} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <NumberField label="Agendar com até quantos dias de antecedência" value={value.maxDaysAhead} max={365} disabled={disabled} onChange={maxDaysAhead => patch('scheduling', { maxDaysAhead })} />
          <Field label="Entrar na produção com antecedência de (HH:mm)" type="time" value={value.leadTime} disabled={disabled} required onChange={event => patch('scheduling', { leadTime: event.target.value || '00:30' })} />
        </div>
        <h3 className="mb-2 mt-6 text-sm font-bold uppercase tracking-wider text-slate-500">Período de bloqueio</h3>
        <p className="mb-3 text-sm text-slate-500">Datas (ex.: feriados) em que não é possível agendar. Deixe em branco para não bloquear.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="De" type="date" value={value.blockedFrom ?? ''} disabled={disabled} onChange={event => patch('scheduling', { blockedFrom: event.target.value || null })} />
          <Field label="Até" type="date" value={value.blockedTo ?? ''} disabled={disabled} onChange={event => patch('scheduling', { blockedTo: event.target.value || null })} />
        </div>
      </section>
      <section className={panelClass} aria-label="Horários disponíveis">
        <h3 className="mb-1 text-base font-bold text-slate-900">Horários para agendar</h3>
        <p className="mb-4 text-sm text-slate-500">Abra cada dia da semana e adicione as faixas de horário em que o cliente pode escolher a retirada ou entrega. Dia sem faixas não aceita agendamento.</p>
        <WeekSlots slots={value.slots} disabled={disabled} onChange={slots => patch('scheduling', { slots })} />
      </section>
    </div>}
  </AppShell>;
}
