import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './lib/prisma';

export async function seedMaster() {
  const email = process.env.MASTER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.MASTER_ADMIN_PASSWORD;
  if (!email || !z.string().email().safeParse(email).success || !password || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72 || password === 'replace-with-a-unique-password-12-chars-minimum') throw new Error('Set a valid MASTER_ADMIN_EMAIL and a unique MASTER_ADMIN_PASSWORD (12 characters minimum, 72 bytes maximum) before seeding');
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new Error('A user with this email already exists; seed will not modify existing accounts');
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({ data: { email, name: 'SaaS Master', passwordHash, role: UserRole.MASTER_ADMIN } });
  console.log(`Master user configured: ${email}`);
}
if (require.main === module) {
  seedMaster().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
}
