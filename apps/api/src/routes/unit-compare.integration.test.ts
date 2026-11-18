import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1), like the other *.integration tests.
const enabled = process.env.RUN_DB_TESTS === '1';

test('unit comparison: consolidated real numbers, unit scoping and tenant isolation', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'd'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const get = async (token: string) => {
    const response = await fetch(`${base}/units/compare`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  };

  const suffix = randomBytes(4).toString('hex');
  const makeTenant = async (label: string) => {
    const tenant = await prisma.tenant.create({ data: { name: `${label} ${suffix}`, slug: `${label}-${suffix}`.toLowerCase(), status: 'ACTIVE' } });
    const [north, south] = await Promise.all([prisma.unit.create({ data: { tenantId: tenant.id, name: 'Norte' } }), prisma.unit.create({ data: { tenantId: tenant.id, name: 'Sul' } })]);
    const token = async (role: UserRole, unitId: string | null) => {
      const user = await prisma.user.create({ data: { tenantId: tenant.id, unitId, name: role, email: `${role}-${unitId ?? 'all'}-${label}-${suffix}@test.local`, passwordHash: 'x', role } });
      return signAccessToken({ userId: user.id, tenantId: tenant.id, unitId, role });
    };
    return { tenant, north, south, token };
  };
  const A = await makeTenant('cmp'); const B = await makeTenant('cmpother');
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    const tenantIds = [A.tenant.id, B.tenant.id];
    await prisma.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma.$disconnect();
  });

  const sale = (unitId: string, code: string, total: number) => prisma.order.create({ data: { tenantId: A.tenant.id, unitId, code, status: 'COMPLETED', subtotal: total, total } });
  await sale(A.north.id, `N1-${suffix}`, 100); await sale(A.north.id, `N2-${suffix}`, 50); await sale(A.south.id, `S1-${suffix}`, 30);
  await prisma.order.create({ data: { tenantId: B.tenant.id, unitId: B.north.id, code: `X1-${suffix}`, status: 'COMPLETED', subtotal: 999, total: 999 } });

  await t.test('tenant-wide admin sees every unit plus consolidated totals', async () => {
    const { status, body } = await get(await A.token(UserRole.ADMIN, null));
    assert.equal(status, 200);
    assert.equal(body.items.length, 2);
    assert.equal(body.items.find((item: any) => item.name === 'Norte').revenue, 150);
    assert.equal(body.items.find((item: any) => item.name === 'Norte').averageTicket, 75);
    assert.equal(body.totals.revenue, 180);
    assert.equal(body.totals.orders, 3);
  });
  await t.test('a unit-bound manager only sees its own unit', async () => {
    const { status, body } = await get(await A.token(UserRole.MANAGER, A.south.id));
    assert.equal(status, 200);
    assert.deepEqual(body.items.map((item: any) => item.name), ['Sul']);
    assert.equal(body.totals.revenue, 30);
  });
  await t.test('other tenants never leak and non-finance roles are refused', async () => {
    const other = await get(await B.token(UserRole.ADMIN, null));
    assert.equal(other.body.totals.revenue, 999);
    assert.equal((await get(await A.token(UserRole.WAITER, null))).status, 403);
  });
});
