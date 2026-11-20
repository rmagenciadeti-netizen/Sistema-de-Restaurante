import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('RM Assistente guide: any signed-in restaurant user can learn, answers carry role and license, nothing is changed', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'g'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, path: string, token?: string, body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };
  const id = randomBytes(4).toString('hex');
  const tenant = await prisma.tenant.create({ data: { name: `Guia ${id}`, slug: `guia-${id}`, status: 'ACTIVE' } });
  const person = async (role: UserRole) => signAccessToken({ userId: (await prisma.user.create({ data: { tenantId: tenant.id, name: role, email: `${role}-${id}@test.local`, passwordHash: 'x', role } })).id, tenantId: tenant.id, unitId: null, role });
  const waiter = await person(UserRole.WAITER); const kitchen = await person(UserRole.KITCHEN); const admin = await person(UserRole.ADMIN);
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await prisma.tenant.deleteMany({ where: { id: tenant.id } }); await prisma.$disconnect(); });

  await t.test('requires a signed-in restaurant user; validates the question', async () => {
    assert.equal((await call('POST', '/guide/ask', undefined, { question: 'como cadastro um produto' })).status, 401);
    assert.equal((await call('POST', '/guide/ask', waiter, { question: 'x' })).status, 400);
    assert.equal((await call('POST', '/guide/ask', waiter, { question: 'como cadastro um produto', page: '../etc/passwd' })).status, 400);
  });

  await t.test('a waiter and a cook can learn; the answer says what their profile can and cannot do', async () => {
    const asWaiter = await call('POST', '/guide/ask', waiter, { question: 'Como cadastro um produto?', page: '/dashboard' });
    assert.equal(asWaiter.status, 200); assert.equal(asWaiter.body.topic.id, 'produto-cadastrar');
    assert.equal(asWaiter.body.access.canView, true); assert.equal(asWaiter.body.access.canEdit, false);
    assert.match(asWaiter.body.answer, /Seu perfil só consulta esta tela/);
    const asAdmin = await call('POST', '/guide/ask', admin, { question: 'Como cadastro um produto?' });
    assert.equal(asAdmin.body.access.canEdit, true);
    const fiscal = await call('POST', '/guide/ask', kitchen, { question: 'como configuro o certificado digital' });
    assert.equal(fiscal.body.access.canView, false); assert.match(fiscal.body.answer, /Seu perfil não acessa/);
  });

  await t.test('license: a company without the fiscal module is told so, a company without license is not restricted', async () => {
    assert.equal((await call('POST', '/guide/ask', admin, { question: 'como emito uma nota fiscal' })).body.access.moduleAvailable, true);
    await prisma.tenantLicense.create({ data: { tenantId: tenant.id, status: 'ACTIVE' } });
    await prisma.tenantModule.create({ data: { tenantId: tenant.id, moduleKey: 'pos' } });
    const restricted = await call('POST', '/guide/ask', admin, { question: 'como emito uma nota fiscal' });
    assert.equal(restricted.body.access.moduleAvailable, false); assert.match(restricted.body.answer, /não está habilitada no plano/);
    assert.equal((await call('POST', '/guide/ask', admin, { question: 'como cadastro um produto' })).status, 200, 'the guide itself is never license-gated');
  });

  await t.test('data questions are left to the data assistant; topics and screens are listed', async () => {
    assert.equal((await call('POST', '/guide/ask', admin, { question: 'Quanto vendi hoje?' })).body.matched, false);
    const topics = await call('GET', '/guide/topics', waiter);
    assert.ok(topics.body.items.length >= 30 && topics.body.items.every((item: any) => item.menuPath));
    assert.equal((await call('GET', '/guide/topics/ncm-cfop', waiter)).status, 200);
    assert.equal((await call('GET', '/guide/topics/inexistente', waiter)).status, 404);
    const screen = await call('GET', '/guide/screen?page=/products', waiter);
    assert.equal(screen.body.kind, 'screen'); assert.match(screen.body.answer, /Preço de venda/);
    assert.equal(await prisma.product.count({ where: { tenantId: tenant.id } }), 0, 'the guide never writes business data');
  });
});
