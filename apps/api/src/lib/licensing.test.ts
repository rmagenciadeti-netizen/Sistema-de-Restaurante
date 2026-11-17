import test from 'node:test';
import assert from 'node:assert/strict';
import { licenseDenial, moduleForPath } from './licensing';

const active = { status: 'ACTIVE' as const, validUntil: null };

test('tenants without a license keep unrestricted access', () => {
  assert.equal(licenseDenial(null, [], '/api/v1/financial/entries'), null);
});

test('inactive or expired licenses deny access while core routes need only an active license', () => {
  assert.match(licenseDenial({ status: 'SUSPENDED', validUntil: null }, ['financial'], '/api/v1/units') ?? '', /not active/);
  assert.match(licenseDenial({ status: 'ACTIVE', validUntil: new Date('2020-01-01') }, [], '/api/v1/units') ?? '', /expired/);
  assert.equal(licenseDenial(active, [], '/api/v1/units'), null);
});

test('modules are enforced from the request path', () => {
  assert.equal(moduleForPath('/api/v1/cash/sessions?x=1'), 'financial');
  assert.equal(moduleForPath('/api/v1/dashboard/restaurant'), null);
  assert.match(licenseDenial(active, ['pos'], '/api/v1/financial/entries') ?? '', /financial/);
  assert.equal(licenseDenial(active, ['pos'], '/api/v1/orders'), null);
});
