'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatDateTime, formatMoney, type Customer, type ListResponse } from '../../lib/api';
import { buttonClass, Check, Field, Notice, secondaryButtonClass } from '../app-shell';
import { Badge, DataTable, EmptyState } from '../ui';
import { exportCsv, Section } from '../commercial/common';

export type LoyaltyConfig = { enabled: boolean; pointsPerReal: number; redeemValuePerPoint: number; minRedeemPoints: number; validityDays: number; couponValidDays: number };
type Entry = { id: string; type: 'EARN' | 'REDEEM' | 'EXPIRE' | 'ADJUST' | 'REVERSAL'; points: number; balanceAfter: number; note: string | null; couponCode: string | null; createdAt: string };
type LoyaltyView = { customer: { id: string; name: string }; balance: number; worth: number; config: LoyaltyConfig; entries: Entry[] };
type Redeemed = { code: string; value: number; balance: number; validUntil: string };
const typeLabel: Record<Entry['type'], string> = { EARN: 'Compra', REDEEM: 'Resgate', EXPIRE: 'Expiração', ADJUST: 'Ajuste manual', REVERSAL: 'Estorno' };
const typeTone = { EARN: 'green', REDEEM: 'gold', EXPIRE: 'neutral', ADJUST: 'blue', REVERSAL: 'red' } as const;
const whatsapp = (phone: string) => `https://wa.me/${phone.replace(/\D/g, '').replace(/^(?!55)/, '55')}`;
const numberValue = (value: string) => (value.trim() === '' ? 0 : Number(value));

function LoyaltyRules() {
  const [config, setConfig] = useState<LoyaltyConfig | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  useEffect(() => { api<{ settings: { loyalty: LoyaltyConfig } }>('/settings').then(result => setConfig(result.settings.loyalty)).catch(cause => setNotice({ text: errorMessage(cause, 'Falha ao carregar as regras'), kind: 'error' })); }, []);
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!config) return; setNotice(null);
    try { await api('/settings/loyalty', { method: 'PUT', body: JSON.stringify(config) }); setNotice({ text: 'Regras do programa salvas.', kind: 'success' }); } catch (cause) { setNotice({ text: errorMessage(cause, 'Somente gerentes alteram as regras'), kind: 'error' }); }
  }
  if (!config) return notice ? <Notice message={notice.text} /> : null;
  return <Section title="Regras do programa de fidelidade">
    {notice && <Notice message={notice.text} kind={notice.kind} />}
    <form onSubmit={save} className="grid gap-4 md:grid-cols-3">
      <div className="md:col-span-3"><Check label="Programa de fidelidade ativo (pontos por compra concluída)" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })} /></div>
      <Field label="Pontos por R$ 1,00 gasto" type="number" min={0} max={100} step="0.01" value={config.pointsPerReal} onChange={event => setConfig({ ...config, pointsPerReal: numberValue(event.target.value) })} />
      <Field label="Valor de cada ponto no resgate (R$)" type="number" min={0} max={10} step="0.01" value={config.redeemValuePerPoint} onChange={event => setConfig({ ...config, redeemValuePerPoint: numberValue(event.target.value) })} />
      <Field label="Resgate mínimo (pontos)" type="number" min={1} step="1" value={config.minRedeemPoints} onChange={event => setConfig({ ...config, minRedeemPoints: numberValue(event.target.value) })} />
      <Field label="Validade: expira após X dias sem comprar (0 = nunca)" type="number" min={0} max={3650} step="1" value={config.validityDays} onChange={event => setConfig({ ...config, validityDays: numberValue(event.target.value) })} />
      <Field label="Validade do cupom de resgate (dias)" type="number" min={1} max={365} step="1" value={config.couponValidDays} onChange={event => setConfig({ ...config, couponValidDays: numberValue(event.target.value) })} />
      <div className="flex items-end"><button className={buttonClass}>Salvar regras</button></div>
    </form>
    <p className="mt-3 text-xs text-slate-500">O resgate gera um cupom de uso único em valor fixo, aplicado no PDV como qualquer outro cupom. A expiração zera o saldo de quem ficou o período sem compras e fica registrada no extrato.</p>
  </Section>;
}

