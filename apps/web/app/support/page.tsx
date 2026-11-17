'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, isAdminApp } from '../../lib/api';
import { AppShell, buttonClass, Field, Notice, panelClass, secondaryButtonClass, Select } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader, Tabs, textareaClass } from '../../components/ui';
import { Section } from '../../components/commercial/common';

type Status = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
type Ticket = { id: string; seq: number; subject: string; category: string; priority: Priority; status: Status; createdAt: string; updatedAt: string; resolvedAt: string | null; adminNotes?: string | null; tenant?: { id: string; name: string }; _count?: { messages: number } };
type Message = { id: string; body: string; fromAdmin: boolean; internal: boolean; createdAt: string; author?: string };
type Lead = { id: string; name: string; company: string; email: string; phone: string; city: string | null; interest: string | null; message: string | null; kind: string; status: string; notes: string | null; createdAt: string };

const statusLabels: Record<Status, string> = { OPEN: 'Aberto', IN_PROGRESS: 'Em atendimento', WAITING_CUSTOMER: 'Aguardando cliente', RESOLVED: 'Resolvido', CLOSED: 'Encerrado' };
const priorityLabels: Record<Priority, string> = { LOW: 'Baixa', NORMAL: 'Normal', HIGH: 'Alta', URGENT: 'Urgente' };
const statusTone = { OPEN: 'gold', IN_PROGRESS: 'blue', WAITING_CUSTOMER: 'neutral', RESOLVED: 'green', CLOSED: 'neutral' } as const;
const priorityTone = { LOW: 'neutral', NORMAL: 'blue', HIGH: 'gold', URGENT: 'red' } as const;
const leadLabels: Record<string, string> = { NEW: 'Novo', CONTACTED: 'Contatado', DEMO_SCHEDULED: 'Demonstração agendada', WON: 'Convertido', LOST: 'Perdido' };
const kindLabels: Record<string, string> = { DEMO: 'Demonstração', CONTACT: 'Contato', ONBOARDING: 'Cadastro' };

