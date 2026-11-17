import test from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';
import { seedMaster } from '../seed-master';

test('master seed creates only new accounts and never promotes or resets existing users', async () => {
  const findUnique = prisma.user.findUnique;
  const create = prisma.user.create;
  const oldEmail = process.env.MASTER_ADMIN_EMAIL;
  const oldPassword = process.env.MASTER_ADMIN_PASSWORD;
  let existing = false;
  let created: any;
  (prisma.user as any).findUnique = async () => existing ? { id: 'existing' } : null;
  (prisma.user as any).create = async (args: any) => { created = args.data; return args.data; };
  try {
    process.env.MASTER_ADMIN_EMAIL = ' Master@Example.com ';
    process.env.MASTER_ADMIN_PASSWORD = 'replace-with-a-unique-password-12-chars-minimum';
    await assert.rejects(seedMaster(), /unique MASTER_ADMIN_PASSWORD/);
    process.env.MASTER_ADMIN_PASSWORD = 'é'.repeat(37);
    await assert.rejects(seedMaster(), /72 bytes maximum/);
    process.env.MASTER_ADMIN_PASSWORD = 'a-long-unique-password';
    existing = true;
    await assert.rejects(seedMaster(), /will not modify existing accounts/);
    assert.equal(Boolean(created), false);
    existing = false;
    await seedMaster();
    assert.equal(created.email, 'master@example.com');
    assert.equal(created.role, 'MASTER_ADMIN');
    assert.equal(created.tenantId, undefined);
    assert(await bcrypt.compare('a-long-unique-password', created.passwordHash));
  } finally {
    (prisma.user as any).findUnique = findUnique;
    (prisma.user as any).create = create;
    if (oldEmail === undefined) delete process.env.MASTER_ADMIN_EMAIL; else process.env.MASTER_ADMIN_EMAIL = oldEmail;
    if (oldPassword === undefined) delete process.env.MASTER_ADMIN_PASSWORD; else process.env.MASTER_ADMIN_PASSWORD = oldPassword;
    await prisma.$disconnect();
  }
});
