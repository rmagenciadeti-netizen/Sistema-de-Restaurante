import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole, UserStatus, TenantStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

export type AuthContext = { userId: string; tenantId: string | null; unitId: string | null; role: UserRole };
declare global { namespace Express { interface Request { auth?: AuthContext } } }
const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return value;
};

export function signAccessToken(payload: AuthContext): string {
  return jwt.sign(payload, secret(), { expiresIn: '8h', issuer: 'rm-restaurant-api' });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return res.status(401).json({ message: 'Authentication required' });
    const claims = jwt.verify(token, secret(), { issuer: 'rm-restaurant-api' }) as AuthContext;
    const user = await prisma.user.findUnique({ where: { id: claims.userId }, select: { id: true, tenantId: true, unitId: true, role: true, status: true, tenant: { select: { status: true } } } });
    if (!user || user.status !== UserStatus.ACTIVE) return res.status(401).json({ message: 'Invalid or inactive account' });
    if (user.role !== UserRole.MASTER_ADMIN && (!user.tenantId || user.tenant?.status !== TenantStatus.ACTIVE)) {
      return res.status(403).json({ message: 'Tenant is not active' });
    }
    req.auth = { userId: user.id, tenantId: user.tenantId, unitId: user.unitId, role: user.role };
    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

export function requireMaster(req: Request, res: Response, next: NextFunction) {
  if (req.auth?.role !== UserRole.MASTER_ADMIN) return res.status(403).json({ message: 'Master administrator access required' });
  return next();
}

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.tenantId) return res.status(403).json({ message: 'Tenant context required' });
  return next();
}
