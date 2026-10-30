// IHO S-124 navigational warnings (GML 3.2, S-124 2.0.0) as WarningRecord
// drafts (fork feature). Used for the Canadian Coast Guard's S-124 *trial*
// exchange set, which is test data: every draft is marked trial.
// Pure and portable: plain index scanning, no DOM, no dependencies.
//
// GML positions in EPSG:4326 are "lat lon"; drafts carry GeoJSON [lon, lat].

import { circlePolygon } from './warnings.js';

export const S124_PARSER_VERSION = 's124-1';

/** Elements named `name` (with prefix) as {attributes, inner}; linear time. */
function elements(text, name, max = 5000) {
  const out = [];
  const open = `<${name}`;
  const close = `</${name}>`;
  let at = 0;
  while (out.length < max) {
    const start = text.indexOf(open, at);
    if (start < 0) break;
    const next = text[start + open.length];
    if (next !== undefined && !/[\s>/]/.test(next)) {
      at = start + open.length;
      continue;
    }
    const headEnd = text.indexOf('>', start);
    if (headEnd < 0) break;
    const attributes = text.slice(start + open.length, headEnd);
    if (attributes.endsWith('/')) {
      out.push({ attributes, inner: '' });
      at = headEnd + 1;
      continue;
    }
    const end = text.indexOf(close, headEnd + 1);
    if (end < 0) break;
    out.push({ attributes, inner: text.slice(headEnd + 1, end) });
    at = end + close.length;
  }
  return out;
}
const first = (text, name) => elements(text, name, 1)[0] ?? null;
const attr = (attributes, key) =>
  new RegExp(`${key}="([^"]*)"`).exec(attributes ?? '')?.[1] ?? null;
const decode = (value) =>
  String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const textOf = (block, name) => {
  const found = first(block ?? '', name);
  return found ? decode(found.inner) : null;
};
/** English text of a localised S-124 element (language + text pairs). */
function localised(block, name) {
  const options = elements(block ?? '', name);
  const english =
    options.find((o) => textOf(o.inner, 'S124:language') === 'eng') ??
    options[0];
  return english ? textOf(english.inner, 'S124:text') : null;
}

/**
 * "lat lon lat lon ..." → [[lon, lat], ...]; with srsDimension 3 every
 * third number (height) is skipped.
 */
function posList(value, dimension = 2) {
  const numbers = String(value ?? '')
    .trim()
    .split(/\s+/)
    .map(Number);
  const step = dimension === 3 ? 3 : 2;
  const out = [];
  for (let i = 0; i + 1 < numbers.length; i += step)
    out.push([numbers[i + 1], numbers[i]]);
  return out;
}
const dimensionOf = (element) =>
  Number(attr(element?.attributes, 'srsDimension')) || 2;
const positionsIn = (block, name) =>
  elements(block, name).flatMap((p) => posList(p.inner, dimensionOf(p)));

const NM_KM = 1.852;
const radiusKm = (block) => {
  const radius = first(block, 'S100:radius');
  const value = Number(decode(radius?.inner));
  if (!Number.isFinite(value) || value <= 0) return null;
  const uom = (attr(radius.attributes, 'uom') ?? 'NM').toUpperCase();
  return uom === 'KM' ? value : uom === 'M' ? value / 1000 : value * NM_KM;
};

/**
 * Geometries of one NavwarnPart, with whether any was derived (a stated
 * circle) or approximate (arcs this parser does not trace).
 */
function partGeometries(part) {
  const geometries = [];
  let derived = false;
  let approximate = false;
  for (const { inner } of elements(part, 'S124:geometry')) {
    for (const point of elements(inner, 'S100:pointProperty')) {
      const pos = positionsIn(point.inner, 'gml:pos');
      if (pos.length) geometries.push({ type: 'Point', coordinates: pos[0] });
    }
    for (const curve of elements(inner, 'S100:curveProperty')) {
      const line = positionsIn(curve.inner, 'gml:posList');
      if (/<[\w.-]*:Arc/.test(curve.inner)) approximate = true;
      if (line.length >= 2)
        geometries.push({ type: 'LineString', coordinates: line });
    }
    for (const surface of elements(inner, 'S100:surfaceProperty')) {
      const exterior = first(surface.inner, 'gml:exterior')?.inner ?? '';
      const circle = first(exterior, 'S100:S100_CircleByCenterPoint');
      if (circle) {
        const [center] = positionsIn(circle.inner, 'gml:pos');
        const km = radiusKm(circle.inner);
        if (center && km) {
          geometries.push(
            circlePolygon({ lon: center[0], lat: center[1] }, km),
          );
          derived = true;
        }
        continue;
      }
      const ring = positionsIn(exterior, 'gml:posList');
      // Arc segments are not traced: the polygon keeps only straight parts.
      if (/<[\w.-]*:Arc/.test(exterior)) approximate = true;
      if (ring.length >= 3)
        geometries.push({ type: 'Polygon', coordinates: [ring] });
    }
  }
  return { geometries, derived, approximate };
}

