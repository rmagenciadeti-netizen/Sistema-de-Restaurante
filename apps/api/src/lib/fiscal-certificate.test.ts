import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { CertificateError, checkCertificate, parsePfx } from './fiscal-certificate';

const pfx = Buffer.from(readFileSync(join(__dirname, '../routes/fixtures/test-a1.pfx.b64'), 'utf8').trim(), 'base64');

test('parses an A1 certificate, extracts its CNPJ and validates the private key', () => {
  const cert = parsePfx(pfx, 'teste123');
  assert.equal(cert.keyMatches, true);
  assert.equal(cert.cnpj, '12345678000195');
  assert.equal(cert.validFrom instanceof Date, true);
  assert.equal(checkCertificate(cert, '12345678000195').problems.length, 0);
});

test('rejects wrong passwords and certificates belonging to another company', () => {
  assert.throws(() => parsePfx(pfx, 'incorreta'), (error: unknown) => error instanceof CertificateError && /Senha/.test(error.message));
  const cert = parsePfx(pfx, 'teste123');
  const result = checkCertificate(cert, '98765432000100');
  assert.equal(result.state, 'INVALID');
  assert.match(result.problems.join(' '), /incompatível/);
});

test('allows an e-CNPJ certificate from the issuer branch with the same root and warns clearly', () => {
  const cert = parsePfx(pfx, 'teste123');
  const result = checkCertificate(cert, '12345678000276');
  assert.equal(result.problems.length, 0);
  assert.ok(result.warnings.some(warning => warning.includes('mesma raiz')));
});
