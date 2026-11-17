import './lib/env';
import bcrypt from 'bcryptjs';
import { PlanType, TenantStatus, UserRole, UserStatus } from '@prisma/client';
import { isStrongPassword } from './lib/password-policy';
import { prisma } from './lib/prisma';

// Development-only: tenant ADMIN users authenticate via /auth/login without MFA (only MASTER_ADMIN requires it).
export async function seedDevOperator() {
  if (process.env.NODE_ENV === 'production') throw new Error('seed:dev-operator must not run in production');
  const email = (process.env.DEV_OPERATOR_EMAIL?.trim() || 'operador@example.com').toLowerCase();
  const password = process.env.DEV_OPERATOR_PASSWORD || 'Operador@Dev2026';
  if (!isStrongPassword(password)) throw new Error('DEV_OPERATOR_PASSWORD must be 12+ characters with at least three character types');
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'dev-restaurante' },
    update: { status: TenantStatus.ACTIVE },
    create: { name: 'Restaurante Dev', slug: 'dev-restaurante', status: TenantStatus.ACTIVE, plan: PlanType.BASIC },
  });
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, status: UserStatus.ACTIVE, mustChangePassword: false, role: UserRole.ADMIN, tenantId: tenant.id },
    create: { email, name: 'Operador Dev', passwordHash, role: UserRole.ADMIN, tenantId: tenant.id },
  });
  console.log(`Dev operator ready: ${email}`);
}
if (require.main === module) {
  seedDevOperator().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
}
