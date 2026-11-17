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
  const oldUsername = process.env.MASTER_ADMIN_USERNAME;
  let existing = false;
  let usernameTaken = false;
  let created: any;
  (prisma.user as any).findUnique = async (args: any) => (args.where.email ? existing : usernameTaken) ? { id: 'existing' } : null;
  (prisma.user as any).create = async (args: any) => { created = args.data; return args.data; };
  try {
    process.env.MASTER_ADMIN_EMAIL = ' Master@Example.com ';
    process.env.MASTER_ADMIN_USERNAME = 'Admin';
    process.env.MASTER_ADMIN_PASSWORD = 'replace-with-a-unique-password-12-chars-minimum';
    await assert.rejects(seedMaster(), /unique MASTER_ADMIN_PASSWORD/);
    process.env.MASTER_ADMIN_PASSWORD = 'é'.repeat(37);
    await assert.rejects(seedMaster(), /72 bytes maximum/);
    process.env.MASTER_ADMIN_PASSWORD = 'A-long-unique-password1!';
    existing = true;
    await assert.rejects(seedMaster(), /will not modify existing accounts/);
    assert.equal(Boolean(created), false);
    existing = false;
    usernameTaken = true;
    await assert.rejects(seedMaster(), /email or username/);
    assert.equal(Boolean(created), false);
    usernameTaken = false;
    await seedMaster();
    assert.equal(created.email, 'master@example.com');
    assert.equal(created.username, 'admin');
    assert.equal(created.name, 'Admin');
    assert.equal(created.mustChangePassword, true);
    assert.equal(created.role, 'MASTER_ADMIN');
    assert.equal(created.tenantId, undefined);
    assert(await bcrypt.compare('A-long-unique-password1!', created.passwordHash));
  } finally {
    (prisma.user as any).findUnique = findUnique;
    (prisma.user as any).create = create;
    if (oldEmail === undefined) delete process.env.MASTER_ADMIN_EMAIL; else process.env.MASTER_ADMIN_EMAIL = oldEmail;
    if (oldPassword === undefined) delete process.env.MASTER_ADMIN_PASSWORD; else process.env.MASTER_ADMIN_PASSWORD = oldPassword;
    if (oldUsername === undefined) delete process.env.MASTER_ADMIN_USERNAME; else process.env.MASTER_ADMIN_USERNAME = oldUsername;
    await prisma.$disconnect();
  }
});
