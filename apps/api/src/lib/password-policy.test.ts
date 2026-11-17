import assert from 'node:assert/strict';
import test from 'node:test';
import { isStrongPassword } from './password-policy';

test('requires a long password with multiple character types within bcrypt byte limits', () => {
  assert.equal(isStrongPassword('A-strong-password-123'), true);
  assert.equal(isStrongPassword('lowercase-only-password'), false);
  assert.equal(isStrongPassword('Short1!'), false);
  assert.equal(isStrongPassword('Aa1!'.repeat(19)), false);
  assert.equal(isStrongPassword('É'.repeat(37)), false);
});
