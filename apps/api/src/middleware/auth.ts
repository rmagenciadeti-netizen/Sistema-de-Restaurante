import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole, UserStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { licenseDenial } from '../lib/licensing';

export type AuthContext = { userId: string; tenantId: string | null; unitId: string | null; role: UserRole; authVersion?: number; mfaAuthenticated?: boolean };
export type ScopedTokenPurpose = 'master_mfa_setup' | 'master_mfa_login';
export type ScopedTokenClaims = { userId: string; authVersion: number };
declare global { namespace Express { interface Request { auth?: AuthContext } } }
const secret = () => { const value = process.env.JWT_SECRET; if (!value || value.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters'); return value; };
// Development-only escape hatch; never honored when NODE_ENV=production.
export const devMfaDisabled = () => process.env.DEV_DISABLE_MFA === 'true' && process.env.NODE_ENV !== 'production';
export function signAccessToken(payload: AuthContext): string { return jwt.sign(payload, secret(), { expiresIn: '8h', issuer: 'rm-restaurant-api' }); }
export function signScopedToken(userId: string, purpose: ScopedTokenPurpose, authVersion: number): string {
  return jwt.sign({ userId, purpose, authVersion }, secret(), { expiresIn: purpose === 'master_mfa_setup' ? '10m' : '5m', issuer: 'rm-restaurant-api' });
}
export function verifyScopedToken(token: string, purpose: ScopedTokenPurpose): ScopedTokenClaims | null {
  try {
    const claims = jwt.verify(token, secret(), { issuer: 'rm-restaurant-api' }) as { userId?: unknown; purpose?: unknown; authVersion?: unknown };
    return claims.purpose === purpose && typeof claims.userId === 'string' && typeof claims.authVersion === 'number' && Number.isInteger(claims.authVersion)
      ? { userId: claims.userId, authVersion: claims.authVersion }
      : null;
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return null;
    throw error;
  }
}
// Identifies the caller of a request for rate limiting without touching the database: a verified, non-scoped access token yields the user id.
// Unverifiable tokens return null, so forged tokens cannot be used to spread requests over many buckets.
export function sessionRateKey(req: Request): string | null {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) return null;
  try {
    const verified = jwt.verify(token, secret(), { issuer: 'rm-restaurant-api' }) as { userId?: unknown; purpose?: unknown };
    return !verified.purpose && typeof verified.userId === 'string' ? `user:${verified.userId}` : null;
  } catch { return null; }
}
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]; if (!token) return res.status(401).json({ message: 'Authentication required' });
  let claims: AuthContext;
  try {
    const verified = jwt.verify(token, secret(), { issuer: 'rm-restaurant-api' }) as AuthContext & { purpose?: string };
    if (verified.purpose) return res.status(401).json({ message: 'Scoped authentication token cannot access this route' });
    claims = verified;
    if (!claims || typeof claims.userId !== 'string') return res.status(401).json({ message: 'Invalid or expired token' });
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) return res.status(401).json({ message: 'Invalid or expired token' });
    return next(error);
  }
  try {
    const user = await prisma.user.findUnique({ where: { id: claims.userId }, select: { id: true, tenantId: true, unitId: true, role: true, status: true, authVersion: true, mustChangePassword: true, mfaEnabled: true, tenant: { select: { status: true, license: { select: { status: true, validUntil: true } }, modules: { select: { moduleKey: true } } } } } });
    if (!user || user.status !== UserStatus.ACTIVE) return res.status(401).json({ message: 'Invalid or inactive account' });
    if ((claims.authVersion ?? 0) !== user.authVersion) return res.status(401).json({ message: 'Session expired; sign in again' });
    if (user.role === UserRole.MASTER_ADMIN && !devMfaDisabled()) {
      if (!user.mfaEnabled) return res.status(403).json({ message: 'Master MFA enrollment required' });
      if (claims.mfaAuthenticated !== true) return res.status(403).json({ message: 'Master MFA verification required' });
    }
    if (user.role !== UserRole.MASTER_ADMIN && (!user.tenantId || !user.tenant || !['ACTIVE', 'TRIAL'].includes(user.tenant.status))) return res.status(403).json({ message: 'Tenant is not active' });
    if (user.role !== UserRole.MASTER_ADMIN && user.tenant) {
      const denial = licenseDenial(user.tenant.license, user.tenant.modules.map(item => item.moduleKey), req.originalUrl);
      if (denial) return res.status(403).json({ message: denial });
    }
    if (user.mustChangePassword && req.originalUrl.split('?')[0] !== '/api/v1/auth/change-password') return res.status(403).json({ message: 'Password change required' });
    req.auth = { userId: user.id, tenantId: user.tenantId, unitId: user.unitId, role: user.role }; return next();
  } catch (error) { return next(error); }
}
export function requireMaster(req: Request, res: Response, next: NextFunction) { if (req.auth?.role !== UserRole.MASTER_ADMIN) return res.status(403).json({ message: 'Master administrator access required' }); return next(); }
export function requireTenant(req: Request, res: Response, next: NextFunction) { if (!req.auth?.tenantId) return res.status(403).json({ message: 'Tenant context required' }); return next(); }
