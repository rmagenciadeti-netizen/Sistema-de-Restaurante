import crypto from 'node:crypto';

// AES-256-GCM sealing of secrets stored in the database (WhatsApp pairing, AI provider key). The key is derived from a server-side secret and a
// purpose label, so a value sealed for one purpose cannot be opened as another, and nothing readable ever leaves the server.
export function sealWith(purpose: string, envNames: string[], plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(purpose, envNames), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}
export function openWith(purpose: string, envNames: string[], payload: string): string {
  const [version, iv, tag, data] = payload.split(':');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('INVALID_SEALED_PAYLOAD');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(purpose, envNames), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
function deriveKey(purpose: string, envNames: string[]): Buffer {
  const secret = envNames.map(name => process.env[name]).find(Boolean);
  if (!secret) throw new Error(`${envNames.join(' or ')} is required to store secrets`);
  return crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();
}
