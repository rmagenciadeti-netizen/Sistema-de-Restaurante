'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, formatMoney } from '../lib/api';
import { buttonClass, Notice } from './app-shell';
import { DonutChart } from './charts';
import { Badge, DataTable, EmptyState, GoldCard, StatCard } from './ui';

type Diagnosis = { tone: 'good' | 'warning' | 'critical' | 'info'; title: string; detail: string; href?: string };
type Business = { diagnosis: Diagnosis[]; ai: { text: string; provider: string } | null; aiNote: string | null; aiAvailable: boolean; aiRemainingToday: number; source: string };
const toneBadge = { good: 'green', warning: 'gold', critical: 'red', info: 'blue' } as const;
const toneLabel = { good: 'Positivo', warning: 'Atenção', critical: 'Crítico', info: 'Informativo' } as const;

export function BusinessPanel() {
  const [data, setData] = useState<Business | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (useAi: boolean) => {
    setError(''); setBusy(true);
    try { setData(await api<Business>('/intelligence/business', { method: 'POST', body: JSON.stringify({ useAi }) })); } catch (cause) { setError(errorMessage(cause, 'Falha ao gerar a análise de negócios')); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void run(false); }, [run]);

  return <GoldCard number={1} title="Inteligência de negócios com IA" subtitle="Diagnóstico executivo com seus dados reais" actions={<button type="button" className={buttonClass} disabled={busy || data?.aiAvailable === false} title={data?.aiAvailable === false ? 'IA generativa não configurada neste ambiente' : undefined} onClick={() => void run(true)}>{busy ? 'Analisando…' : '✨ Gerar análise com IA'}</button>}>
    {error && <Notice message={error} />}
    {!data && !error && <p className="text-sm text-slate-500">Analisando os dados…</p>}
    {data && <>
      <ul className="space-y-2">
        {data.diagnosis.map(item => <li key={item.title} className="flex flex-wrap items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <Badge tone={toneBadge[item.tone]}>{toneLabel[item.tone]}</Badge>
          <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-slate-900">{item.title}</p><p className="text-xs text-slate-600">{item.detail}</p></div>
          {item.href && <Link href={item.href} className="text-xs font-semibold text-brand-700 hover:text-brand-600">Abrir ›</Link>}
        </li>)}
      </ul>
      {data.ai && <div className="mt-4 rounded-xl border border-brand-400 bg-brand-50 p-4"><p className="mb-1 text-xs font-bold uppercase tracking-wider text-brand-700">Análise da IA (narrativa gerada a partir dos números acima)</p><p className="whitespace-pre-line text-sm text-slate-900">{data.ai.text}</p></div>}
      {data.aiNote && <p role="status" className="mt-3 text-xs text-amber-800">ℹ {data.aiNote}</p>}
      <p className="mt-3 text-xs text-slate-500">{data.source} {data.aiAvailable ? `Análises com IA restantes hoje: ${data.aiRemainingToday}.` : 'A IA generativa é opcional e só é ativada com AI_API_KEY e AI_MODEL no servidor; sem ela o diagnóstico continua funcionando.'}</p>
    </>}
  </GoldCard>;
}

type Stock = {
  items: { id: string; name: string; unit: string; current: number; minimum: number | null; consumed30: number; coverageDays: number | null; critical: boolean; suggestedPurchase: number; estimatedCost: number }[];
  waste: { name: string; unit: string; quantity: number; cost: number }[]; wasteCost: number; purchaseTotal: number;
  abc: { name: string; quantity: number; revenue: number; share: number; curve: 'A' | 'B' | 'C' }[];
  products: { lowStock: { name: string; current: number; minimum: number }[]; withoutRecipe: number; total: number }; note: string;
};

