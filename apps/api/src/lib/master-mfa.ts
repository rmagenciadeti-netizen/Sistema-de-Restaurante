import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

function encryptionKey() {
  const configured = process.env.MFA_ENCRYPTION_KEY;
  if (!configured) throw new Error('MFA_ENCRYPTION_KEY must be configured to use Master MFA');
  const key = /^[\da-f]{64}$/i.test(configured) ? Buffer.from(configured, 'hex') : Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new Error('MFA_ENCRYPTION_KEY must be a 32-byte hex or base64 value');
  return key;
}

function encodeBase32(bytes: Buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string) {
  let bits = 0;
  let buffer = 0;
  const output: number[] = [];
  for (const character of value.toUpperCase().replace(/[\s=-]/g, '')) {
    const digit = BASE32.indexOf(character);
    if (digit < 0) throw new Error('Invalid base32 secret');
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

export function newTotpSecret() {
  return encodeBase32(randomBytes(20));
}

export function encryptTotpSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptTotpSecret(value: string) {
  const [version, iv, tag, encrypted] = value.split(':');
  if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted MFA secret');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
}

export function totpCode(secret: string, timestamp = Date.now()) {
  const counter = Math.floor(timestamp / 1000 / STEP_SECONDS);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary = ((digest[offset] & 127) << 24) | ((digest[offset + 1] & 255) << 16) | ((digest[offset + 2] & 255) << 8) | (digest[offset + 3] & 255);
  return String(binary % 1000000).padStart(6, '0');
}

export function matchingTotpStep(secret: string, code: string, now = Date.now()) {
  if (!/^\d{6}$/.test(code)) return null;
  const currentStep = Math.floor(now / 1000 / STEP_SECONDS);
  for (const step of [currentStep, currentStep - 1, currentStep + 1]) {
    if (step < 0) continue;
    const expected = Buffer.from(totpCode(secret, step * STEP_SECONDS * 1000));
    const provided = Buffer.from(code);
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return BigInt(step);
  }
  return null;
}

export function newRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const bytes = randomBytes(8).toString('hex').toUpperCase();
    return `${bytes.slice(0, 4)}-${bytes.slice(4, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12)}`;
  });
}

export function hashRecoveryCode(code: string) {
  return createHash('sha256').update(code.replace(/-/g, '').toUpperCase()).digest('hex');
}

export function recoveryCodeIndex(code: string, hashes: string[]) {
  const candidate = Buffer.from(hashRecoveryCode(code), 'hex');
  return hashes.findIndex(hash => {
    const stored = Buffer.from(hash, 'hex');
    return candidate.length === stored.length && timingSafeEqual(candidate, stored);
  });
}