/** Calendar date (no time zone in the data) → ISO UTC, start or end of day. */
function dateUtc(block, name, endOfDay = false) {
  const date = textOf(first(block, name)?.inner ?? '', 'S100:date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  return `${date}T${endOfDay ? '23:59:59' : '00:00:00'}Z`;
}
const isoUtc = (value) => {
  if (!value) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const SEVERITY_RULES = [
  // Whole words: "determined" is no mine, "flight" no light.
  [
    /(?:explosives?|mines?|minefields?|firing|gunnery|missiles?|rockets?|ordnance)/i,
    'danger',
  ],
  [
    /(?:exercises?|closed|closures?|prohibited|prohibition|restricted|exclusion|security zones?)/i,
    'restricted',
  ],
  [
    /(?:lights?|buoys?|beacons?|aids? to navigation|charts?|depths?)/i,
    'advisory',
  ],
];
const severityOf = (text) =>
  SEVERITY_RULES.find(([pattern]) => pattern.test(text))?.[1] ?? 'caution';

/**
 * One S-124 dataset (a GML file) → {draft, cancels}: a WarningRecord draft
 * and the record ids this message cancels. Null draft when unreadable.
 * @param {string} gml
 * @param {{sourceId: string, sourceUrl: string, idPrefix: string,
 *   fetchedFrom: string}} options
 */
export function parseS124Dataset(
  gml,
  { sourceId, sourceUrl, idPrefix, fetchedFrom },
) {
  const text = String(gml ?? '');
  const dataset = first(text, 'S124:Dataset');
  const datasetId = attr(dataset?.attributes, 'gml:id');
  if (!dataset || !datasetId) return { draft: null, cancels: [] };
  const preamble = first(dataset.inner, 'S124:NavwarnPreamble')?.inner ?? '';
  const series = first(preamble, 'S124:messageSeriesIdentifier')?.inner ?? '';
  const parts = elements(dataset.inner, 'S124:NavwarnPart').map((p) => p.inner);

  const title = localised(preamble, 'S124:navwarnTitle');
  const general = textOf(preamble, 'S124:navwarnTypeGeneral');
  const details = parts
    .map((p) => textOf(p, 'S124:navwarnTypeDetails'))
    .filter(Boolean);
  const place = [
    localised(first(preamble, 'S124:locality')?.inner, 'S124:locationName'),
    localised(first(preamble, 'S124:generalArea')?.inner, 'S124:locationName'),
  ].filter(Boolean);
  const information = parts
    .flatMap((p) => elements(p, 'S124:information'))
    .map((i) => decode(textOf(i.inner, 'S124:text')))
    .filter(Boolean);

  const geometries = [];
  let derived = false;
  let approximate = false;
  for (const part of parts) {
    const found = partGeometries(part);
    geometries.push(...found.geometries);
    derived ||= found.derived;
    approximate ||= found.approximate;
  }
  const starts = parts.map((p) => dateUtc(p, 'S124:dateStart')).filter(Boolean);
  const ends = parts.map((p) => dateUtc(p, 'S124:dateEnd', true));
  const cancellation = dateUtc(preamble, 'S124:cancellationDate');

  // A "Warning Cancellation" reference ends the referenced warning.
  const cancels = elements(dataset.inner, 'S124:References')
    .filter((r) =>
      /cancel/i.test(textOf(r.inner, 'S124:referenceCategory') ?? ''),
    )
    .map((r) =>
      attr(first(r.inner, 'S124:theWarning')?.attributes, 'xlink:href'),
    )
    .filter(Boolean)
    .map((href) => `${idPrefix}${href.replace(/^#/, '')}`);

  const label = [title, place[0]].filter(Boolean).join(' — ');
  const draft = {
    id: `${idPrefix}${datasetId}`,
    sourceId,
    originalId: textOf(series, 'S124:interoperabilityIdentifier'),
    domain: 'maritime',
    warningType:
      [general, ...details].filter(Boolean).join(' / ') ||
      'navigational warning',
    authority: textOf(series, 'S124:agencyResponsibleForProduction'),
    title: label || datasetId,
    originalText: information.join('\n') || null,
    sourceUrl,
    publishedAtUtc: isoUtc(textOf(preamble, 'S124:publicationTime')),
    effectiveFromUtc: starts.sort()[0] ?? null,
    // Open-ended unless every part states an end.
    effectiveUntilUtc:
      ends.length && ends.every(Boolean) ? ends.sort().at(-1) : null,
    cancelledAtUtc: cancellation,
    severity: severityOf(
      [title, general, ...details, ...information].join(' '),
    ),
    geometry:
      geometries.length === 0
        ? null
        : geometries.length === 1
          ? geometries[0]
          : { type: 'GeometryCollection', geometries },
    geometryPrecision: geometries.length
      ? approximate
        ? 'approximate'
        : derived
          ? 'derived_checked'
          : 'official'
      : 'none',
    geometryNotes: [
      derived ? 'circle built from the stated centre and radius' : null,
      approximate ? 'arc segments drawn as straight lines' : null,
      starts.length ? 'dates carry no time zone; read as UTC days' : null,
    ]
      .filter(Boolean)
      .join('; '),
    trial: true,
    fetchedFrom,
  };
  return { draft, cancels };
}
