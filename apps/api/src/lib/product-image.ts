// Product photos are uploaded as data URLs, checked by declared type, magic bytes and size, and stored as bytes (see ProductImage).
export const MAX_IMAGE_BYTES = 300 * 1024;
const signatures: Record<string, (data: Buffer) => boolean> = {
  'image/png': data => data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': data => data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  'image/webp': data => data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP',
};

export function parseImageDataUrl(dataUrl: string): { contentType: string; data: Buffer } | { error: string } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return { error: 'Envie uma imagem PNG, JPEG ou WebP.' };
  const data = Buffer.from(match[2], 'base64');
  if (data.length === 0 || data.length > MAX_IMAGE_BYTES) return { error: `A imagem deve ter até ${MAX_IMAGE_BYTES / 1024} KB.` };
  if (!signatures[match[1]](data)) return { error: 'O conteúdo do arquivo não corresponde ao tipo de imagem informado.' };
  return { contentType: match[1], data };
}

export const toDataUrl = (contentType: string, data: Uint8Array) => `data:${contentType};base64,${Buffer.from(data).toString('base64')}`;
