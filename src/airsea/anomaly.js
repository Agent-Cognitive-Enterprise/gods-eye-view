// Traffic anomalies (fork feature): compare one hour of passages per cell
// with the same hour of the week in earlier weeks. Pure and portable.
//
// Missing data is never read as missing traffic: when the feed delivered
// too few snapshots, or far fewer objects than it normally sees, the answer
// is `coverage_degraded` (inconclusive), not a traffic drop. Until enough
// comparable weeks exist the answer is `baseline_insufficient`.

export const ANOMALY_RULES = Object.freeze({
  // Comparable weeks needed before any anomaly is reported.
  minWeeks: 2,
  // A cell needs this many passages in a normal hour to be judged at all.
  minBaseline: 5,
  // Relative change and robust z-score both required.
  minRelativeChange: 0.5,
  minRobustZ: 3,
  // Coverage: share of expected snapshots, and of normal objects per snapshot.
  minSnapshotShare: 0.75,
  minObjectShare: 0.7,
});

export const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Is an hour's coverage good enough to compare with? */
export function coverageAdequate(
  coverage,
  expectedSnapshots,
  normalObjects,
  rules = ANOMALY_RULES,
) {
  if (!coverage || !(coverage.snapshots > 0))
    return { ok: false, reason: 'no_snapshots' };
  if (coverage.snapshots < rules.minSnapshotShare * expectedSnapshots)
    return { ok: false, reason: 'too_few_snapshots' };
  const perSnapshot = coverage.objects / coverage.snapshots;
  if (normalObjects > 0 && perSnapshot < rules.minObjectShare * normalObjects)
    return { ok: false, reason: 'feed_sees_fewer_objects' };
  return { ok: true, reason: null };
}

/**
 * @param {{current: Map<string, number>, currentCoverage: object,
 *   weeks: {cells: Map<string, number>, coverage: object}[],
 *   expectedSnapshots: number}} input  `weeks`: the same hour 1..n weeks ago.
 * @returns {{status: string, reason: string|null, weeksUsed: number,
 *   confidence: string|null, cells: object[]}}
 */
export function evaluateAnomalies(
  { current, currentCoverage, weeks, expectedSnapshots },
  rules = ANOMALY_RULES,
) {
  // The objects a healthy feed normally sees, from comparable weeks that
  // were themselves delivered in full.
  const delivered = weeks.filter(
    (w) => coverageAdequate(w.coverage, expectedSnapshots, 0, rules).ok,
  );
  const normalObjects = median(
    delivered.map((w) => w.coverage.objects / w.coverage.snapshots),
  );
  const usable = delivered.filter(
    (w) =>
      coverageAdequate(w.coverage, expectedSnapshots, normalObjects, rules).ok,
  );
  // Without comparable weeks nothing can be judged, whatever this hour was.
  if (usable.length < rules.minWeeks)
    return {
      status: 'baseline_insufficient',
      reason: `${usable.length}_of_${rules.minWeeks}_weeks`,
      weeksUsed: usable.length,
      confidence: null,
      cells: [],
    };
  const now = coverageAdequate(
    currentCoverage,
    expectedSnapshots,
    normalObjects,
    rules,
  );
  if (!now.ok)
    return {
      status: 'coverage_degraded',
      reason: now.reason,
      weeksUsed: usable.length,
      confidence: null,
      cells: [],
    };
  const confidence =
    usable.length >= 4 ? 'high' : usable.length >= 3 ? 'medium' : 'low';
  const keys = new Set([
    ...current.keys(),
    ...usable.flatMap((w) => [...w.cells.keys()]),
  ]);
  const cells = [];
  for (const cell of keys) {
    const history = usable.map((w) => w.cells.get(cell) ?? 0);
    const m = median(history);
    if (m < rules.minBaseline) continue;
    const mad = median(history.map((v) => Math.abs(v - m)));
    const value = current.get(cell) ?? 0;
    const change = (value - m) / m;
    const z = (value - m) / (1.4826 * mad + 1);
    if (
      Math.abs(change) < rules.minRelativeChange ||
      Math.abs(z) < rules.minRobustZ
    )
      continue;
    cells.push({
      cell,
      current: value,
      baseline: m,
      changePct: Math.round(change * 100),
      robustZ: Math.round(z * 10) / 10,
      observation:
        change < 0
          ? 'possible_traffic_suppression'
          : 'possible_traffic_increase',
      confidence,
    });
  }
  cells.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return {
    status: 'ok',
    reason: null,
    weeksUsed: usable.length,
    confidence,
    cells,
  };
}
