'use client';

import type { ReactNode } from 'react';
import { formatMoney } from '../../lib/api';
import { DataTable, EmptyState, StatCard } from '../ui';
import type { AiDomainKey, AiToolResult } from '../../lib/types-ai';

const pct = (value: number | null | undefined) => (value === null || value === undefined ? '—' : `${Number(value).toFixed(2).replace('.', ',')}%`);
const money = (value: number | null | undefined) => (value === null || value === undefined ? '—' : formatMoney(value));
const minutes = (value: { minutes: number; samples: number } | null | undefined) => (value ? `${value.minutes} min` : '—');
const Grid = ({ children }: { children: ReactNode }) => <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">{children}</div>;
const Section = ({ title, children }: { title: string; children: ReactNode }) => <section className="mt-5"><h3 className="mb-2 font-semibold">{title}</h3>{children}</section>;
const Empty = ({ text }: { text: string }) => <EmptyState icon="✅" title={text} />;

type View = (props: { d: Record<string, any> }) => ReactNode;

const Finance: View = ({ d }) => <>
  <Grid>
    <StatCard icon="📤" label="A pagar em aberto" value={money(d.payablesOpen)} hint={`Vencido: ${money(d.payablesOverdue)} (${d.overdueCount.payables})`} />
    <StatCard icon="📥" label="A receber em aberto" value={money(d.receivablesOpen)} hint={`Inadimplência: ${money(d.receivablesOverdue)} (${d.overdueCount.receivables})`} />
    <StatCard icon="💵" label="Fluxo realizado no período" value={money(d.realizedCashFlow.net)} hint={`Entradas ${money(d.realizedCashFlow.totalIn)} − saídas ${money(d.realizedCashFlow.expensesPaid)}`} tone="dark" />
    <StatCard icon="🔮" label="Projeção 30 dias (estimativa)" value={money(d.projectedNet30d)} hint={`Entradas ${money(d.receivablesNext30d)} · saídas ${money(d.payablesNext30d)}`} />
  </Grid>
  <Section title="Recebimentos de vendas por forma de pagamento">{d.receiptsByMethod.length === 0 ? <Empty text="Sem recebimentos no período" /> : <DataTable columns={[{ label: 'Forma' }, { label: 'Valor', className: 'text-right' }]}>{d.receiptsByMethod.map((row: any) => <tr key={row.method}><td>{row.method}</td><td className="text-right">{money(row.amount)}</td></tr>)}</DataTable>}</Section>
  <Section title="Maiores despesas pagas">{d.topExpenseCategories.length === 0 ? <Empty text="Sem despesas pagas no período" /> : <DataTable columns={[{ label: 'Categoria' }, { label: 'Valor', className: 'text-right' }]}>{d.topExpenseCategories.map((row: any) => <tr key={row.category}><td>{row.category}</td><td className="text-right">{money(row.amount)}</td></tr>)}</DataTable>}</Section>
</>;

