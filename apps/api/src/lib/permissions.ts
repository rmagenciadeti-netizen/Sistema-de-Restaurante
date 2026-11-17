import type { NextFunction, Request, Response } from 'express';
import { UserRole } from '@prisma/client';

export const MANAGEMENT_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.MANAGER];
export const FINANCE_ROLES: UserRole[] = [...MANAGEMENT_ROLES, UserRole.FINANCE];
export const SALES_ROLES: UserRole[] = [...MANAGEMENT_ROLES, UserRole.CASHIER, UserRole.WAITER];
export const ALL_TENANT_ROLES: UserRole[] = Object.values(UserRole).filter(role => role !== UserRole.MASTER_ADMIN);
export const CASH_ROLES: UserRole[] = [...FINANCE_ROLES, UserRole.CASHIER];
export const DELIVERY_ROLES: UserRole[] = [...MANAGEMENT_ROLES, UserRole.CASHIER, UserRole.DELIVERY];
export const PRODUCTION_ROLES: UserRole[] = [...MANAGEMENT_ROLES, UserRole.KITCHEN, UserRole.CASHIER, UserRole.WAITER];

// MASTER_ADMIN has no tenant context and is rejected by requireTenant, so it is never listed here.
export function requireRoles(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth || !roles.includes(req.auth.role)) return res.status(403).json({ message: 'Insufficient permissions' });
    return next();
  };
}

export function allowRead(readRoles: UserRole[], writeRoles: UserRole[]) {
  const read = requireRoles(...readRoles);
  const write = requireRoles(...writeRoles);
  return (req: Request, res: Response, next: NextFunction) => (req.method === 'GET' ? read(req, res, next) : write(req, res, next));
}
