import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma';

// Shared helpers for the simple auxiliary registries (couriers, carriers, payment methods, categories, cover events, tax rules).

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
});

export function activeFilter(active?: 'true' | 'false') {
  return active === undefined ? {} : { active: active === 'true' };
}

export function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function unitReadScope(req: Request) {
  return req.auth!.unitId ? { OR: [{ unitId: req.auth!.unitId }, { unitId: null }] } : {};
}

// Resolves the unit a unit-scoped record is written to. Returns an error message when the caller may not use it.
export async function resolveUnit(req: Request, requested: string | null | undefined): Promise<{ unitId: string | null } | { error: string; status: number }> {
  const tenantId = req.auth!.tenantId!;
  const unitId = requested === undefined ? req.auth!.unitId : requested;
  if (req.auth!.unitId && unitId !== req.auth!.unitId) return { error: 'Acesso à unidade negado.', status: 403 };
  if (unitId && !await prisma.unit.findFirst({ where: { id: unitId, tenantId }, select: { id: true } })) return { error: 'A unidade informada não pertence a esta empresa.', status: 400 };
  return { unitId: unitId ?? null };
}

export function audit(req: Request, action: string, entityType: string, entityId: string, metadata?: Prisma.InputJsonValue) {
  return prisma.auditLog.create({ data: { tenantId: req.auth!.tenantId!, actorUserId: req.auth!.userId, action, entityType, entityId, metadata } });
}

export const optionalText = (max: number) => z.string().trim().max(max).nullish().transform(value => value || null);

// CPF (11 digits) or CNPJ (14 digits). Only the length is checked, not the check digits.
export const documentSchema = z.string().trim().nullish().transform((value, ctx) => {
  const digits = (value ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length !== 11 && digits.length !== 14) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CPF deve ter 11 dígitos e CNPJ 14 dígitos' }); return z.NEVER; }
  return digits;
});

export const validationError = (error: z.ZodError) => ({ message: 'Validation failed', errors: error.flatten() });
