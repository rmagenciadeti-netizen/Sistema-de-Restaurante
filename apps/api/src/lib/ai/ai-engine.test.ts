import test from 'node:test';
import assert from 'node:assert/strict';
import { cached, cacheKey, clearCache, cacheStats } from './cache';
import { DOMAINS } from './domains';
import { routeQuestion } from './orchestrator';

test('routing is deterministic and sends each question only to the specialists it needs', () => {
  const route = (question: string) => routeQuestion(question).domains;
  assert.deepEqual(route('Qual o faturamento por canal?'), ['sales']);
  assert.deepEqual(route('Quais insumos estão em ruptura no estoque?'), ['stock']);
  assert.deepEqual(route('Qual a margem e o CMV dos pratos?'), ['profit']);
  assert.deepEqual(route('Como está a entrega dos motoboys?'), ['delivery']);
  assert.deepEqual(route('Quantos pedidos atrasados na cozinha?'), ['production']);
  assert.deepEqual(route('Quanto desperdiçamos de perda este mês?'), ['waste']);
  assert.deepEqual(route('Quais contas a pagar vencem e como está o fluxo de caixa?'), ['finance']);
  assert.deepEqual(route('Faça um diagnóstico geral da operação'), ['management']);
  assert.deepEqual(route('bom dia'), [], 'no keyword: no specialist is consulted');
  assert.deepEqual([...route('Quero o estoque e o desperdício')].sort(), ['stock', 'waste']);
});

test('every specialist has its own identity, roles, tools, instructions and panel', () => {
  assert.equal(new Set(DOMAINS.map(domain => domain.key)).size, 10);
  for (const domain of DOMAINS) {
    assert.ok(domain.name.startsWith('RM ') && domain.roles.length > 0 && domain.tools.length > 0 && domain.instructions.includes('SOMENTE'));
    for (const tool of domain.panel) assert.ok(domain.tools.some(item => item.name === tool), `${domain.key}.${tool}`);
  }
  assert.equal(new Set(DOMAINS.map(domain => domain.instructions)).size, 10, 'instructions are specific to each agent');
  assert.equal(DOMAINS.find(domain => domain.key === 'profit')!.module, 'profit');
});

test('cache: TTL, per-key isolation and de-duplication of concurrent computations', async () => {
  clearCache(); const before = { ...cacheStats }; let runs = 0;
  const compute = async () => { runs++; await new Promise(resolve => setTimeout(resolve, 20)); return runs; };
  const key = cacheKey(['tenantA', 'u1', 'ADMIN', 'sales', 'v1']);
  const burst = await Promise.all([1, 2, 3, 4].map(() => cached(key, 60, compute)));
  assert.equal(runs, 1); assert.deepEqual(burst.map(item => item.source).sort(), ['computed', 'deduplicated', 'deduplicated', 'deduplicated']);
  assert.equal((await cached(key, 60, compute)).source, 'cache'); assert.equal(runs, 1);
  assert.equal((await cached(cacheKey(['tenantB', 'u1', 'ADMIN', 'sales', 'v1']), 60, compute)).source, 'computed', 'another tenant never shares the entry');
  assert.equal((await cached(cacheKey(['tenantA', 'u1', 'ADMIN', 'sales', 'v2']), 60, compute)).source, 'computed', 'a new data version is a new entry');
  assert.equal((await cached(key, 0, compute)).source, 'computed', 'TTL 0 disables reuse');
  assert.ok(cacheStats.hits > before.hits && cacheStats.deduped >= before.deduped + 3);
});

import { forecastWithRange } from '../intelligence';
import { specialistCsv } from './export';

test('forecast: needs 14 days with sales; keeps method, range and a flat series has no spread', () => {
  const totals = new Map<string, number>();
  assert.equal(forecastWithRange(totals, '2026-11-18', 0), null, 'no history, no forecast');
  for (let offset = 1; offset <= 56; offset++) totals.set(new Date(Date.UTC(2026, 10, 18 - offset)).toISOString().slice(0, 10), 1000);
  const flat = forecastWithRange(totals, '2026-11-18', 5000)!;
  assert.equal(flat.nextDays.length, 7); assert.ok(flat.nextDays.every(day => day.expected === 1000 && day.low === 1000 && day.high === 1000));
  assert.equal(flat.month!.remainingDays, 12); assert.equal(flat.month!.projection, 5000 + 12 * 1000);
  assert.match(flat.method, /8 semanas/); assert.match(flat.uncertainty, /não garantia/);
  // Irregular sales widen the range, never below zero.
  const noisy = new Map(totals); let flip = false; for (const day of noisy.keys()) { noisy.set(day, flip ? 200 : 1800); flip = !flip; }
  const wide = forecastWithRange(noisy, '2026-11-18', 0)!; assert.ok(wide.week.high > wide.week.expected && wide.week.low >= 0 && wide.week.low < wide.week.expected);
});

test('specialist CSV: numbers stay numeric (decimal comma), text that could run as a formula is neutralised', () => {
  const csv = specialistCsv('Vendas', [{ tool: 'sales.summary', title: 'Vendas', period: { from: '2026-11-01T00:00:00Z', to: '2026-11-18T00:00:00Z' }, unit: null, source: 'Pedidos', kind: 'FACT', highlights: [], alerts: [], limitations: ['Faturamento não é lucro.'], llmFacts: {},
    data: { revenue: -12.5, top: [{ name: '=HYPERLINK("x")', revenue: 10.25 }, { name: 'Prato; especial', revenue: 3 }], goal: { unavailable: true, reason: 'sem meta' } } }]);
  assert.ok(csv.startsWith('\uFEFF')); assert.match(csv, /revenue;-12,5/); assert.match(csv, /'=HYPERLINK/); assert.match(csv, /"Prato; especial";3/); assert.match(csv, /goal\.unavailable;sim/); assert.match(csv, /Limitação;Faturamento não é lucro\./);
});
