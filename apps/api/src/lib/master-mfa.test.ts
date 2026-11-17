import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptTotpSecret, encryptTotpSecret, hashRecoveryCode, matchingTotpStep, newRecoveryCodes, newTotpSecret, recoveryCodeIndex, totpCode } from './master-mfa';

test('TOTP follows RFC 6238 truncation and accepts a narrow clock window', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpCode(secret, 59000), '287082');
  const now = 1710000000000;
  assert.equal(matchingTotpStep(secret, totpCode(secret, now), now), BigInt(Math.floor(now / 30000)));
  assert.equal(matchingTotpStep(secret, '000000', now), null);
});

test('TOTP secrets are encrypted and authenticated with the configured 256-bit key', () => {
  const previous = process.env.MFA_ENCRYPTION_KEY;
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const secret = newTotpSecret();
    const encrypted = encryptTotpSecret(secret);
    assert.notEqual(encrypted, secret);
    assert.equal(decryptTotpSecret(encrypted), secret);
    assert.throws(() => decryptTotpSecret(encrypted.replace(/.$/, 'A')));
  } finally {
    if (previous === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = previous;
  }
});

test('recovery codes are random, hashed, and locate exactly one matching entry', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  const hashes = codes.map(hashRecoveryCode);
  assert.equal(recoveryCodeIndex(codes[3].toLowerCase(), hashes), 3);
  assert.equal(recoveryCodeIndex(codes[3], hashes.slice(0, 3)), -1);
});