export function StockPanel() {
  const [data, setData] = useState<Stock | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<Stock>('/intelligence/stock').then(setData).catch(cause => setError(errorMessage(cause, 'Falha ao carregar a inteligência de estoque'))); }, []);
  if (error) return <Notice message={error} />;
  if (!data) return <p className="text-sm text-slate-500">Analisando o estoque…</p>;
  const critical = data.items.filter(item => item.critical);
  const suggestions = data.items.filter(item => item.suggestedPurchase > 0);
  const curveTotals = (['A', 'B', 'C'] as const).map(curve => ({ label: `Curva ${curve}`, value: data.abc.filter(row => row.curve === curve).reduce((sum, row) => sum + row.revenue, 0) })).filter(row => row.value > 0);
  return <>
    <div className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard tone="dark" icon="⚠️" label="Insumos críticos" value={critical.length} hint={`${data.items.length} insumo(s) ativo(s)`} />
      <StatCard icon="🛒" label="Compra sugerida" value={formatMoney(data.purchaseTotal)} hint={`${suggestions.length} item(ns) a repor`} />
      <StatCard icon="🗑️" label="Perdas em 30 dias" value={formatMoney(data.wasteCost)} hint={`${data.waste.length} insumo(s) com perda`} />
      <StatCard icon="📋" label="Sem ficha técnica" value={data.products.withoutRecipe} hint={`de ${data.products.total} produto(s) ativo(s)`} />
    </div>
    <GoldCard number={1} title="Reposição inteligente" subtitle="Cobertura pelo consumo real dos últimos 30 dias" actions={<Link href="/purchasing" className="rounded-xl bg-gradient-to-b from-brand-300 to-brand-500 px-3 py-2 text-sm font-semibold text-neutral-950">Abrir compras</Link>}>
      {data.items.length === 0 ? <EmptyState icon="📦" title="Nenhum insumo cadastrado" hint="Cadastre insumos e fichas técnicas em Estoque para ativar a análise." action={<Link href="/inventory" className="text-sm font-semibold text-brand-700">Ir para Estoque ›</Link>} /> : <DataTable columns={[{ label: 'Insumo' }, { label: 'Atual' }, { label: 'Mínimo' }, { label: 'Consumo 30d' }, { label: 'Cobertura' }, { label: 'Sugestão de compra' }, { label: 'Custo estimado' }]}>
        {data.items.map(item => <tr key={item.id}><td className="font-semibold">{item.name}{item.critical && <> <Badge tone="red">Crítico</Badge></>}</td><td>{item.current} {item.unit}</td><td>{item.minimum ?? '—'}</td><td>{item.consumed30} {item.unit}</td><td>{item.coverageDays === null ? 'sem consumo' : `${item.coverageDays} dia(s)`}</td><td>{item.suggestedPurchase > 0 ? `${item.suggestedPurchase} ${item.unit}` : '—'}</td><td>{item.estimatedCost > 0 ? formatMoney(item.estimatedCost) : '—'}</td></tr>)}
      </DataTable>}
      <p className="mt-3 text-xs text-slate-500">{data.note}</p>
    </GoldCard>
    <div className="grid gap-6 xl:grid-cols-2">
      <GoldCard number={2} title="Curva ABC de produtos" subtitle="Faturamento dos últimos 30 dias">
        {data.abc.length === 0 ? <EmptyState icon="🍽️" title="Sem vendas no período" /> : <>
          <DonutChart centerLabel="Curva ABC" format={formatMoney} slices={curveTotals} />
          <div className="mt-4 max-h-72 overflow-y-auto"><DataTable columns={[{ label: 'Produto' }, { label: 'Qtd.' }, { label: 'Faturamento' }, { label: '%' }, { label: 'Curva' }]}>
            {data.abc.slice(0, 30).map(row => <tr key={row.name}><td>{row.name}</td><td>{row.quantity}</td><td>{formatMoney(row.revenue)}</td><td>{row.share}%</td><td><Badge tone={row.curve === 'A' ? 'green' : row.curve === 'B' ? 'gold' : 'neutral'}>{row.curve}</Badge></td></tr>)}
          </DataTable></div>
        </>}
      </GoldCard>
      <GoldCard number={3} title="Desperdício e produtos com saldo baixo" subtitle="Perdas valorizadas pelo custo registrado">
        {data.waste.length === 0 ? <p className="mb-4 text-sm text-slate-500">Nenhuma perda registrada em 30 dias.</p> : <div className="mb-4"><DataTable columns={[{ label: 'Insumo' }, { label: 'Quantidade' }, { label: 'Custo' }]}>{data.waste.map(row => <tr key={row.name}><td>{row.name}</td><td>{row.quantity} {row.unit}</td><td>{formatMoney(row.cost)}</td></tr>)}</DataTable></div>}
        {data.products.lowStock.length > 0 && <DataTable columns={[{ label: 'Produto com controle de saldo' }, { label: 'Saldo' }, { label: 'Mínimo' }]}>{data.products.lowStock.map(row => <tr key={row.name}><td>{row.name}</td><td>{row.current}</td><td>{row.minimum}</td></tr>)}</DataTable>}
      </GoldCard>
    </div>
  </>;
}

