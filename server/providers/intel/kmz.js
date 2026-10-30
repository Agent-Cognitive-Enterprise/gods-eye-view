// Bounded KMZ → placemark reader for server-side ingestion. The browser layer
// parses KML with the DOM; the server has none, so this reads only what event
// ingestion needs — name, description table, point, timestamp — with hard caps
// on archive entries, inflated size, placemark count and field length. Markup
// is reduced to text by the existing pure GhostMaps helpers and never executed.

import { elements } from './connectors/xml.js';
import zlib from 'node:zlib';
import {
  htmlToText,
  parseDescriptionFields,
} from '../../../src/layers/ghostMaps/records.js';
import { parseKmlCoordinates } from '../../../src/layers/ghostMaps/kml.js';

export const MAX_KML_BYTES = 64 * 1024 * 1024;
export const MAX_PLACEMARKS = 20_000;
const MAX_ENTRIES = 4096;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The first `.kml` entry (preferring doc.kml) of a ZIP buffer, as text. */
export function readKmlFromKmz(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '<?xml')
    return bytes.toString('utf8'); // a bare KML
  return readZipEntry(
    bytes,
    (names) =>
      names.find((n) => /(^|\/)doc\.kml$/i.test(n)) ??
      names.find((n) => /\.kml$/i.test(n)),
  );
}

/**
 * One entry of a ZIP buffer as UTF-8 text; `choose(names)` picks it. Bounded:
 * entry count, declared and inflated size.
 */
export function readZipEntry(buffer, choose) {
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
  if (count > MAX_ENTRIES || offset === 0xffffffff)
    throw new Error('unsupported ZIP');
  const entries = [];
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
    entries.push({ name, method, compressed, size, local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  const chosen = choose(entries.map((e) => e.name));
  const entry = entries.find((e) => e.name === chosen);
  if (!entry) throw new Error('entry not found in archive');
  if (entry.size > MAX_KML_BYTES) throw new Error('archive entry too large');
  if (bytes.readUInt32LE(entry.local) !== LOCAL)
    throw new Error('corrupt ZIP entry');
  const start =
    entry.local +
    30 +
    bytes.readUInt16LE(entry.local + 26) +
    bytes.readUInt16LE(entry.local + 28);
  const data = bytes.subarray(start, start + entry.compressed);
  if (entry.method === 0) return data.toString('utf8');
  if (entry.method !== 8) throw new Error('unsupported compression');
  return zlib
    .inflateRawSync(data, { maxOutputLength: MAX_KML_BYTES })
    .toString('utf8');
}

const tag = (xml, name) => {
  const [first] = elements(xml, name, 1);
  if (!first) return null;
  const inner = first.inner.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return cdata ? cdata[1] : inner;
};

/**
 * Placemarks with a single point: `{id, name, fields, links, lon, lat, when}`.
 * Lines and polygons are skipped (they are areas of control, not incidents).
 */
export function readPlacemarks(kml, { max = MAX_PLACEMARKS } = {}) {
  const out = [];
  // Linear scan (a lazy regex is quadratic on unclosed tags in a hostile file).
  for (const element of elements(kml, 'Placemark', max * 4)) {
    if (out.length >= max) break;
    const body = element.inner;
    const point = /<Point\b[\s\S]*?<coordinates>([^<]*)<\/coordinates>/i.exec(
      body,
    );
    if (!point) continue;
    const [coordinate] = parseKmlCoordinates(point[1]);
    if (!coordinate) continue;
    const description = tag(body, 'description') ?? '';
    const { fields, links } = parseDescriptionFields(description);
    out.push({
      id: /\bid="([^"]{1,80})"/.exec(element.attributes)?.[1] ?? null,
      name: htmlToText(tag(body, 'name') ?? '').slice(0, 200),
      fields,
      links,
      lon: coordinate[0],
      lat: coordinate[1],
      when: htmlToText(tag(body, 'when') ?? '') || null,
    });
  }
  return out;
}