const Sales: View = ({ d }) => <>
  <Grid>
    <StatCard icon="🧾" label="Faturamento" value={money(d.revenue)} hint={`${d.orders} venda(s) · ${d.cancelledOrders} cancelada(s)`} tone="dark" />
    <StatCard icon="🎫" label="Ticket médio" value={money(d.averageTicket)} />
    <StatCard icon="📊" label="Variação sobre o período anterior" value={pct(d.revenueChangePercent)} hint={`Anterior: ${money(d.previousPeriod.revenue)}`} />
    <StatCard icon="📅" label="Média por dia" value={money(d.dailyAverage)} />
  </Grid>
  {d.forecast && (d.forecast.unavailable
    ? <Section title="Previsão de vendas"><Empty text={d.forecast.reason} /></Section>
    : <Section title="Previsão de vendas (estimativa)">
        <Grid>
          <StatCard icon="🔮" label="Próximos 7 dias" value={money(d.forecast.week.expected)} hint={`Faixa provável: ${money(d.forecast.week.low)} a ${money(d.forecast.week.high)}`} />
          {d.forecast.month && <StatCard icon="📆" label="Projeção do mês" value={money(d.forecast.month.projection)} hint={`Faixa: ${money(d.forecast.month.low)} a ${money(d.forecast.month.high)} · ${d.forecast.month.remainingDays} dia(s) restantes`} />}
        </Grid>
        <p className="mt-2 text-xs text-slate-500">Método: {d.forecast.method}. {d.forecast.uncertainty}</p>
      </Section>)}
  {d.goal && (d.goal.unavailable
    ? <Section title="Meta mensal"><Empty text={d.goal.reason} /></Section>
    : <Section title="Meta mensal">
        <Grid>
          <StatCard icon="🎯" label="Meta" value={money(d.goal.goal)} hint={`Realizado no mês: ${money(d.goal.monthToDate)}`} tone="dark" />
          <StatCard icon="⏳" label="Falta" value={money(d.goal.missing)} hint={d.goal.reached ? 'Meta atingida' : `${money(d.goal.perDay)} por dia nos ${d.goal.remainingDays} dia(s) restantes`} />
          {d.goal.projectedToReach !== null && <StatCard icon="📈" label="Projeção alcança a meta?" value={d.goal.projectedToReach ? 'Sim (estimativa)' : 'Não (estimativa)'} hint={d.goal.projectedRange ? `Faixa: ${money(d.goal.projectedRange.low)} a ${money(d.goal.projectedRange.high)}` : undefined} />}
        </Grid>
      </Section>)}
  <Section title="Por canal"><DataTable columns={[{ label: 'Canal' }, { label: 'Vendas', className: 'text-right' }, { label: 'Faturamento', className: 'text-right' }]}>{d.byChannel.map((row: any) => <tr key={row.channel}><td>{row.channel}</td><td className="text-right">{row.orders}</td><td className="text-right">{money(row.revenue)}</td></tr>)}</DataTable></Section>
  <Section title="Produtos (curva ABC)">{d.topProducts.length === 0 ? <Empty text="Sem itens vendidos" /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Classe' }, { label: 'Qtd.', className: 'text-right' }, { label: 'Faturamento', className: 'text-right' }]}>{d.topProducts.map((row: any) => <tr key={row.productId}><td>{row.name}</td><td>{row.class}</td><td className="text-right">{row.quantity}</td><td className="text-right">{money(row.revenue)}</td></tr>)}</DataTable>}</Section>
  <Section title="Por dia da semana (média)"><DataTable columns={[{ label: 'Dia' }, { label: 'Média por dia', className: 'text-right' }]}>{d.byWeekday.map((row: any) => <tr key={row.weekday}><td>{row.weekday}</td><td className="text-right">{money(row.averageRevenuePerDay)}</td></tr>)}</DataTable></Section>
  {d.byAttendant.length > 0 && <Section title="Por atendente"><DataTable columns={[{ label: 'Atendente' }, { label: 'Vendas', className: 'text-right' }, { label: 'Faturamento', className: 'text-right' }]}>{d.byAttendant.map((row: any) => <tr key={row.name}><td>{row.name}</td><td className="text-right">{row.orders}</td><td className="text-right">{money(row.revenue)}</td></tr>)}</DataTable></Section>}
</>;

const Profit: View = ({ d }) => <>
  <Grid>
    <StatCard icon="🧮" label="CMV" value={money(d.period.cmv)} hint={`${pct(d.period.cmvPercent)} da receita com custo`} tone="dark" />
    <StatCard icon="📈" label="Margem bruta" value={pct(d.period.grossMarginPercent)} hint={money(d.period.grossProfit)} />
    <StatCard icon="⚖️" label="Margem de contribuição (estimada)" value={pct(d.period.contributionMarginPercent)} hint={`Encargos variáveis aplicados: ${pct(d.period.variableChargesPercentApplied)}`} />
    <StatCard icon="🧾" label="Cobertura de custo" value={pct(d.period.costCoveragePercent)} hint={`Receita ${money(d.period.revenue)}`} />
  </Grid>
  <Section title="Produtos fora da meta de formação de preço">{d.planning.negativeProducts.length === 0 ? <Empty text="Nenhum produto abaixo do ponto de equilíbrio" /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Preço', className: 'text-right' }, { label: 'Preço mínimo', className: 'text-right' }, { label: 'Recomendado', className: 'text-right' }]}>{d.planning.negativeProducts.map((row: any) => <tr key={row.product}><td>{row.product}</td><td className="text-right">{money(row.price)}</td><td className="text-right">{money(row.minimumPrice)}</td><td className="text-right">{money(row.recommendedPrice)}</td></tr>)}</DataTable>}</Section>
  <Section title="Menores margens realizadas">{d.lowestRealizedMargins.length === 0 ? <Empty text="Sem vendas com custo registrado" /> : <DataTable columns={[{ label: 'Produto' }, { label: 'Faturamento', className: 'text-right' }, { label: 'Margem bruta', className: 'text-right' }]}>{d.lowestRealizedMargins.map((row: any) => <tr key={row.product}><td>{row.product}</td><td className="text-right">{money(row.revenue)}</td><td className="text-right">{pct(row.grossMarginPercent)}</td></tr>)}</DataTable>}</Section>
  <Section title="Por canal"><DataTable columns={[{ label: 'Canal' }, { label: 'Faturamento', className: 'text-right' }, { label: 'Margem bruta', className: 'text-right' }]}>{d.byChannel.map((row: any) => <tr key={row.channel}><td>{row.channel}</td><td className="text-right">{money(row.revenue)}</td><td className="text-right">{pct(row.grossMarginPercent)}</td></tr>)}</DataTable></Section>
  <Section title="Definições (sem misturar conceitos)"><ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">{Object.entries(d.definitions).map(([key, text]) => <li key={key}>{String(text)}</li>)}</ul></Section>
</>;

const Stock: View = ({ d }) => <>
  <Grid>
    <StatCard icon="📦" label="Insumos acompanhados" value={d.ingredientsTracked} tone="dark" />
    <StatCard icon="🚨" label="Em risco de ruptura" value={d.atRisk.length} />
    <StatCard icon="🕸️" label="Parados (30+ dias)" value={d.staleCount} />
    <StatCard icon="📝" label="Ajustes de inventário" value={d.inventoryAdjustments.count} hint={`Saldo líquido ${d.inventoryAdjustments.netQuantity}`} />
  </Grid>
  <Section title="Cobertura e risco">{d.atRisk.length === 0 ? <Empty text="Nenhum insumo em risco" /> : <DataTable columns={[{ label: 'Insumo' }, { label: 'Saldo', className: 'text-right' }, { label: 'Mínimo', className: 'text-right' }, { label: 'Consumo/dia', className: 'text-right' }, { label: 'Cobertura (dias)', className: 'text-right' }]}>{d.atRisk.map((row: any) => <tr key={row.name}><td>{row.name}</td><td className="text-right">{row.stock} {row.unit}</td><td className="text-right">{row.minimum ?? '—'}</td><td className="text-right">{row.avgDailyConsumption || '—'}</td><td className="text-right">{row.coverageDays ?? 'sem consumo'}</td></tr>)}</DataTable>}</Section>
  <Section title={`Curva ABC de produtos (A ${d.abc.A} · B ${d.abc.B} · C ${d.abc.C})`}><DataTable columns={[{ label: 'Produto' }, { label: 'Classe' }, { label: 'Qtd.', className: 'text-right' }]}>{d.abc.top.map((row: any) => <tr key={row.name}><td>{row.name}</td><td>{row.class}</td><td className="text-right">{row.quantity}</td></tr>)}</DataTable></Section>
  {d.productsBelowMinimum.length > 0 && <Section title="Produtos abaixo do estoque mínimo"><DataTable columns={[{ label: 'Produto' }, { label: 'Saldo', className: 'text-right' }, { label: 'Mínimo', className: 'text-right' }]}>{d.productsBelowMinimum.map((row: any) => <tr key={row.name}><td>{row.name}</td><td className="text-right">{row.stock}</td><td className="text-right">{row.minimum}</td></tr>)}</DataTable></Section>}
</>;

const Purchasing: View = ({ d }) => <>
  <Grid>
    <StatCard icon="🛒" label="Compras sugeridas" value={d.suggestions.length} tone="dark" hint="Estimativa — nada é comprado automaticamente" />
    <StatCard icon="⏱️" label="Lead time usado" value={`${d.leadDaysUsed} dia(s)`} hint={d.leadDaysSource} />
    <StatCard icon="💲" label="Variações de preço" value={d.priceChanges.length} />
    <StatCard icon="🚚" label="Compras recebidas analisadas" value={d.receivedPurchasesAnalyzed} />
  </Grid>
  <Section title="Necessidade de compra">{d.suggestions.length === 0 ? <Empty text="Sem necessidade de compra pelo consumo recente" /> : <DataTable columns={[{ label: 'Insumo' }, { label: 'Saldo', className: 'text-right' }, { label: 'Consumo/dia', className: 'text-right' }, { label: 'Sugerido', className: 'text-right' }]}>{d.suggestions.map((row: any) => <tr key={row.name}><td>{row.name}</td><td className="text-right">{row.stock} {row.unit}</td><td className="text-right">{row.avgDailyConsumption}</td><td className="text-right font-semibold">{row.suggestedQuantity} {row.unit}</td></tr>)}</DataTable>}</Section>
  <Section title="Lead time por fornecedor">{d.leadTimeBySupplier.length === 0 ? <Empty text="Sem compras recebidas para medir" /> : <DataTable columns={[{ label: 'Fornecedor' }, { label: 'Dias (média)', className: 'text-right' }, { label: 'Amostras', className: 'text-right' }]}>{d.leadTimeBySupplier.map((row: any) => <tr key={row.supplier}><td>{row.supplier}</td><td className="text-right">{row.averageLeadDays}</td><td className="text-right">{row.samples}</td></tr>)}</DataTable>}</Section>
  <Section title="Variação de preços">{d.priceChanges.length === 0 ? <Empty text="Sem variações relevantes" /> : <DataTable columns={[{ label: 'Insumo' }, { label: 'Fornecedor' }, { label: 'Anterior', className: 'text-right' }, { label: 'Último', className: 'text-right' }, { label: 'Variação', className: 'text-right' }]}>{d.priceChanges.map((row: any) => <tr key={row.ingredient}><td>{row.ingredient}</td><td>{row.supplier}</td><td className="text-right">{money(row.previousUnitCost)}</td><td className="text-right">{money(row.lastUnitCost)}</td><td className="text-right">{pct(row.changePercent)}</td></tr>)}</DataTable>}</Section>
  {d.supplierComparison.length > 0 && <Section title="Comparação de fornecedores"><DataTable columns={[{ label: 'Insumo' }, { label: 'Fornecedores (último custo unitário)' }]}>{d.supplierComparison.map((row: any) => <tr key={row.ingredient}><td>{row.ingredient}</td><td>{row.suppliers.map((item: any) => `${item.supplier}: ${money(item.lastUnitCost)}`).join(' · ')}</td></tr>)}</DataTable></Section>}
</>;

const Customers: View = ({ d }) => <>
  <Grid>
    <StatCard icon="👥" label="Clientes ativos" value={d.customers} tone="dark" />
    <StatCard icon="🛍️" label="Com compras" value={d.withOrders} />
    <StatCard icon="🔁" label="Compraram no período" value={d.activeInPeriod} />
    <StatCard icon="✉️" label="Com consentimento de marketing" value={d.withMarketingConsent} />
  </Grid>
  {d.segments && <Section title="Segmentos"><DataTable columns={[{ label: 'Segmento' }, { label: 'Clientes', className: 'text-right' }]}>{Object.entries(d.segments).map(([name, count]) => <tr key={name}><td>{name}</td><td className="text-right">{String(count)}</td></tr>)}</DataTable></Section>}
  {d.topCustomers && <Section title="Maiores clientes"><DataTable columns={[{ label: 'Cliente' }, { label: 'Segmento' }, { label: 'Pedidos', className: 'text-right' }, { label: 'Valor', className: 'text-right' }]}>{d.topCustomers.map((row: any) => <tr key={row.name}><td>{row.name}</td><td>{row.segment}</td><td className="text-right">{row.orders}</td><td className="text-right">{money(row.spent)}</td></tr>)}</DataTable></Section>}
  <p className="mt-4 text-xs text-slate-500">{d.privacy} {d.campaignHint}</p>
</>;

const Delivery: View = ({ d }) => <>
  <Grid>
    <StatCard icon="🛵" label="Entregas" value={d.jobs} hint={`${d.delivered} entregue(s) · ${d.cancelled} cancelada(s)`} tone="dark" />
    <StatCard icon="⏳" label="Espera até despacho" value={minutes(d.averageWaitUntilDispatch)} />
    <StatCard icon="🛣️" label="Tempo em rota" value={minutes(d.averageRouteTime)} />
    <StatCard icon="⏱️" label="Pedido → entrega" value={minutes(d.averageTotalTime)} hint={`${d.lateDeliveries.count} acima de ${d.lateDeliveries.threshold} min`} />
  </Grid>
  <p className="mt-3 text-sm text-slate-600">{d.bottleneck ? `Gargalo: ${d.bottleneck.stage} (${d.bottleneck.minutes} min em média).` : 'Sem dados suficientes para apontar gargalo.'} {d.withoutTimestamps > 0 ? `${d.withoutTimestamps} entrega(s) sem horários completos ficaram fora das médias.` : ''}</p>
  <Section title="Por entregador">{d.byCourier.length === 0 ? <Empty text="Sem entregas medidas" /> : <DataTable columns={[{ label: 'Entregador' }, { label: 'Entregas', className: 'text-right' }, { label: 'Rota (média)', className: 'text-right' }]}>{d.byCourier.map((row: any) => <tr key={row.courier}><td>{row.courier}</td><td className="text-right">{row.deliveries}</td><td className="text-right">{row.averageRouteMinutes} min</td></tr>)}</DataTable>}</Section>
</>;

const Production: View = ({ d }) => <>
  <Grid>
    <StatCard icon="🍳" label="Itens na fila agora" value={d.itemsInQueue} tone="dark" />
    <StatCard icon="⚠️" label={`Pedidos atrasados (> ${d.delayedOrders.thresholdMinutes} min)`} value={d.delayedOrders.count} />
    <StatCard icon="✅" label="Itens concluídos no período" value={d.itemsReadyInPeriod} hint={`${d.itemsPerDay}/dia`} />
    <StatCard icon="🧱" label="Maior fila" value={d.bottleneckSector ? d.bottleneckSector.sector : '—'} hint={d.bottleneckSector ? `${d.bottleneckSector.queuedItems} item(ns)` : undefined} />
  </Grid>
  <Section title="Por setor">{d.sectors.length === 0 ? <Empty text="Sem itens em produção no período" /> : <DataTable columns={[{ label: 'Setor' }, { label: 'Na fila', className: 'text-right' }, { label: 'Espera do mais antigo', className: 'text-right' }, { label: 'Preparo (média)', className: 'text-right' }, { label: 'Concluídos', className: 'text-right' }]}>{d.sectors.map((row: any) => <tr key={row.sector}><td>{row.sector}</td><td className="text-right">{row.queuedItems}</td><td className="text-right">{row.oldestWaitingMinutes === null ? '—' : `${row.oldestWaitingMinutes} min`}</td><td className="text-right">{row.averagePrepMinutes === null ? '—' : `${row.averagePrepMinutes} min`}</td><td className="text-right">{row.itemsReady}</td></tr>)}</DataTable>}</Section>
</>;

const Waste: View = ({ d }) => <>
  <Grid>
    <StatCard icon="🗑️" label="Perdas registradas" value={d.recordedWaste.occurrences} hint={d.recordedWaste.estimatedCost === undefined ? undefined : `Custo estimado ${money(d.recordedWaste.estimatedCost)}`} tone="dark" />
    <StatCard icon="🔎" label="Diferenças de inventário (negativas)" value={d.inventoryShortfall.occurrences} hint={d.inventoryShortfall.estimatedCost === undefined ? 'Perda não registrada (estimativa)' : `${money(d.inventoryShortfall.estimatedCost)} — estimativa`} />
    <StatCard icon="📉" label="Tendência" value={d.trend.direction} />
  </Grid>
  <p className="mt-3 text-xs text-slate-500">{d.recordedWaste.costBasis}</p>
  <Section title="Por insumo">{d.byIngredient.length === 0 ? <Empty text="Sem perdas registradas" /> : <DataTable columns={[{ label: 'Insumo' }, { label: 'Quantidade', className: 'text-right' }, ...(d.byIngredient[0].cost !== undefined ? [{ label: 'Custo', className: 'text-right' }] : [])]}>{d.byIngredient.map((row: any) => <tr key={row.ingredient}><td>{row.ingredient}</td><td className="text-right">{row.quantity} {row.unit}</td>{row.cost !== undefined && <td className="text-right">{money(row.cost)}</td>}</tr>)}</DataTable>}</Section>
</>;

const Units: View = ({ d }) => <Section title="Comparação entre unidades">{d.units.length === 0 ? <Empty text="Sem vendas no período" /> : <DataTable columns={[{ label: 'Unidade' }, { label: 'Vendas', className: 'text-right' }, { label: 'Faturamento', className: 'text-right' }, { label: 'Anterior', className: 'text-right' }, { label: 'Variação', className: 'text-right' }]}>{d.units.map((row: any) => <tr key={row.unit}><td>{row.unit}</td><td className="text-right">{row.orders}</td><td className="text-right">{money(row.revenue)}</td><td className="text-right">{money(row.previousRevenue)}</td><td className="text-right">{pct(row.changePercent)}</td></tr>)}</DataTable>}</Section>;

// Each specialist has its own panel layout; "management" shows the consolidated view (see ManagementPanel) plus the unit comparison.
const VIEWS: Record<string, View> = { 'finance.overview': Finance, 'sales.summary': Sales, 'profit.margins': Profit, 'stock.coverage': Stock, 'purchasing.needs': Purchasing, 'customers.rfm': Customers, 'delivery.performance': Delivery, 'production.flow': Production, 'waste.summary': Waste, 'management.units': Units };
export function SpecialistView({ result }: { result: AiToolResult }) { const View = VIEWS[result.tool]; return View ? <View d={result.data} /> : null; }
export const DOMAIN_TITLES: Record<AiDomainKey, string> = { finance: 'Gestão financeira', stock: 'Estoque', profit: 'Lucro e rentabilidade', sales: 'Vendas', purchasing: 'Compras e reposição', customers: 'Clientes', delivery: 'Delivery', production: 'Produção', waste: 'Desperdícios', management: 'Gerencial' };
