import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, analyzeSales, brl, detectIntent, extractAmount, forecastRevenue, goalProgress, weeklyTrend, type Sale } from './intelligence';

const tz = 'America/Sao_Paulo';
const now = new Date('2026-11-18T15:00:00Z');
const sale = (day: string, total: number, channel = 'POS', userId: string | null = 'u1', hour = 15): Sale => ({ at: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`), total, channel, userId });
// 30 days of history: R$100 every day (including today), plus two extra sales yesterday.
const history: Sale[] = Array.from({ length: 31 }, (_, index) => sale(addDays('2026-11-18', -index), 100));
history.push(sale('2026-11-17', 50, 'DELIVERY', 'u2', 22), sale('2026-11-17', 50, 'DELIVERY', 'u2', 22));

test('sales analysis reports real totals, channels, peak hours and best day', () => {
  const analysis = analyzeSales(history, now, tz);
  assert.equal(analysis.today, 100);
  assert.equal(analysis.yesterday, 200);
  assert.equal(analysis.monthToDate, 1900);
  assert.equal(analysis.ordersMonth, 20);
  assert.equal(analysis.avgTicketMonth, 95);
  assert.deepEqual(analysis.bestDay, { day: '2026-11-17', total: 200 });
  assert.equal(analysis.byChannel[0].channel, 'POS');
  assert.equal(analysis.byUser[0].userId, 'u1');
  assert.equal(analysis.peakHours[0].hour, 12);
  assert.equal(analysis.monthChangePercent, null, 'no previous-month sales in the window to compare with');
});

test('forecast is only produced with enough history and is flagged as an estimate', () => {
  assert.equal(forecastRevenue(analyzeSales(history.slice(0, 5), now, tz), now, tz), null);
  const forecast = forecastRevenue(analyzeSales(history, now, tz), now, tz)!;
  assert.equal(forecast.estimate, true);
  assert.equal(forecast.nextDays.length, 7);
  assert.equal(forecast.remainingDays, 12);
  assert.ok(forecast.monthProjection > 1900);
});

test('goal progress and weekly trend', () => {
  const goal = goalProgress(1900, 5000, now, tz);
  assert.equal(goal.missing, 3100);
  assert.equal(goal.remainingDays, 13);
  assert.equal(goal.perDay, 238.46);
  assert.equal(goalProgress(6000, 5000, now, tz).reached, true);
  const trend = weeklyTrend(analyzeSales(history, now, tz), now, tz)!;
  assert.equal(trend.previous7, 700);
  assert.equal(trend.last7, 800);
});

test('questions are mapped to intents and amounts are parsed', () => {
  assert.equal(detectIntent('Quanto vendi hoje?'), 'SALES_TODAY');
  assert.equal(detectIntent('Qual produto vende mais?'), 'TOP_PRODUCTS');
  assert.equal(detectIntent('Qual produto oferece maior margem?'), 'BEST_MARGIN');
  assert.equal(detectIntent('Quanto lucrei neste mês?'), 'PROFIT');
  assert.equal(detectIntent('Quanto preciso vender para alcançar minha meta?'), 'GOAL');
  assert.equal(detectIntent('Quais produtos preciso comprar?'), 'RESTOCK');
  assert.equal(detectIntent('Qual funcionário realizou mais vendas?'), 'TOP_EMPLOYEE');
  assert.equal(detectIntent('Qual foi o ticket médio?'), 'AVG_TICKET');
  assert.equal(detectIntent('blablabla'), 'UNKNOWN');
  assert.equal(extractAmount('minha meta é R$ 50.000,50'), 50000.5);
  assert.equal(extractAmount('sem número'), null);
  assert.equal(brl(1234.5), 'R$ 1.234,50');
});