type SalesData = { topProducts: { name: string; quantity: number; revenue: number }[]; lessSold: { name: string; quantity: number }[]; topMargins: { name: string; marginPercent: number }[]; sales: { byChannel: { channel: string; share: number }[]; peakHours: { hour: number; orders: number }[] } };
const channelNames: Record<string, string> = { POS: 'PDV', TABLE: 'Mesa / QR Code', DELIVERY: 'Delivery', TAKEAWAY: 'Retirada', WHATSAPP: 'WhatsApp' };

// Rule-based suggestions: every line cites the real figure that triggered it.
export function SalesOpportunities({ data }: { data: SalesData }) {
  const tips: { icon: string; title: string; detail: string }[] = [];
  const top = new Set(data.topProducts.map(item => item.name));
  const peak = data.sales.peakHours[0];
  if (peak) tips.push({ icon: '⏰', title: `Reforce a operação às ${String(peak.hour).padStart(2, '0')}h`, detail: `É o horário de maior movimento (${peak.orders} pedidos). Antecipe preparo e escale a equipe; avalie uma promoção fora desse horário para distribuir a demanda.` });
  for (const item of data.lessSold.filter(entry => entry.quantity <= 2).slice(0, 3)) tips.push({ icon: '🏷️', title: `Promova “${item.name}”`, detail: `Vendeu ${item.quantity} unidade(s) em 30 dias. Crie um combo ou promoção, ou revise a posição no cardápio.` });
  for (const item of data.topMargins.filter(entry => !top.has(entry.name)).slice(0, 3)) tips.push({ icon: '💹', title: `Destaque “${item.name}”`, detail: `Margem de ${item.marginPercent}% e fora dos mais vendidos: dar visibilidade no PDV e no cardápio digital aumenta o lucro.` });
  const lead = data.sales.byChannel[0];
  if (lead && lead.share >= 80) tips.push({ icon: '🔀', title: `Dependência do canal ${channelNames[lead.channel] ?? lead.channel}`, detail: `${lead.share}% do faturamento vem de um único canal. Considere ativar cardápio por QR Code, delivery ou WhatsApp.` });
  return <GoldCard number={4} title="Oportunidades e campanhas sugeridas" subtitle="Sugestões geradas a partir das vendas registradas">
    {tips.length === 0 ? <EmptyState icon="💡" title="Sem sugestões por enquanto" hint="Registre mais vendas e custos para o RM Inteligência identificar oportunidades." /> : <ul className="grid gap-3 md:grid-cols-2">
      {tips.map(tip => <li key={tip.title} className="flex gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3"><span aria-hidden="true" className="text-2xl">{tip.icon}</span><div><p className="text-sm font-semibold text-slate-900">{tip.title}</p><p className="text-xs text-slate-600">{tip.detail}</p></div></li>)}
    </ul>}
    <div className="mt-3 flex flex-wrap gap-3 text-xs font-semibold text-brand-700"><Link href="/promotions">Criar promoção ›</Link><Link href="/coupons">Criar cupom ›</Link></div>
  </GoldCard>;
}
