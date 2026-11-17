import './lib/env';
import bcrypt from 'bcryptjs';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { isStrongPassword } from './lib/password-policy';
import { prisma } from './lib/prisma';

export async function seedMaster() {
  const email = process.env.MASTER_ADMIN_EMAIL?.trim().toLowerCase();
  const username = (process.env.MASTER_ADMIN_USERNAME?.trim() || 'admin').toLowerCase();
  const name = process.env.MASTER_ADMIN_NAME?.trim() || 'Admin';
  const password = process.env.MASTER_ADMIN_PASSWORD;
  if (!email || !z.string().email().safeParse(email).success || !password || !isStrongPassword(password) || password === 'replace-with-a-unique-password-12-chars-minimum') throw new Error('Set a valid MASTER_ADMIN_EMAIL and unique MASTER_ADMIN_PASSWORD; it must be 12 characters minimum, 72 bytes maximum, and include at least three character types');
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('MASTER_ADMIN_USERNAME must be 3-32 letters, numbers, dots, underscores or hyphens');
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    ?? await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (existing) throw new Error('A user with this email or username already exists; seed will not modify existing accounts');
  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({ data: { email, username, name, passwordHash, role: UserRole.MASTER_ADMIN, mustChangePassword: true } });
  console.log(`Master user configured: ${email}`);
}
if (require.main === module) {
  seedMaster().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => prisma.$disconnect());
}
