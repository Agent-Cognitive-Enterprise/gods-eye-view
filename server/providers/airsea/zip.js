// Bounded ZIP reader for S-100 exchange sets (fork feature): every entry
// whose name passes `accept`, inflated with hard caps on entry count, entry
// size and total output. No dependency; stored and deflated entries only.

import zlib from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * @param {Buffer|Uint8Array} buffer
 * @param {{accept?: (name: string) => boolean, maxEntries?: number,
 *   maxEntryBytes?: number, maxTotalBytes?: number}} [options]
 * @returns {{name: string, text: string}[]}
 */
export function readZipTextEntries(
  buffer,
  {
    accept = () => true,
    maxEntries = 10_000,
    maxEntryBytes = 2 * 1024 * 1024,
    maxTotalBytes = 96 * 1024 * 1024,
  } = {},
) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--)
    if (bytes.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a ZIP archive');
  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  if (count > maxEntries || offset === 0xffffffff)
    throw new Error('unsupported ZIP');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== CENTRAL)
      throw new Error('corrupt ZIP directory');
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || !accept(name)) continue;
    if (size > maxEntryBytes) throw new Error(`ZIP entry too large: ${name}`);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== LOCAL)
      throw new Error('corrupt ZIP entry');
    const start =
      local +
      30 +
      bytes.readUInt16LE(local + 26) +
      bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + compressed);
    let inflated;
    if (method === 0) inflated = data;
    else if (method === 8)
      inflated = zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes });
    else throw new Error('unsupported ZIP compression');
    total += inflated.length;
    if (total > maxTotalBytes) throw new Error('ZIP content too large');
    out.push({ name, text: inflated.toString('utf8') });
  }
  return out;
}
