import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { prisma } from './lib/prisma';

async function main() {
  const email = process.env.MASTER_ADMIN_EMAIL?.toLowerCase();
  const password = process.env.MASTER_ADMIN_PASSWORD;
  if (!email || !password || password.length < 12) throw new Error('Set MASTER_ADMIN_EMAIL and MASTER_ADMIN_PASSWORD (at least 12 chars) before seeding');
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({ where: { email }, update: { passwordHash, role: UserRole.MASTER_ADMIN, status: 'ACTIVE', tenantId: null }, create: { email, name: 'SaaS Master', passwordHash, role: UserRole.MASTER_ADMIN } });
  console.log(`Master user configured: ${email}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
