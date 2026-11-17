import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { isStrongPassword } from '../lib/password-policy';
import { effectiveModules, globallyBlockedModules, licenseDenial } from '../lib/licensing';
import { decryptTotpSecret, encryptTotpSecret, hashRecoveryCode, matchingTotpStep, newRecoveryCodes, newTotpSecret, recoveryCodeIndex } from '../lib/master-mfa';
import { emailProviders } from '../lib/providers';
import { signAccessToken, signScopedToken, verifyScopedToken, requireAuth, devMfaDisabled } from '../middleware/auth';

export const authRoutes = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many login attempts. Try again later.' } });
const mfaLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many MFA attempts. Try again later.' } });
const passwordRecoveryLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many password recovery attempts. Try again later.' } });
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { message: 'Too many password reset attempts. Try again later.' } });
const loginSchema = z.object({
  identifier: z.string().trim().min(1).max(254).optional(),
  email: z.string().trim().min(1).max(254).optional(),
  password: z.string().min(1).max(200),
}).refine(input => Boolean(input.identifier || input.email));
const login = (masterOnly = false) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = loginSchema.safeParse(req.body); if (!input.success) return res.status(400).json({ message: 'Invalid credentials format' });
    const identifier = (input.data.identifier ?? input.data.email!).trim().toLowerCase();
    const where = identifier.includes('@') ? { email: identifier } : { username: identifier };
    const user = await prisma.user.findUnique({ where, include: { tenant: { include: { license: true } } } });
    if (!user || !user.passwordHash || user.status !== 'ACTIVE' || !(await bcrypt.compare(input.data.password, user.passwordHash))) return res.status(401).json({ message: 'Email or password is incorrect' });
    if (masterOnly && user.role !== 'MASTER_ADMIN') return res.status(401).json({ message: 'Email or password is incorrect' });
    if (user.role !== 'MASTER_ADMIN' && (!user.tenantId || !user.tenant || !['ACTIVE', 'TRIAL'].includes(user.tenant.status))) return res.status(401).json({ message: 'Email or password is incorrect' });
    if (user.role !== 'MASTER_ADMIN') { const denial = licenseDenial(user.tenant!.license, [], '/api/v1/auth/login'); if (denial) return res.status(403).json({ message: denial }); }
    const publicUser = { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenantId, unitId: user.unitId, mustChangePassword: user.mustChangePassword };
    if (user.role === UserRole.MASTER_ADMIN && devMfaDisabled()) {
      const accessToken = signAccessToken({ userId: user.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN, authVersion: user.authVersion, mfaAuthenticated: true });
      return res.json({ accessToken, tokenType: 'Bearer', expiresIn: 28800, mustChangePassword: user.mustChangePassword, user: publicUser });
    }
    if (user.role === UserRole.MASTER_ADMIN) {
      return res.json({
        mfaRequired: user.mfaEnabled,
        mfaSetupRequired: !user.mfaEnabled,
        ...(user.mfaEnabled ? { mfaChallenge: signScopedToken(user.id, 'master_mfa_login', user.authVersion) } : { mfaSetupToken: signScopedToken(user.id, 'master_mfa_setup', user.authVersion) }),
        mustChangePassword: user.mustChangePassword,
        user: publicUser,
      });
    }
    const accessToken = signAccessToken({ userId: user.id, tenantId: user.tenantId, unitId: user.unitId, role: user.role, authVersion: user.authVersion });
    return res.json({ accessToken, tokenType: 'Bearer', expiresIn: 28800, mustChangePassword: user.mustChangePassword, user: publicUser });
  } catch (error) { return next(error); }
};
authRoutes.post('/login', loginLimiter, login());
authRoutes.post('/master-login', loginLimiter, login(true));
const mfaCodeSchema = z.object({ code: z.string().trim().min(1).max(32) });
function scopedBearer(req: Request, purpose: 'master_mfa_setup' | 'master_mfa_login') {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return token ? verifyScopedToken(token, purpose) : null;
}
const passwordRecoveryMessage = 'Se a conta estiver ativa, enviaremos instruções para o e-mail informado.';
const recoveryRequestSchema = z.object({ email: z.string().trim().email().max(254) });
const recoveryCompletionSchema = z.object({
  token: z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/),
  newPassword: z.string().min(12).max(72).refine(isStrongPassword),
});
const hashResetToken = (token: string) => createHash('sha256').update(token).digest('hex');
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function passwordResetUrl(role: UserRole, token: string) {
  const configured = role === UserRole.MASTER_ADMIN ? process.env.RM_ADMIN_URL : process.env.RM_RESTAURANT_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') return null;
    url.pathname = '/reset-password';
    url.search = '';
    url.hash = '';
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return null;
  }
}
authRoutes.post('/forgot-password', passwordRecoveryLimiter, async (req, res, next) => {
  try {
    const input = recoveryRequestSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Informe um e-mail válido' });
    const emailProvider = emailProviders.get('smtp');
    if (!emailProvider) return res.status(503).json({ message: 'Recuperação por e-mail indisponível: configure um provedor SMTP' });
    const user = await prisma.user.findUnique({
      where: { email: input.data.email.toLowerCase() },
      select: { id: true, name: true, email: true, role: true, status: true, tenant: { select: { status: true } }, passwordResetRequestedAt: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE || (user.tenant && !['ACTIVE', 'TRIAL'].includes(user.tenant.status))) return res.status(202).json({ message: passwordRecoveryMessage });
    const resetUrlBase = passwordResetUrl(user.role, 'token');
    if (!resetUrlBase) return res.status(503).json({ message: 'URL pública do aplicativo não está configurada para recuperação de senha' });
    if (user.passwordResetRequestedAt && Date.now() - user.passwordResetRequestedAt.getTime() < 60_000) return res.status(202).json({ message: passwordRecoveryMessage });

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashResetToken(token);
    const now = new Date();
    const claimed = await prisma.user.updateMany({
      where: { id: user.id, status: UserStatus.ACTIVE, OR: [{ passwordResetRequestedAt: null }, { passwordResetRequestedAt: { lte: new Date(now.getTime() - 60_000) } }] },
      data: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: new Date(now.getTime() + 30 * 60_000), passwordResetRequestedAt: now },
    });
    if (claimed.count !== 1) return res.status(202).json({ message: passwordRecoveryMessage });
    const resetUrl = passwordResetUrl(user.role, token)!;
    const safeUrl = escapeHtml(resetUrl);
    try {
      await emailProvider.send({
        to: user.email,
        subject: 'Redefinição de senha - RM Restaurant',
        text: `Use este link para redefinir sua senha. Ele expira em 30 minutos e só pode ser usado uma vez:\n${resetUrl}`,
        html: `<p>Use este link para redefinir sua senha. Ele expira em 30 minutos e só pode ser usado uma vez:</p><p><a href="${safeUrl}">Redefinir senha</a></p>`,
      });
    } catch {
      await prisma.user.updateMany({ where: { id: user.id, passwordResetTokenHash: tokenHash }, data: { passwordResetTokenHash: null, passwordResetExpiresAt: null, passwordResetRequestedAt: null } });
      return res.status(503).json({ message: 'Não foi possível enviar o e-mail de recuperação. Tente novamente mais tarde.' });
    }
    return res.status(202).json({ message: passwordRecoveryMessage });
  } catch (error) { return next(error); }
});
authRoutes.post('/reset-password', passwordResetLimiter, async (req, res, next) => {
  try {
    const input = recoveryCompletionSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Use uma senha com 12 a 72 bytes e pelo menos três tipos de caracteres' });
    const tokenHash = hashResetToken(input.data.token);
    const now = new Date();
    const user = await prisma.user.findFirst({ where: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { gt: now }, status: UserStatus.ACTIVE }, select: { id: true, tenantId: true } });
    if (!user) return res.status(400).json({ message: 'Link de redefinição inválido ou expirado' });
    const passwordHash = await bcrypt.hash(input.data.newPassword, 12);
    const updated = await prisma.$transaction(async tx => {
      const result = await tx.user.updateMany({
        where: { id: user.id, status: UserStatus.ACTIVE, passwordResetTokenHash: tokenHash, passwordResetExpiresAt: { gt: now } },
        data: { passwordHash, mustChangePassword: false, authVersion: { increment: 1 }, passwordResetTokenHash: null, passwordResetExpiresAt: null, passwordResetRequestedAt: null },
      });
      if (result.count !== 1) return false;
      await tx.auditLog.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'PASSWORD_RESET', entityType: 'User', entityId: user.id } });
      return true;
    });
    if (!updated) return res.status(400).json({ message: 'Link de redefinição inválido ou expirado' });
    return res.status(204).end();
  } catch (error) { return next(error); }
});
authRoutes.post('/master/mfa/setup', mfaLimiter, async (req, res, next) => {
  try {
    const scope = scopedBearer(req, 'master_mfa_setup');
    if (!scope) return res.status(401).json({ message: 'Valid Master MFA setup token required' });
    const user = await prisma.user.findUnique({ where: { id: scope.userId }, select: { id: true, email: true, role: true, status: true, authVersion: true, mfaEnabled: true } });
    if (!user || user.role !== UserRole.MASTER_ADMIN || user.status !== UserStatus.ACTIVE) return res.status(401).json({ message: 'Invalid Master account' });
    if (user.authVersion !== scope.authVersion) return res.status(401).json({ message: 'Master MFA setup session expired' });
    if (user.mfaEnabled) return res.status(409).json({ message: 'Master MFA is already enabled' });
    const secret = newTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: encrypted } });
      await tx.auditLog.create({ data: { actorUserId: user.id, action: 'MASTER_MFA_SETUP_STARTED', entityType: 'User', entityId: user.id } });
    });
    const label = encodeURIComponent(`RM Painel Admin:${user.email}`);
    const issuer = encodeURIComponent('RM Painel Admin');
    return res.json({ secret, otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30` });
  } catch (error) { return next(error); }
});
authRoutes.post('/master/mfa/confirm', mfaLimiter, async (req, res, next) => {
  try {
    const scope = scopedBearer(req, 'master_mfa_setup');
    if (!scope) return res.status(401).json({ message: 'Valid Master MFA setup token required' });
    const input = mfaCodeSchema.safeParse(req.body);
    if (!input.success || !/^\d{6}$/.test(input.data.code)) return res.status(400).json({ message: 'Enter the current 6-digit authenticator code' });
    const user = await prisma.user.findUnique({ where: { id: scope.userId }, select: { id: true, tenantId: true, role: true, status: true, authVersion: true, mustChangePassword: true, mfaEnabled: true, mfaSecretEncrypted: true } });
    if (!user || user.role !== UserRole.MASTER_ADMIN || user.status !== UserStatus.ACTIVE) return res.status(401).json({ message: 'Invalid Master account' });
    if (user.authVersion !== scope.authVersion) return res.status(401).json({ message: 'Master MFA setup session expired' });
    if (user.mfaEnabled) return res.status(409).json({ message: 'Master MFA is already enabled' });
    if (!user.mfaSecretEncrypted) return res.status(409).json({ message: 'Start MFA setup before confirming it' });
    const secret = decryptTotpSecret(user.mfaSecretEncrypted);
    const step = matchingTotpStep(secret, input.data.code);
    if (step === null) return res.status(400).json({ message: 'Authenticator code is invalid or expired' });
    const recoveryCodes = newRecoveryCodes();
    const enabled = await prisma.$transaction(async tx => {
      const updated = await tx.user.updateMany({
        where: { id: user.id, role: UserRole.MASTER_ADMIN, status: UserStatus.ACTIVE, mfaEnabled: false, mfaSecretEncrypted: user.mfaSecretEncrypted },
        data: { mfaEnabled: true, mfaLastUsedStep: step, mfaRecoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) },
      });
      if (updated.count !== 1) return false;
      await tx.auditLog.create({ data: { actorUserId: user.id, action: 'MASTER_MFA_ENABLED', entityType: 'User', entityId: user.id } });
      return true;
    });
    if (!enabled) return res.status(409).json({ message: 'MFA setup changed or was already completed; start again' });
    const accessToken = signAccessToken({ userId: user.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN, authVersion: user.authVersion, mfaAuthenticated: true });
    return res.json({ accessToken, tokenType: 'Bearer', expiresIn: 28800, mustChangePassword: user.mustChangePassword, user: { id: user.id, role: user.role }, recoveryCodes });
  } catch (error) { return next(error); }
});
authRoutes.post('/master/mfa/verify', mfaLimiter, async (req, res, next) => {
  try {
    const scope = scopedBearer(req, 'master_mfa_login');
    if (!scope) return res.status(401).json({ message: 'Valid Master MFA challenge required' });
    const input = mfaCodeSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Enter an authenticator or recovery code' });
    const user = await prisma.user.findUnique({ where: { id: scope.userId }, select: { id: true, tenantId: true, unitId: true, name: true, email: true, role: true, status: true, authVersion: true, mustChangePassword: true, mfaEnabled: true, mfaSecretEncrypted: true, mfaRecoveryCodeHashes: true, mfaLastUsedStep: true } });
    if (!user || user.role !== UserRole.MASTER_ADMIN || user.status !== UserStatus.ACTIVE || !user.mfaEnabled || !user.mfaSecretEncrypted) return res.status(401).json({ message: 'Invalid Master MFA challenge' });
    if (user.authVersion !== scope.authVersion) return res.status(401).json({ message: 'Master MFA challenge expired' });

    const secret = decryptTotpSecret(user.mfaSecretEncrypted);
    const step = matchingTotpStep(secret, input.data.code);
    let authorized = false;
    if (step !== null && (user.mfaLastUsedStep === null || step > user.mfaLastUsedStep)) {
      const updated = await prisma.user.updateMany({
        where: { id: user.id, role: UserRole.MASTER_ADMIN, status: UserStatus.ACTIVE, mfaEnabled: true, ...(user.mfaLastUsedStep === null ? { mfaLastUsedStep: null } : { mfaLastUsedStep: { lt: step } }) },
        data: { mfaLastUsedStep: step },
      });
      authorized = updated.count === 1;
    } else {
      const index = recoveryCodeIndex(input.data.code, user.mfaRecoveryCodeHashes);
      if (index >= 0) {
        const recoveryHash = user.mfaRecoveryCodeHashes[index];
        const consumed = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          UPDATE "User"
          SET "mfaRecoveryCodeHashes" = array_remove("mfaRecoveryCodeHashes", ${recoveryHash}), "updatedAt" = NOW()
          WHERE "id" = ${user.id} AND "role" = ${UserRole.MASTER_ADMIN}::"UserRole"
            AND "status" = ${UserStatus.ACTIVE}::"UserStatus" AND "mfaEnabled" = true
            AND ${recoveryHash} = ANY("mfaRecoveryCodeHashes")
          RETURNING "id"
        `);
        authorized = consumed.length === 1;
      }
    }
    if (!authorized) return res.status(401).json({ message: 'Authenticator or recovery code is invalid or already used' });
    await prisma.auditLog.create({ data: { actorUserId: user.id, action: 'MASTER_MFA_LOGIN', entityType: 'User', entityId: user.id } });
    const accessToken = signAccessToken({ userId: user.id, tenantId: null, unitId: null, role: UserRole.MASTER_ADMIN, authVersion: user.authVersion, mfaAuthenticated: true });
    return res.json({ accessToken, tokenType: 'Bearer', expiresIn: 28800, mustChangePassword: user.mustChangePassword, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: null, unitId: null, mustChangePassword: user.mustChangePassword } });
  } catch (error) { return next(error); }
});
authRoutes.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const input = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(72).refine(isStrongPassword) }).safeParse(req.body);
    if (!input.success) return res.status(400).json({ message: 'Use uma senha com 12 a 72 bytes e pelo menos três tipos de caracteres' });
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, tenantId: true, passwordHash: true } });
    if (!user || !(await bcrypt.compare(input.data.currentPassword, user.passwordHash))) return res.status(400).json({ message: 'Senha atual inválida' });
    if (await bcrypt.compare(input.data.newPassword, user.passwordHash)) return res.status(400).json({ message: 'Escolha uma senha diferente da atual' });
    const passwordHash = await bcrypt.hash(input.data.newPassword, 12);
    await prisma.$transaction(async tx => {
      await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, authVersion: { increment: 1 } } });
      await tx.auditLog.create({ data: { tenantId: user.tenantId, actorUserId: user.id, action: 'PASSWORD_CHANGED', entityType: 'User', entityId: user.id } });
    });
    return res.status(204).end();
  } catch (error) { return next(error); }
});
authRoutes.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { id: true, name: true, email: true, role: true, tenantId: true, unitId: true, mustChangePassword: true, tenant: { select: { name: true, slug: true, license: { select: { status: true, validUntil: true } } } } } });
    // Frontend hint only (menus); the API enforces modules on every request. null = tenant without a license row, i.e. unrestricted.
    let enabledModules: string[] | null = null;
    if (user?.tenantId && user.tenant?.license) {
      const grants = await prisma.tenantModule.findMany({ where: { tenantId: user.tenantId }, select: { moduleKey: true, blocked: true, startsAt: true, endsAt: true } });
      const blocked = await globallyBlockedModules(async () => (await prisma.saaSModule.findMany({ where: { blocked: true }, select: { key: true } })).map(item => item.key));
      enabledModules = effectiveModules(grants, blocked);
    }
    return res.json({ user: user && { ...user, enabledModules } });
  }
  catch (error) { return next(error); }
});
