export type Segment = 'VIP' | 'RECURRING' | 'NEW' | 'AT_RISK' | 'INACTIVE';
export type CustomerStats = { id: string; orders: number; spent: number; firstOrderAt: Date | null; lastOrderAt: Date | null };

const DAY = 86_400_000;
export const SEGMENT_RULES: Record<Segment, string> = {
  VIP: '5 ou mais pedidos, compra nos últimos 60 dias e gasto total de pelo menos 2× a média dos clientes que compraram',
  RECURRING: '3 ou mais pedidos e última compra nos últimos 45 dias',
  NEW: 'Primeira compra nos últimos 30 dias e até 2 pedidos',
  AT_RISK: 'Já comprou 2 vezes ou mais, mas a última compra foi há 46 a 90 dias',
  INACTIVE: 'Sem compras há mais de 90 dias ou nunca comprou',
};

// Rule-based and deterministic so the owner can see exactly why a customer is in a segment. Order of checks matters.
export function classifyCustomer(stats: CustomerStats, averageSpent: number, now: Date): Segment {
  if (!stats.lastOrderAt || stats.orders === 0) return 'INACTIVE';
  const sinceLast = (now.getTime() - stats.lastOrderAt.getTime()) / DAY;
  if (sinceLast > 90) return 'INACTIVE';
  if (stats.orders >= 5 && sinceLast <= 60 && averageSpent > 0 && stats.spent >= averageSpent * 2) return 'VIP';
  if (stats.orders >= 3 && sinceLast <= 45) return 'RECURRING';
  if (stats.firstOrderAt && (now.getTime() - stats.firstOrderAt.getTime()) / DAY <= 30 && stats.orders <= 2) return 'NEW';
  if (stats.orders >= 2 && sinceLast > 45) return 'AT_RISK';
  return sinceLast <= 45 ? 'RECURRING' : 'AT_RISK';
}

export const averageSpent = (all: CustomerStats[]) => {
  const buyers = all.filter(item => item.orders > 0);
  return buyers.length ? buyers.reduce((sum, item) => sum + item.spent, 0) / buyers.length : 0;
};
