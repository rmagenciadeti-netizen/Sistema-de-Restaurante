import { localParts } from './scheduling';

// Pure analytics over real sales. Nothing here invents data: every function returns null/empty when there is not enough history.
export type Sale = { at: Date; total: number; channel: string; userId: string | null };
export type SalesAnalysis = {
  today: number; yesterday: number; ordersToday: number; monthToDate: number; ordersMonth: number; avgTicketMonth: number | null;
  previousMonthSamePeriod: number; monthChangePercent: number | null; bestDay: { day: string; total: number } | null;
  byChannel: { channel: string; orders: number; total: number; share: number }[]; peakHours: { hour: number; orders: number }[];
  byUser: { userId: string; orders: number; total: number }[]; dayTotals: Map<string, number>; daysWithSales: number;
};

export const addDays = (day: string, delta: number) => new Date(new Date(`${day}T12:00:00Z`).getTime() + delta * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const round2 = (value: number) => Math.round(value * 100) / 100;

export function analyzeSales(sales: Sale[], now: Date, timeZone: string): SalesAnalysis {
  const today = localParts(now, timeZone).day;
  const yesterday = addDays(today, -1);
  const month = today.slice(0, 7);
  const previousMonth = addDays(`${month}-01`, -1).slice(0, 7);
  const dayOfMonth = today.slice(8, 10);
  const dayTotals = new Map<string, number>();
  const orderCounts = new Map<string, number>();
  const channels = new Map<string, { orders: number; total: number }>();
  const hours = new Map<number, number>();
  const users = new Map<string, { orders: number; total: number }>();
  let monthToDate = 0; let ordersMonth = 0; let previousMonthSamePeriod = 0;
  for (const sale of sales) {
    const parts = localParts(sale.at, timeZone);
    dayTotals.set(parts.day, (dayTotals.get(parts.day) ?? 0) + sale.total);
    orderCounts.set(parts.day, (orderCounts.get(parts.day) ?? 0) + 1);
    if (parts.day.startsWith(month) && parts.day <= today) { monthToDate += sale.total; ordersMonth += 1; }
    if (parts.day.startsWith(previousMonth) && parts.day.slice(8, 10) <= dayOfMonth) previousMonthSamePeriod += sale.total;
    const channel = channels.get(sale.channel) ?? { orders: 0, total: 0 };
    channels.set(sale.channel, { orders: channel.orders + 1, total: channel.total + sale.total });
    const hour = Math.floor(parts.minutes / 60);
    hours.set(hour, (hours.get(hour) ?? 0) + 1);
    if (sale.userId) { const user = users.get(sale.userId) ?? { orders: 0, total: 0 }; users.set(sale.userId, { orders: user.orders + 1, total: user.total + sale.total }); }
  }
  const grand = sales.reduce((sum, sale) => sum + sale.total, 0);
  const best = [...dayTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    today: round2(dayTotals.get(today) ?? 0), yesterday: round2(dayTotals.get(yesterday) ?? 0), ordersToday: orderCounts.get(today) ?? 0,
    monthToDate: round2(monthToDate), ordersMonth, avgTicketMonth: ordersMonth > 0 ? round2(monthToDate / ordersMonth) : null,
    previousMonthSamePeriod: round2(previousMonthSamePeriod),
    monthChangePercent: previousMonthSamePeriod > 0 ? round2(((monthToDate - previousMonthSamePeriod) / previousMonthSamePeriod) * 100) : null,
    bestDay: best ? { day: best[0], total: round2(best[1]) } : null,
    byChannel: [...channels.entries()].map(([channel, value]) => ({ channel, orders: value.orders, total: round2(value.total), share: grand > 0 ? round2((value.total / grand) * 100) : 0 })).sort((a, b) => b.total - a.total),
    peakHours: [...hours.entries()].map(([hour, orders]) => ({ hour, orders })).sort((a, b) => b.orders - a.orders).slice(0, 3),
    byUser: [...users.entries()].map(([userId, value]) => ({ userId, orders: value.orders, total: round2(value.total) })).sort((a, b) => b.total - a.total),
    dayTotals, daysWithSales: dayTotals.size,
  };
}

export type Forecast = { basis: string; estimate: true; nextDays: { day: string; expected: number }[]; monthProjection: number; remainingDays: number; dailyAverage: number };

// Estimate from the average of each weekday in the previous 8 weeks (calendar days without sales count as zero). Requires at least 14 days with sales.
export function forecastRevenue(analysis: SalesAnalysis, now: Date, timeZone: string, windowDays = 56): Forecast | null {
  if (analysis.daysWithSales < 14) return null;
  const today = localParts(now, timeZone).day;
  const sums = Array(7).fill(0) as number[];
  const counts = Array(7).fill(0) as number[];
  for (let offset = 1; offset <= windowDays; offset += 1) {
    const day = addDays(today, -offset);
    const weekday = weekdayOf(day);
    sums[weekday] += analysis.dayTotals.get(day) ?? 0;
    counts[weekday] += 1;
  }
  const average = (weekday: number) => (counts[weekday] > 0 ? sums[weekday] / counts[weekday] : 0);
  const nextDays = Array.from({ length: 7 }, (_, index) => { const day = addDays(today, index + 1); return { day, expected: round2(average(weekdayOf(day))) }; });
  const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  let remaining = 0; let remainingDays = 0;
  for (let day = Number(today.slice(8, 10)) + 1; day <= lastDay; day += 1) { remaining += average(weekdayOf(`${today.slice(0, 8)}${String(day).padStart(2, '0')}`)); remainingDays += 1; }
  const total = sums.reduce((sum, value) => sum + value, 0);
  return { basis: `Média por dia da semana das últimas ${windowDays / 7} semanas`, estimate: true, nextDays, monthProjection: round2(analysis.monthToDate + remaining), remainingDays, dailyAverage: round2(total / windowDays) };
}

export function goalProgress(monthToDate: number, goal: number, now: Date, timeZone: string) {
  const today = localParts(now, timeZone).day;
  const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const remainingDays = lastDay - Number(today.slice(8, 10)) + 1;
  const missing = Math.max(0, goal - monthToDate);
  return { goal, monthToDate: round2(monthToDate), missing: round2(missing), remainingDays, perDay: remainingDays > 0 ? round2(missing / remainingDays) : round2(missing), reached: monthToDate >= goal };
}

// Compares the last 7 closed days with the 7 before; null when the earlier week has no sales to compare with.
export function weeklyTrend(analysis: SalesAnalysis, now: Date, timeZone: string): { last7: number; previous7: number; changePercent: number } | null {
  const today = localParts(now, timeZone).day;
  const sum = (from: number, to: number) => { let total = 0; for (let offset = from; offset <= to; offset += 1) total += analysis.dayTotals.get(addDays(today, -offset)) ?? 0; return total; };
  const last7 = sum(1, 7); const previous7 = sum(8, 14);
  return previous7 > 0 ? { last7: round2(last7), previous7: round2(previous7), changePercent: round2(((last7 - previous7) / previous7) * 100) } : null;
}

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export type Intent = 'SALES_TODAY' | 'SALES_YESTERDAY' | 'SALES_MONTH' | 'PROFIT' | 'BEST_DAY' | 'TOP_PRODUCTS' | 'BEST_MARGIN' | 'WORST_PRODUCTS' | 'EXPENSES' | 'WASTE' | 'TOP_EMPLOYEE' | 'AVG_TICKET' | 'GOAL' | 'RESTOCK' | 'PERFORMANCE' | 'FORECAST' | 'CHANNELS' | 'PEAK_HOURS' | 'UNKNOWN';

// Rule-based intent detection: deterministic, free and auditable. Order matters (more specific phrases first).
export function detectIntent(question: string): Intent {
  const text = normalize(question);
  const has = (...terms: string[]) => terms.some(term => text.includes(term));
  if (has('meta')) return 'GOAL';
  if (has('lucr', 'lucro')) return 'PROFIT';
  if (has('desperdic', 'perdi', 'perda')) return 'WASTE';
  if (has('despesa', 'gasto', 'custos aument')) return 'EXPENSES';
  if (has('funcionario', 'vendedor', 'garcom', 'atendente') && has('vend', 'mais')) return 'TOP_EMPLOYEE';
  if (has('margem')) return 'BEST_MARGIN';
  if (has('vendendo menos', 'menos vend', 'pior produto', 'encalhad')) return 'WORST_PRODUCTS';
  if (has('vende mais', 'mais vendido', 'mais vende', 'campeao', 'mais sai')) return 'TOP_PRODUCTS';
  if (has('melhor dia')) return 'BEST_DAY';
  if (has('ticket')) return 'AVG_TICKET';
  if (has('comprar', 'reposic', 'repor', 'estoque')) return 'RESTOCK';
  if (has('previs', 'projec', 'vou vender', 'estimativa')) return 'FORECAST';
  if (has('canal', 'canais', 'delivery ou', 'origem das vendas')) return 'CHANNELS';
  if (has('horario', 'movimento', 'pico')) return 'PEAK_HOURS';
  if (has('desempenho', 'evolucao', 'mes anterior', 'comparad', 'comparacao', 'unidade')) return 'PERFORMANCE';
  if (has('ontem')) return 'SALES_YESTERDAY';
  if (has('mes', 'mensal')) return 'SALES_MONTH';
  if (has('hoje', 'vendi', 'faturei', 'faturamento', 'vendas')) return 'SALES_TODAY';
  return 'UNKNOWN';
}

// Extracts a money amount such as "50000", "50.000" or "R$ 50.000,50" from a question.
export function extractAmount(question: string): number | null {
  const match = question.match(/(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export const brl = (value: number) => `R$ ${value.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

export type RangedForecast = {
  method: string; windowWeeks: number; sampleDays: number; estimate: true;
  nextDays: Array<{ day: string; expected: number; low: number; high: number }>;
  week: { expected: number; low: number; high: number };
  month: { projection: number; low: number; high: number; remainingDays: number } | null;
  uncertainty: string;
};

// Forecast by weekday average with its spread: each weekday keeps the mean and the standard deviation of the last `windowWeeks` weeks.
// The range is mean ± 1 standard deviation per day (days combined as independent, so the spread of a sum is the square root of the summed variances).
// It is a statistical estimate, not a commitment; with fewer than `minDays` days of sales there is no forecast at all.
export function forecastWithRange(dayTotals: Map<string, number>, today: string, monthToDate: number, windowWeeks = 8, minDays = 14): RangedForecast | null {
  const window = windowWeeks * 7;
  const byWeekday: number[][] = Array.from({ length: 7 }, () => []);
  let sampleDays = 0;
  for (let offset = 1; offset <= window; offset += 1) {
    const day = addDays(today, -offset); const value = dayTotals.get(day) ?? 0;
    byWeekday[weekdayOf(day)].push(value); if (value > 0) sampleDays += 1;
  }
  if (sampleDays < minDays) return null;
  const stats = byWeekday.map(values => { const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length); return { mean, sd: Math.sqrt(variance) }; });
  const range = (days: string[]) => { const mean = days.reduce((sum, day) => sum + stats[weekdayOf(day)].mean, 0); const sd = Math.sqrt(days.reduce((sum, day) => sum + stats[weekdayOf(day)].sd ** 2, 0)); return { expected: round2(mean), low: round2(Math.max(0, mean - sd)), high: round2(mean + sd) }; };
  const nextDays = Array.from({ length: 7 }, (_, index) => { const day = addDays(today, index + 1); return { day, ...range([day]) }; });
  const lastDay = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate();
  const rest = Array.from({ length: lastDay - Number(today.slice(8, 10)) }, (_, index) => `${today.slice(0, 8)}${String(Number(today.slice(8, 10)) + index + 1).padStart(2, '0')}`);
  const tail = range(rest);
  return {
    method: `Média por dia da semana das últimas ${windowWeeks} semanas, com faixa de ±1 desvio-padrão`, windowWeeks, sampleDays, estimate: true, nextDays, week: range(nextDays.map(item => item.day)),
    month: { projection: round2(monthToDate + tail.expected), low: round2(monthToDate + tail.low), high: round2(monthToDate + tail.high), remainingDays: rest.length },
    uncertainty: 'Estimativa estatística, não garantia: feriados, eventos, clima e promoções não entram no cálculo. A faixa cobre cerca de dois terços dos resultados quando as vendas variam de forma regular.',
  };
}