export function LoyaltyPanel() {
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<Customer[]>([]);
  const [view, setView] = useState<LoyaltyView | null>(null);
  const [points, setPoints] = useState('');
  const [adjust, setAdjust] = useState({ points: '', note: '' });
  const [redeemed, setRedeemed] = useState<Redeemed | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: 'error' | 'success' } | null>(null);
  const fail = (cause: unknown, fallback: string) => setNotice({ text: errorMessage(cause, fallback), kind: 'error' });

  const open = useCallback(async (id: string) => {
    try { setView(await api<LoyaltyView>(`/customers/${id}/loyalty`)); } catch (cause) { setNotice({ text: errorMessage(cause, 'Falha ao carregar o extrato'), kind: 'error' }); }
  }, []);
  async function lookup(event: React.FormEvent) {
    event.preventDefault(); setNotice(null);
    try { setFound((await api<ListResponse<Customer>>(`/customers?pageSize=10&search=${encodeURIComponent(search.trim())}`)).items); } catch (cause) { fail(cause, 'Falha ao buscar clientes'); }
  }
  async function redeem(event: React.FormEvent) {
    event.preventDefault(); if (!view) return; setNotice(null);
    try { setRedeemed(await api<Redeemed>(`/customers/${view.customer.id}/loyalty/redeem`, { method: 'POST', body: JSON.stringify({ points: numberValue(points) }) })); setPoints(''); await open(view.customer.id); } catch (cause) { fail(cause, 'Não foi possível resgatar'); }
  }
  async function adjustPoints(event: React.FormEvent) {
    event.preventDefault(); if (!view) return; setNotice(null);
    try { await api(`/customers/${view.customer.id}/loyalty/adjust`, { method: 'POST', body: JSON.stringify({ points: numberValue(adjust.points), note: adjust.note }) }); setAdjust({ points: '', note: '' }); setNotice({ text: 'Ajuste registrado.', kind: 'success' }); await open(view.customer.id); } catch (cause) { fail(cause, 'Não foi possível ajustar'); }
  }

  return <>
    <LoyaltyRules />
    <Section title="Extrato, resgate e ajuste de pontos">
      {notice && <Notice message={notice.text} kind={notice.kind} />}
      <form onSubmit={lookup} className="mb-4 flex flex-wrap items-end gap-3"><div className="min-w-60 flex-1"><Field label="Buscar cliente por nome ou telefone" value={search} onChange={event => setSearch(event.target.value)} /></div><button className={secondaryButtonClass}>Buscar</button></form>
      {found.length > 0 && <div className="mb-4 flex flex-wrap gap-2">{found.map(customer => <button key={customer.id} type="button" onClick={() => { setRedeemed(null); void open(customer.id); }} className={secondaryButtonClass}>{customer.name} · {customer.loyaltyPoints} pts</button>)}</div>}
      {!view ? <EmptyState icon="🎁" title="Escolha um cliente" hint="Busque pelo nome ou telefone para ver o saldo, o extrato e resgatar pontos." /> : <>
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div><p className="text-xs uppercase tracking-wider text-slate-500">Cliente</p><p className="text-lg font-bold">{view.customer.name}</p></div>
          <div><p className="text-xs uppercase tracking-wider text-slate-500">Saldo</p><p className="text-lg font-bold">{view.balance} pontos</p></div>
          <div><p className="text-xs uppercase tracking-wider text-slate-500">Equivale a</p><p className="text-lg font-bold">{formatMoney(view.worth)}</p></div>
        </div>
        {redeemed && <Notice kind="success" message={`Cupom ${redeemed.code} de ${formatMoney(redeemed.value)} gerado (uso único, válido até ${new Date(redeemed.validUntil).toLocaleDateString('pt-BR')}). Informe o código no PDV.`} />}
        <div className="mb-5 grid gap-4 lg:grid-cols-2">
          <form onSubmit={redeem} className="flex flex-wrap items-end gap-3"><div className="w-44"><Field label={`Resgatar pontos (mín. ${view.config.minRedeemPoints})`} type="number" min={1} step="1" value={points} onChange={event => setPoints(event.target.value)} /></div><button className={buttonClass} disabled={!view.config.enabled || numberValue(points) < 1}>Gerar cupom</button></form>
          <form onSubmit={adjustPoints} className="flex flex-wrap items-end gap-3"><div className="w-32"><Field label="Ajuste (+/−)" type="number" step="1" value={adjust.points} onChange={event => setAdjust({ ...adjust, points: event.target.value })} /></div><div className="min-w-48 flex-1"><Field label="Justificativa" minLength={3} maxLength={200} value={adjust.note} onChange={event => setAdjust({ ...adjust, note: event.target.value })} /></div><button className={secondaryButtonClass} disabled={numberValue(adjust.points) === 0 || adjust.note.trim().length < 3}>Ajustar</button></form>
        </div>
        {view.entries.length === 0 ? <EmptyState icon="🧾" title="Sem movimentações" hint="O extrato começa na próxima compra concluída deste cliente." /> : <DataTable columns={[{ label: 'Data' }, { label: 'Tipo' }, { label: 'Pontos' }, { label: 'Saldo' }, { label: 'Detalhe' }]}>
          {view.entries.map(entry => <tr key={entry.id}><td>{formatDateTime(entry.createdAt)}</td><td><Badge tone={typeTone[entry.type]}>{typeLabel[entry.type]}</Badge></td><td>{entry.points > 0 ? `+${entry.points}` : entry.points}</td><td>{entry.balanceAfter}</td><td className="text-xs text-slate-600">{[entry.couponCode && `Cupom ${entry.couponCode}`, entry.note].filter(Boolean).join(' · ') || '—'}</td></tr>)}
        </DataTable>}
      </>}
    </Section>
  </>;
}

