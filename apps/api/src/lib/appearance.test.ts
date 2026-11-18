import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppearance, DEFAULT_APPEARANCE } from './appearance';

const tenant = { mode: 'LIGHT', primary: 'BLUE', sidebar: 'WHITE', allowUserOverride: true } as const;
const personal = { mode: 'DARK', primary: 'GREEN', sidebar: 'NAVY' };

test('personal preference wins over the restaurant default', () => {
  assert.deepEqual(resolveAppearance(tenant, personal), { source: 'USER', value: personal });
});

test('restaurant default applies when the user has none or overrides are disabled', () => {
  assert.equal(resolveAppearance(tenant, null).source, 'TENANT');
  assert.equal(resolveAppearance({ ...tenant, allowUserOverride: false }, personal).value.primary, 'BLUE');
});

test('invalid stored preference falls back and no tenant yields the RM default', () => {
  assert.equal(resolveAppearance(tenant, { mode: 'NEON' }).source, 'TENANT');
  assert.deepEqual(resolveAppearance(null, null), { source: 'DEFAULT', value: DEFAULT_APPEARANCE });
});
