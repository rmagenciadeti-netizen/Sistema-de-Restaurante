// Pure rules for purchase planning, expiry, price comparison and receiving conference. Deterministic and unit-tested:
// every suggestion can be explained from the registered stock, consumption and purchase history.
const DAY = 86_400_000;

export type PlanningInput = { current: number; minimum: number | null; maximum: number | null; consumed30: number };
export type PurchaseSuggestion = { quantity: number; reason: 'BELOW_MINIMUM' | 'LOW_COVERAGE' | 'NONE'; coverageDays: number | null; target: number };

const round3 = (value: number) => Math.round(value * 1000) / 1000;

// Target stock is the configured maximum; without one, twice the minimum or two weeks of real consumption, whichever is larger.
export function suggestPurchase({ current, minimum, maximum, consumed30 }: PlanningInput): PurchaseSuggestion {
  const daily = Math.max(0, consumed30) / 30;
  const coverageDays = daily > 0 ? round3(current / daily) : null;
  const target = maximum ?? Math.max(minimum !== null ? minimum * 2 : 0, daily * 14);
  const below = minimum !== null && current <= minimum;
  const lowCoverage = coverageDays !== null && coverageDays <= 7;
  if (!(below || lowCoverage) || target <= current) return { quantity: 0, reason: 'NONE', coverageDays, target: round3(target) };
  return { quantity: round3(target - current), reason: below ? 'BELOW_MINIMUM' : 'LOW_COVERAGE', coverageDays, target: round3(target) };
}

export type ExpiryState = 'EXPIRED' | 'EXPIRING' | 'OK' | 'NONE';
// Expiry dates are calendar dates (UTC midnight), so they are compared by day: a product that expires today is still usable today.
export function expiryState(expiresAt: Date | null, now: Date, warnDays = 7): ExpiryState {
  if (!expiresAt) return 'NONE';
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = Date.UTC(expiresAt.getUTCFullYear(), expiresAt.getUTCMonth(), expiresAt.getUTCDate());
  return day < today ? 'EXPIRED' : day - today <= warnDays * DAY ? 'EXPIRING' : 'OK';
}
// Keeps the earliest expiry among what is on the shelf: a new batch never postpones an older one that is still in stock.
export const earliestExpiry = (existing: Date | null, incoming: Date | null, hasStock: boolean) => (!incoming ? existing : !existing || !hasStock || incoming < existing ? incoming : existing);

export type PricePoint = { supplierId: string; supplierName: string; unitCost: number; at: Date };
export type SupplierPriceRow = { supplierId: string; supplierName: string; purchases: number; lastCost: number; lastAt: Date; averageCost: number; minCost: number; vsBest: number };
// Best price first. `vsBest` is how much more (in %) the supplier's last price is than the cheapest last price.
export function comparePrices(points: PricePoint[]): SupplierPriceRow[] {
  const bySupplier = new Map<string, PricePoint[]>();
  for (const point of points) bySupplier.set(point.supplierId, [...(bySupplier.get(point.supplierId) ?? []), point]);
  const rows = [...bySupplier.values()].map(list => {
    const sorted = [...list].sort((a, b) => b.at.getTime() - a.at.getTime());
    const costs = list.map(item => item.unitCost);
    return { supplierId: sorted[0].supplierId, supplierName: sorted[0].supplierName, purchases: list.length, lastCost: sorted[0].unitCost, lastAt: sorted[0].at, averageCost: Math.round((costs.reduce((sum, cost) => sum + cost, 0) / costs.length) * 10000) / 10000, minCost: Math.min(...costs), vsBest: 0 };
  }).sort((a, b) => a.lastCost - b.lastCost);
  const best = rows[0]?.lastCost ?? 0;
  return rows.map(row => ({ ...row, vsBest: best > 0 ? Math.round(((row.lastCost - best) / best) * 10000) / 100 : 0 }));
}

export type ConferenceLine = { itemId: string; name: string; orderedQuantity: number; receivedQuantity: number | null; orderedUnitCost: number; receivedUnitCost: number | null };
export type Divergence = { itemId: string; name: string; kind: 'SHORT' | 'OVER' | 'PRICE_UP' | 'PRICE_DOWN' | 'NOT_RECEIVED'; detail: string };
const brl = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;
// Compares what was ordered with what arrived; a divergence is any quantity difference or a price difference of a cent or more.
export function conferencePurchase(lines: ConferenceLine[]): { divergences: Divergence[]; orderedTotal: number; receivedTotal: number } {
  const divergences: Divergence[] = [];
  let orderedTotal = 0; let receivedTotal = 0;
  for (const line of lines) {
    const received = line.receivedQuantity ?? line.orderedQuantity; const cost = line.receivedUnitCost ?? line.orderedUnitCost;
    orderedTotal += line.orderedQuantity * line.orderedUnitCost; receivedTotal += received * cost;
    if (received === 0) divergences.push({ itemId: line.itemId, name: line.name, kind: 'NOT_RECEIVED', detail: `Não recebido (pedido ${line.orderedQuantity})` });
    else if (received < line.orderedQuantity) divergences.push({ itemId: line.itemId, name: line.name, kind: 'SHORT', detail: `Recebido ${received} de ${line.orderedQuantity}` });
    else if (received > line.orderedQuantity) divergences.push({ itemId: line.itemId, name: line.name, kind: 'OVER', detail: `Recebido ${received}, pedido ${line.orderedQuantity}` });
    if (Math.abs(cost - line.orderedUnitCost) >= 0.01) divergences.push({ itemId: line.itemId, name: line.name, kind: cost > line.orderedUnitCost ? 'PRICE_UP' : 'PRICE_DOWN', detail: `Preço ${brl(cost)} contra ${brl(line.orderedUnitCost)} no pedido` });
  }
  return { divergences, orderedTotal: Math.round(orderedTotal * 100) / 100, receivedTotal: Math.round(receivedTotal * 100) / 100 };
}

const normalize = (text: string) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = (text: string) => new Set(normalize(text).split(' ').filter(token => token.length >= 3));
// Suggests which supplier-invoice line (parsed from the XML) matches an ingredient by shared words; the operator always confirms.
export function matchInvoiceItem<T extends { description: string }>(ingredientName: string, items: T[]): { item: T; score: number } | null {
  const wanted = tokens(ingredientName);
  if (wanted.size === 0) return null;
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const candidate = tokens(item.description);
    const shared = [...wanted].filter(token => candidate.has(token)).length;
    const score = shared / wanted.size;
    if (score > 0.5 && (!best || score > best.score)) best = { item, score: Math.round(score * 100) / 100 };
  }
  return best;
}