export default function SupportPage() {
  const admin = isAdminApp;
  const base = admin ? '/commercial/support/tickets' : '/support/tickets';
  const [tab, setTab] = useState<'tickets' | 'leads'>('tickets');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState({ status: '', priority: '', q: '' });
  const [selected, setSelected] = useState<{ ticket: Ticket; messages: Message[] } | null>(null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [nextStatus, setNextStatus] = useState('');
  const [form, setForm] = useState({ subject: '', category: 'Geral', priority: 'NORMAL', body: '' });
  const [leads, setLeads] = useState<Lead[]>([]);
  const [leadFilter, setLeadFilter] = useState('');
  const [message, setMessage] = useState('');
  const [success, setSuccess] = useState(false);
  const fail = (cause: unknown, fallback: string) => { setSuccess(false); setMessage(errorMessage(cause, fallback)); };

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (admin) { if (filter.status) params.set('status', filter.status); if (filter.priority) params.set('priority', filter.priority); if (filter.q) params.set('q', filter.q); }
    try {
      const result = await api<{ items: Ticket[]; counts?: Record<string, number> }>(`${base}?${params}`);
      setTickets(result.items); setCounts(result.counts ?? {});
    } catch (cause) { fail(cause, 'Falha ao carregar os chamados'); }
  }, [admin, base, filter]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!admin || tab !== 'leads') return;
    api<{ items: Lead[] }>(`/commercial/leads${leadFilter ? `?status=${leadFilter}` : ''}`).then(result => setLeads(result.items)).catch(cause => fail(cause, 'Falha ao carregar os interessados'));
  }, [admin, tab, leadFilter]);

  async function open(ticket: Ticket) {
    try { const result = await api<{ ticket: Ticket; messages: Message[] }>(`${base}/${ticket.id}`); setSelected(result); setNextStatus(''); setReply(''); setInternal(false); } catch (cause) { fail(cause, 'Falha ao abrir o chamado'); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    try { await api('/support/tickets', { method: 'POST', body: JSON.stringify(form) }); setSuccess(true); setMessage('Chamado aberto. Acompanhe a resposta por aqui.'); setForm({ subject: '', category: 'Geral', priority: 'NORMAL', body: '' }); await load(); } catch (cause) { fail(cause, 'Falha ao abrir o chamado'); }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault(); if (!selected) return;
    try {
      await api(`${base}/${selected.ticket.id}/messages`, { method: 'POST', body: JSON.stringify(admin ? { body: reply, internal, ...(nextStatus ? { status: nextStatus } : {}) } : { body: reply }) });
      await open(selected.ticket); await load();
    } catch (cause) { fail(cause, 'Falha ao enviar a mensagem'); }
  }
  async function patch(body: Record<string, unknown>) {
    if (!selected) return;
    try { await api(`${base}/${selected.ticket.id}`, { method: 'PATCH', body: JSON.stringify(body) }); await open(selected.ticket); await load(); } catch (cause) { fail(cause, 'Falha ao atualizar o chamado'); }
  }
  async function updateLead(lead: Lead, body: { status?: string; notes?: string | null }) {
    try { const updated = await api<Lead>(`/commercial/leads/${lead.id}`, { method: 'PATCH', body: JSON.stringify(body) }); setLeads(current => current.map(item => item.id === lead.id ? updated : item)); } catch (cause) { fail(cause, 'Falha ao atualizar'); }
  }

  const thread = selected && <section className={`${panelClass} mb-6`} aria-label="Conversa">
    <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
      <div><p className="text-xs text-slate-500">Chamado #{selected.ticket.seq}{selected.ticket.tenant && ` · ${selected.ticket.tenant.name}`} · {selected.ticket.category}</p><h2 className="text-lg font-bold">{selected.ticket.subject}</h2></div>
      <div className="flex items-center gap-2"><Badge tone={priorityTone[selected.ticket.priority]}>{priorityLabels[selected.ticket.priority]}</Badge><Badge tone={statusTone[selected.ticket.status]}>{statusLabels[selected.ticket.status]}</Badge><button type="button" className={secondaryButtonClass} onClick={() => setSelected(null)}>Fechar</button></div>
    </div>
    {admin && <div className="mb-3 grid gap-3 sm:grid-cols-3">
      <Select label="Prioridade" value={selected.ticket.priority} onChange={event => void patch({ priority: event.target.value })}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
      <Select label="Situação" value={selected.ticket.status} onChange={event => void patch({ status: event.target.value })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>
    </div>}
    <div className="max-h-96 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-3">
      {selected.messages.map(item => <div key={item.id} className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${item.internal ? 'ml-auto border border-dashed border-brand-400 bg-brand-50' : item.fromAdmin === admin ? 'ml-auto bg-neutral-950 text-white' : 'border border-slate-200 bg-white'}`}>
        <p className="mb-0.5 text-[10px] uppercase tracking-wide opacity-70">{item.internal ? 'Nota interna · ' : ''}{item.author ?? (item.fromAdmin ? 'RM Suporte' : 'Você')} · {formatDateTime(item.createdAt)}</p>{item.body}
      </div>)}
    </div>
    {selected.ticket.status !== 'CLOSED' ? <form onSubmit={send} className="mt-3 space-y-2">
      <textarea required minLength={2} maxLength={4000} rows={3} className={textareaClass} placeholder="Escreva sua mensagem…" value={reply} onChange={event => setReply(event.target.value)} aria-label="Mensagem" />
      <div className="flex flex-wrap items-center gap-3">
        {admin && <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-brand-600" checked={internal} onChange={event => setInternal(event.target.checked)} />Nota interna (o cliente não vê)</label>}
        {admin && <Select label="" aria-label="Alterar situação ao enviar" value={nextStatus} onChange={event => setNextStatus(event.target.value)}><option value="">Manter situação</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}
        <button className={buttonClass} disabled={reply.trim().length < 2}>Enviar</button>
      </div>
    </form> : <p className="mt-3 text-sm text-slate-500">Chamado encerrado.</p>}
  </section>;

  return <AppShell title={admin ? 'Suporte e interessados' : 'Suporte'}>
    <PageHeader title={admin ? 'Suporte e relacionamento' : 'Suporte RM Agência de TI'} subtitle={admin ? 'Fila de chamados dos restaurantes e interessados que pediram demonstração.' : 'Abra um chamado e acompanhe o atendimento. Você será respondido por aqui.'} />
    {message && <Notice message={message} kind={success ? 'success' : 'error'} />}
    {admin && <Tabs tabs={[{ key: 'tickets', label: '🎧 Chamados' }, { key: 'leads', label: '📞 Interessados' }]} value={tab} onChange={setTab} label="Suporte" />}
    {tab === 'tickets' && <>
      {!admin && <form onSubmit={create} className={`${panelClass} mb-6 space-y-3`}>
        <h2 className="text-base font-bold">Novo chamado</h2>
        <div className="grid gap-3 md:grid-cols-3"><Field label="Assunto" required minLength={5} maxLength={160} value={form.subject} onChange={event => setForm({ ...form, subject: event.target.value })} />
          <Select label="Categoria" value={form.category} onChange={event => setForm({ ...form, category: event.target.value })}>{['Geral', 'Financeiro', 'Fiscal', 'Impressão', 'PDV', 'Cardápio / QR Code', 'Delivery', 'Dúvida', 'Sugestão'].map(item => <option key={item}>{item}</option>)}</Select>
          <Select label="Prioridade" value={form.priority} onChange={event => setForm({ ...form, priority: event.target.value })}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></div>
        <label className="block text-sm font-medium text-slate-700">Descreva o problema<textarea required minLength={5} maxLength={4000} rows={4} className={textareaClass} value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} /></label>
        <button className={buttonClass}>Abrir chamado</button>
      </form>}
      {admin && <div className="mb-4 grid gap-3 sm:grid-cols-5">{(Object.keys(statusLabels) as Status[]).map(status => <button key={status} type="button" onClick={() => setFilter({ ...filter, status: filter.status === status ? '' : status })} className={`rounded-2xl border p-3 text-left shadow-sm ${filter.status === status ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white'}`}><p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{statusLabels[status]}</p><p className="text-2xl font-bold">{counts[status] ?? 0}</p></button>)}</div>}
      {admin && <Section title="Filtros"><div className="grid gap-3 sm:grid-cols-3"><Select label="Prioridade" value={filter.priority} onChange={event => setFilter({ ...filter, priority: event.target.value })}><option value="">Todas</option>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select><Field label="Buscar assunto ou cliente" value={filter.q} onChange={event => setFilter({ ...filter, q: event.target.value })} /></div></Section>}
      {thread}
      <Section title={`Chamados (${tickets.length})`}>
        {tickets.length === 0 ? <EmptyState icon="🎧" title="Nenhum chamado" hint={admin ? 'Nenhum chamado com os filtros atuais.' : 'Quando precisar de ajuda, abra um chamado acima.'} /> : <DataTable columns={[{ label: 'Nº' }, ...(admin ? [{ label: 'Cliente' }] : []), { label: 'Assunto' }, { label: 'Prioridade' }, { label: 'Situação' }, { label: 'Atualizado' }, { label: '' }]}>
          {tickets.map(ticket => <tr key={ticket.id}><td>#{ticket.seq}</td>{admin && <td>{ticket.tenant?.name}</td>}<td><strong>{ticket.subject}</strong><div className="text-xs text-slate-500">{ticket.category}</div></td><td><Badge tone={priorityTone[ticket.priority]}>{priorityLabels[ticket.priority]}</Badge></td><td><Badge tone={statusTone[ticket.status]}>{statusLabels[ticket.status]}</Badge></td><td className="text-xs">{formatDateTime(ticket.updatedAt)}</td><td><button type="button" className={secondaryButtonClass} onClick={() => void open(ticket)}>Abrir</button></td></tr>)}
        </DataTable>}
      </Section>
    </>}
    {admin && tab === 'leads' && <Section title={`Interessados (${leads.length})`} actions={<Select label="" aria-label="Filtrar situação" value={leadFilter} onChange={event => setLeadFilter(event.target.value)}><option value="">Todas as situações</option>{Object.entries(leadLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select>}>
      <p className="mb-3 text-xs text-slate-500">Os pedidos chegam pelo formulário público do restaurante em <code>/demo</code>. Os dados são usados apenas para retornar o contato comercial.</p>
      {leads.length === 0 ? <EmptyState icon="📞" title="Nenhum interessado" /> : <DataTable columns={[{ label: 'Data' }, { label: 'Contato' }, { label: 'Interesse' }, { label: 'Situação' }, { label: 'Observações' }]}>
        {leads.map(lead => <tr key={lead.id} className="align-top"><td className="text-xs">{formatDateTime(lead.createdAt)}<div><Badge>{kindLabels[lead.kind] ?? lead.kind}</Badge></div></td>
          <td><strong>{lead.company}</strong><div className="text-xs">{lead.name} · {lead.phone}</div><div className="text-xs text-slate-500">{lead.email}{lead.city && ` · ${lead.city}`}</div></td>
          <td className="text-xs">{lead.interest ?? '—'}{lead.message && <div className="text-slate-500">{lead.message}</div>}</td>
          <td><select aria-label="Situação do interessado" className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs" value={lead.status} onChange={event => void updateLead(lead, { status: event.target.value })}>{Object.entries(leadLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
          <td><input aria-label="Observações" defaultValue={lead.notes ?? ''} maxLength={2000} onBlur={event => { if (event.target.value !== (lead.notes ?? '')) void updateLead(lead, { notes: event.target.value || null }); }} className="w-48 rounded-lg border border-slate-300 px-2 py-1 text-xs" /></td></tr>)}
      </DataTable>}
    </Section>}
  </AppShell>;
}
