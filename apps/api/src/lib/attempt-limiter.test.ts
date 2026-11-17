import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttemptLimiter } from './attempt-limiter';

test('blocks after the maximum failures and frees after the window', () => {
  const limiter = createAttemptLimiter(3, 1000);
  for (let i = 0; i < 2; i += 1) limiter.fail('u', 0);
  assert.equal(limiter.blockedFor('u', 10), 0);
  limiter.fail('u', 20);
  assert.ok(limiter.blockedFor('u', 30) > 0);
  assert.equal(limiter.blockedFor('other', 30), 0);
  assert.equal(limiter.blockedFor('u', 1001), 0);
});

test('reset clears the failures', () => {
  const limiter = createAttemptLimiter(1, 1000);
  limiter.fail('u', 0);
  assert.ok(limiter.blockedFor('u', 1) > 0);
  limiter.reset('u');
  assert.equal(limiter.blockedFor('u', 2), 0);
});
