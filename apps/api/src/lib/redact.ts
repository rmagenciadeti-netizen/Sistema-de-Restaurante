import type { NextFunction, Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { FINANCE_ROLES } from './permissions';

// Cost fields are financial information (they reveal margins). Operational screens (products, stock, orders, kitchen...) are readable by profiles without
// financial permission, so every JSON answer of those routers is stripped of them in the API itself, whatever the screen shows.
const COST_KEYS = new Set(['cost', 'unitCost', 'averageCost', 'freightCost', 'otherAcquisitionCost', 'costPrice', 'purchaseCost']);
export function stripCosts<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripCosts) as unknown as T;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const candidate = value as unknown as { toJSON?: () => unknown };
    const plain = candidate.toJSON ? candidate.toJSON() : value;
    if (plain === null || typeof plain !== 'object') return plain as T;
    return Object.fromEntries(Object.entries(plain as Record<string, unknown>).filter(([key]) => !COST_KEYS.has(key)).map(([key, inner]) => [key, stripCosts(inner)])) as T;
  }
  return value;
}
export const canSeeCosts = (role: UserRole | undefined) => role === UserRole.MASTER_ADMIN || (role !== undefined && FINANCE_ROLES.includes(role));
export function redactCosts(req: Request, res: Response, next: NextFunction) {
  const original = res.json.bind(res);
  res.json = ((body: unknown) => original(req.auth && !canSeeCosts(req.auth.role) ? stripCosts(body) : body)) as typeof res.json;
  next();
}
