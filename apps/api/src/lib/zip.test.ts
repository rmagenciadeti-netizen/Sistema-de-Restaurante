import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { createZip } from './zip';

test('creates a deflated ZIP entry with a valid CRC32 checksum', () => {
  const zip = createZip([{ name: 'document.xml', data: 'abc', date: new Date(2026, 0, 1) }]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.equal(zip.readUInt32LE(14), 0x352441c2);
  const nameLength = zip.readUInt16LE(26);
  const extraLength = zip.readUInt16LE(28);
  const compressedLength = zip.readUInt32LE(18);
  const start = 30 + nameLength + extraLength;
  assert.equal(zip.toString('utf8', 30, 30 + nameLength), 'document.xml');
  assert.equal(inflateRawSync(zip.subarray(start, start + compressedLength)).toString(), 'abc');
});
