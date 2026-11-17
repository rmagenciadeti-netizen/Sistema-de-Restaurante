'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney } from '../../lib/api';
import { AppShell, Field, Notice, secondaryButtonClass } from '../../components/app-shell';
import { Badge, DataTable, EmptyState, PageHeader } from '../../components/ui';
import { exportCsv, Section } from '../../components/commercial/common';

type Segment = 'VIP' | 'RECURRING' | 'NEW' | 'AT_RISK' | 'INACTIVE';
type Row = { id: string; name: string; phone: string; email: string | null; marketingConsent: boolean; loyaltyPoints: number; segment: Segment; orders: number; spent: number; averageTicket: number | null; lastOrderAt: string | null };
type Response = { items: Row[]; counts: Partial<Record<Segment, number>>; rules: Record<Segment, string>; averageSpent: number; truncated: boolean };
const labels: Record<Segment, string> = { VIP: '👑 VIP', RECURRING: '🔁 Recorrentes', NEW: '🌱 Novos', AT_RISK: '⚠️ Em risco', INACTIVE: '💤 Inativos' };
const tones = { VIP: 'gold', RECURRING: 'green', NEW: 'blue', AT_RISK: 'red', INACTIVE: 'neutral' } as const;
const whatsapp = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '').replace(/^(?!55)/, '55')}`;

export default function CrmPage() {
  const [data, setData] = useState<Response | null>(null);
  const [segment, setSegment] = useState<Segment | ''>('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { api<Response>('/customers/segments').then(setData).catch(cause => setError(errorMessage(cause, 'Falha ao carregar os segmentos'))); }, []);

  const rows = useMemo(() => (data?.items ?? []).filter(item => (!segment || item.segment === segment) && (!query || `${item.name} ${item.phone}`.toLowerCase().includes(query.toLowerCase()))), [data, segment, query]);
  const consented = rows.filter(item => item.marketingConsent);
  return <AppShell title="Clientes VIP e fidelização">
    <PageHeader title="RM Cliente VIP" subtitle="Segmentação automática pelo histórico real de pedidos concluídos. As regras são fixas e transparentes; os pontos de fidelidade vêm do cadastro." />
    {error && <Notice message={error} />}
    {!data && !error && <p className="text-sm text-slate-500">Carregando…</p>}
    {data && <>
      {data.truncated && <Notice message="Há mais de 5.000 clientes; apenas parte foi analisada." />}
      <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {(Object.keys(labels) as Segment[]).map(key => <button key={key} type="button" aria-pressed={segment === key} onClick={() => setSegment(segment === key ? '' : key)} className={`rounded-2xl border p-4 text-left shadow-sm transition ${segment === key ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white hover:border-brand-300'}`}>
          <p className="text-sm font-semibold">{labels[key]}</p><p className="mt-1 text-2xl font-bold">{data.counts[key] ?? 0}</p><p className="mt-1 text-[11px] leading-tight text-slate-500">{data.rules[key]}</p>
        </button>)}
      </div>
      <Section title={`Clientes (${rows.length})`} actions={<button type="button" className={secondaryButtonClass} disabled={consented.length === 0} title="Exporta somente quem autorizou receber comunicações" onClick={() => exportCsv('clientes-marketing.csv', ['Nome', 'Telefone', 'E-mail', 'Segmento', 'Pedidos', 'Total gasto', 'Pontos'], consented.map(item => [item.name, item.phone, item.email ?? '', labels[item.segment], item.orders, item.spent, item.loyaltyPoints]))}>Exportar quem autorizou contato ({consented.length})</button>}>
        <div className="mb-3 max-w-sm"><Field label="Buscar por nome ou telefone" value={query} onChange={event => setQuery(event.target.value)} /></div>
        {rows.length === 0 ? <EmptyState icon="👑" title="Nenhum cliente neste filtro" hint="Clientes são cadastrados no PDV, no delivery e pelo WhatsApp." /> : <DataTable columns={[{ label: 'Cliente' }, { label: 'Segmento' }, { label: 'Pedidos' }, { label: 'Total gasto' }, { label: 'Ticket médio' }, { label: 'Última compra' }, { label: 'Pontos' }, { label: 'Contato' }]}>
          {rows.slice(0, 300).map(item => <tr key={item.id}><td><strong>{item.name}</strong><div className="text-xs text-slate-500">{item.phone}</div></td><td><Badge tone={tones[item.segment]}>{labels[item.segment]}</Badge></td><td>{item.orders}</td><td>{formatMoney(item.spent)}</td><td>{item.averageTicket === null ? '—' : formatMoney(item.averageTicket)}</td><td className="text-xs">{item.lastOrderAt ? formatDateTime(item.lastOrderAt) : 'Nunca'}</td><td>{item.loyaltyPoints}</td>
            <td>{item.marketingConsent ? <a href={whatsapp(item.phone)} target="_blank" rel="noreferrer" className="text-sm font-semibold text-brand-700 hover:underline">WhatsApp</a> : <span className="text-xs text-slate-400" title="O cliente não autorizou comunicações de marketing">Sem autorização</span>}</td></tr>)}
        </DataTable>}
        {rows.length > 300 && <p className="mt-2 text-xs text-slate-500">Mostrando 300 de {rows.length}; use os filtros ou a exportação.</p>}
      </Section>
    </>}
  </AppShell>;
}