type Campaign = { type: 'birthday' | 'inactive'; rule: string; total: number; items: { id: string; name: string; phone: string; email: string | null; birthDate?: string | null; loyaltyPoints: number; daysSinceLastOrder?: number | null }[] };

export function CampaignsPanel() {
  const [type, setType] = useState<'birthday' | 'inactive'>('birthday');
  const [days, setDays] = useState(90);
  const [loaded, setLoaded] = useState<{ key: string; data?: Campaign; error?: string } | null>(null);
  const key = `${type}:${days}`;
  useEffect(() => {
    let active = true;
    api<Campaign>(`/customers/campaigns?type=${type}&days=${days}`).then(data => { if (active) setLoaded({ key, data }); }).catch(cause => { if (active) setLoaded({ key, error: errorMessage(cause, 'Somente gerentes acessam as campanhas') }); });
    return () => { active = false; };
  }, [type, days, key]);
  const current = loaded?.key === key ? loaded : null;
  const data = current?.data;
  return <Section title="Campanhas de relacionamento" actions={<button type="button" className={secondaryButtonClass} disabled={!data || data.total === 0} onClick={() => data && exportCsv(`campanha-${type}.csv`, ['Nome', 'Telefone', 'E-mail', 'Pontos'], data.items.map(item => [item.name, item.phone, item.email ?? '', item.loyaltyPoints]))}>Exportar CSV</button>}>
    <div className="mb-4 flex flex-wrap items-end gap-2">
      <button type="button" aria-pressed={type === 'birthday'} onClick={() => setType('birthday')} className={type === 'birthday' ? buttonClass : secondaryButtonClass}>🎂 Aniversariantes do mês</button>
      <button type="button" aria-pressed={type === 'inactive'} onClick={() => setType('inactive')} className={type === 'inactive' ? buttonClass : secondaryButtonClass}>💤 Clientes inativos</button>
      {type === 'inactive' && <div className="w-40"><Field label="Sem comprar há (dias)" type="number" min={30} max={730} step="1" value={days} onChange={event => setDays(Math.min(730, Math.max(30, Number(event.target.value) || 90)))} /></div>}
    </div>
    {current?.error && <Notice message={current.error} />}
    {!current && <p className="text-sm text-slate-500">Carregando…</p>}
    {data && <>
      <p className="mb-3 text-xs text-slate-600">{data.rule}. Apenas clientes que autorizaram comunicações (LGPD) aparecem aqui; o contato é feito pelo WhatsApp oficial do estabelecimento.</p>
      {data.items.length === 0 ? <EmptyState icon="📣" title="Nenhum cliente nesta campanha" hint="Cadastre a data de aniversário e o consentimento de marketing em Clientes." /> : <DataTable columns={[{ label: 'Cliente' }, { label: type === 'birthday' ? 'Aniversário' : 'Dias sem comprar' }, { label: 'Pontos' }, { label: 'Contato' }]}>
        {data.items.slice(0, 300).map(item => <tr key={item.id}><td><strong>{item.name}</strong><div className="text-xs text-slate-500">{item.phone}</div></td><td>{type === 'birthday' ? (item.birthDate ? new Date(item.birthDate).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }) : '—') : item.daysSinceLastOrder ?? 'Nunca comprou'}</td><td>{item.loyaltyPoints}</td><td><a href={whatsapp(item.phone)} target="_blank" rel="noreferrer" className="text-sm font-semibold text-brand-700 hover:underline">WhatsApp</a></td></tr>)}
      </DataTable>}
    </>}
  </Section>;
}
