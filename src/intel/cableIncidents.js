// Offline projection of operator-reviewed claims. Neither traffic anomalies
// nor the cable map are evidence of a physical break.
const PRIMARY = new Set(['operator', 'authority']);
const SOURCE_KINDS = new Set([...PRIMARY, 'news', 'telemetry', 'social']);
const CLAIMS = new Set(['outage', 'fault', 'break', 'restored']);
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/;

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nameKey = (name) => name.trim().normalize('NFC').toLowerCase();

function utcTime(value, label) {
  if (typeof value === 'string' && UTC.test(value)) {
    const time = Date.parse(value);
    const canonical =
      value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
    if (Number.isFinite(time) && new Date(time).toISOString() === canonical) {
      return time;
    }
  }
  throw new Error(`${label} must be a valid UTC ISO timestamp`);
}

/** Index by exact catalogue ID or name, collapsing multipart features by ID. */
export function indexSubmarineCables(collection) {
  if (!Array.isArray(collection?.features))
    throw new Error('Expected cable GeoJSON features');
  const ids = new Set();
  const names = new Map();
  for (const feature of collection.features) {
    const { id, name } = feature?.properties ?? {};
    if (
      typeof id !== 'string' ||
      !id ||
      typeof name !== 'string' ||
      !name.trim()
    )
      continue;
    ids.add(id);
    const key = nameKey(name);
    if (!names.has(key)) names.set(key, new Set());
    names.get(key).add(id);
  }
  if (!ids.size) throw new Error('Cable catalogue contains no usable IDs');
  return {
    resolve({ cableId, cableName }) {
      const matches = cableName
        ? [...(names.get(nameKey(cableName)) ?? [])]
        : [];
      if (cableId) {
        if (!ids.has(cableId)) return { reason: 'unknown-cable-id' };
        if (cableName && !matches.includes(cableId))
          return { reason: 'cable-id-name-mismatch' };
        return { cableId };
      }
      if (matches.length === 1) return { cableId: matches[0] };
      return {
        reason: matches.length ? 'ambiguous-cable-name' : 'unknown-cable-name',
      };
    },
  };
}

function normalize(row) {
  const {
    id,
    incidentId = null,
    cableId = null,
    cableName = null,
    claim,
    sourceKind,
    sourceUrl,
    effectiveAt,
    knownAt,
  } = row ?? {};
  if (typeof id !== 'string' || !TOKEN.test(id))
    throw new Error('Invalid evidence ID');
  if (
    incidentId !== null &&
    (typeof incidentId !== 'string' || !TOKEN.test(incidentId))
  ) {
    throw new Error(`${id}: invalid incident ID`);
  }
  for (const value of [cableId, cableName]) {
    if (
      value !== null &&
      (typeof value !== 'string' || !value.trim() || value.length > 250)
    ) {
      throw new Error(`${id}: invalid cable reference`);
    }
  }
  if (!CLAIMS.has(claim) || !SOURCE_KINDS.has(sourceKind)) {
    throw new Error(`${id}: invalid claim or source kind`);
  }
  const url =
    typeof sourceUrl === 'string' && sourceUrl.length <= 2048
      ? URL.parse(sourceUrl)
      : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(
      `${id}: expected a public HTTPS source URL without credentials`,
    );
  }
  const effective = utcTime(effectiveAt, `${id}: effectiveAt`);
  const known = utcTime(knownAt, `${id}: knownAt`);
  if (effective > known)
    throw new Error(`${id}: effectiveAt cannot be after knownAt`);
  return {
    id,
    incidentId,
    cableId,
    cableName,
    claim,
    sourceKind,
    sourceUrl: url.href,
    effectiveAt: new Date(effective).toISOString(),
    knownAt: new Date(known).toISOString(),
  };
}

function projectIncident(cableId, incidentId, evidence) {
  const faults = evidence.filter((row) => row.claim !== 'restored');
  const restores = evidence.filter((row) => row.claim === 'restored');
  const firstRestore = restores[0];
  const latestFault = faults.at(-1);
  const breakConfirmed = faults.some((row) => row.claim === 'break');
  let status;
  let reason = null;
  if (!latestFault) {
    status = 'needs-review';
    reason = 'restore-without-confirmed-fault';
  } else if (
    firstRestore &&
    firstRestore.effectiveAt <= latestFault.effectiveAt
  ) {
    status = 'needs-review';
    reason = 'conflicting-lifecycle';
  } else {
    status = firstRestore
      ? 'reported-restored'
      : breakConfirmed
        ? 'break-confirmed'
        : 'fault-confirmed';
  }
  return {
    cableId,
    incidentId,
    status,
    reason,
    breakConfirmed: !reason && breakConfirmed,
    evidence,
  };
}

/** Replay only information known by asOf. The caller supplies reviewed input. */
export function replayCableIncidents({ catalogue, evidence, asOf }) {
  const cutoff = new Date(utcTime(asOf, 'asOf')).toISOString();
  const index = indexSubmarineCables(catalogue);
  if (!Array.isArray(evidence)) throw new Error('Expected an evidence array');
  const unique = new Map();
  for (const input of evidence) {
    const row = normalize(input);
    if (row.knownAt > cutoff) continue;
    if (
      unique.has(row.id) &&
      JSON.stringify(unique.get(row.id)) !== JSON.stringify(row)
    ) {
      throw new Error(`Conflicting evidence ID: ${row.id}`);
    }
    unique.set(row.id, row);
  }
  const ordered = [...unique.values()].sort(
    (a, b) => compare(a.effectiveAt, b.effectiveAt) || compare(a.id, b.id),
  );
  const groups = new Map();
  const outages = [];
  const leads = [];
  for (const row of ordered) {
    if (row.claim === 'outage') {
      outages.push(row);
      continue;
    }
    const match = index.resolve(row);
    const reason = !PRIMARY.has(row.sourceKind)
      ? 'non-primary-source'
      : !row.incidentId
        ? 'missing-incident-id'
        : match.reason;
    if (reason) {
      leads.push({ reason, evidence: row });
      continue;
    }
    const key = JSON.stringify([match.cableId, row.incidentId]);
    if (!groups.has(key))
      groups.set(key, {
        cableId: match.cableId,
        incidentId: row.incidentId,
        evidence: [],
      });
    groups.get(key).evidence.push(row);
  }
  const incidents = [...groups.values()]
    .sort(
      (a, b) =>
        compare(a.cableId, b.cableId) || compare(a.incidentId, b.incidentId),
    )
    .map(({ cableId, incidentId, evidence: rows }) =>
      projectIncident(cableId, incidentId, rows),
    );
  return { asOf: cutoff, incidents, outages, leads };
}
