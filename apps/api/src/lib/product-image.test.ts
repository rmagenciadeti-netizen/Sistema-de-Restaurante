import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_IMAGE_BYTES, parseImageDataUrl, toDataUrl } from './product-image';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);

test('valid images round-trip', () => {
  const parsed = parseImageDataUrl(toDataUrl('image/png', png));
  assert.ok('data' in parsed);
  assert.equal(parsed.contentType, 'image/png');
  assert.deepEqual(parsed.data, png);
});

test('wrong type, spoofed bytes, oversize and non-images are rejected', () => {
  assert.ok('error' in parseImageDataUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='), 'svg could carry scripts');
  assert.ok('error' in parseImageDataUrl('data:text/html;base64,PGgxPg=='));
  assert.ok('error' in parseImageDataUrl(toDataUrl('image/jpeg', png)), 'png bytes declared as jpeg');
  assert.ok('error' in parseImageDataUrl(toDataUrl('image/png', Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]))));
  assert.ok('error' in parseImageDataUrl('not a data url'));
});
