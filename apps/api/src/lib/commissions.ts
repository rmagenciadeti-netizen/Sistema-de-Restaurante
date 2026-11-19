export type CommissionRuleInput = {
  id: string; name: string; kind: 'SALE_PERCENT' | 'PRODUCT_PERCENT' | 'GOAL_BONUS';
  userId: string | null; role: string | null; productId: string | null;
  percent: number | null; goalAmount: number | null; bonusAmount: number | null; active: boolean;
};
export type CommissionUser = { id: string; name: string; role: string; commissionPercent: number };
export type CommissionItem = { userId: string; productId: string; total: number };
export type CommissionLine = { userId: string; name: string; role: string; sales: number; saleCommission: number; productCommission: number; goalBonus: number; total: number; goalsReached: string[] };

const round2 = (value: number) => Math.round(value * 100) / 100;
const applies = (rule: CommissionRuleInput, user: CommissionUser) => rule.active && (rule.userId ? rule.userId === user.id : true) && (rule.role ? rule.role === user.role : true);
// Most specific wins: a rule for the person beats a rule for the role, which beats a company-wide rule.
const specificity = (rule: CommissionRuleInput) => (rule.userId ? 2 : rule.role ? 1 : 0);

// Pure calculation over eligible sales only (the caller passes completed, non-cancelled items). Precedence per item: product rule > sale rule > the
// user's flat percentage. Goal bonuses are fixed amounts paid once when the person's eligible sales reach the goal.
export function calculateCommissions(users: CommissionUser[], rules: CommissionRuleInput[], items: CommissionItem[]): CommissionLine[] {
  const byUser = new Map<string, CommissionItem[]>();
  for (const item of items) byUser.set(item.userId, [...(byUser.get(item.userId) ?? []), item]);
  return users.map(user => {
    const own = byUser.get(user.id) ?? [];
    const mine = rules.filter(rule => applies(rule, user));
    const saleRule = mine.filter(rule => rule.kind === 'SALE_PERCENT').sort((a, b) => specificity(b) - specificity(a))[0];
    const salePercent = saleRule?.percent ?? user.commissionPercent;
    let saleCommission = 0; let productCommission = 0; let sales = 0;
    for (const item of own) {
      sales += item.total;
      const productRule = mine.filter(rule => rule.kind === 'PRODUCT_PERCENT' && rule.productId === item.productId).sort((a, b) => specificity(b) - specificity(a))[0];
      if (productRule) productCommission += item.total * (productRule.percent ?? 0) / 100;
      else saleCommission += item.total * salePercent / 100;
    }
    const reached = mine.filter(rule => rule.kind === 'GOAL_BONUS' && rule.goalAmount !== null && sales >= rule.goalAmount);
    const goalBonus = reached.reduce((sum, rule) => sum + (rule.bonusAmount ?? 0), 0);
    return {
      userId: user.id, name: user.name, role: user.role, sales: round2(sales), saleCommission: round2(saleCommission), productCommission: round2(productCommission), goalBonus: round2(goalBonus),
      total: round2(saleCommission + productCommission + goalBonus), goalsReached: reached.map(rule => rule.name),
    };
  });
}
