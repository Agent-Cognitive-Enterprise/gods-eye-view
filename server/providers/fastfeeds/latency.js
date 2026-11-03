// Rolling latency windows: one small ring per (source, stage). Only real
// measurements go in: a stage with no sample reports nothing, never zero.

const WINDOW = 512;

/** Nearest-rank percentile of a sorted list. */
export function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function createLatencyBook({ window = WINDOW } = {}) {
  const rings = new Map(); // `${source}|${stage}` -> {values, at}

  return {
    /** Negative spans (clock skew) are kept out: they measure nothing. */
    record(source, stage, ms) {
      if (!Number.isFinite(ms) || ms < 0) return;
      const key = `${source}|${stage}`;
      const ring = rings.get(key) ?? { values: [], at: 0 };
      if (ring.values.length < window) ring.values.push(ms);
      else ring.values[ring.at] = ms;
      ring.at = (ring.at + 1) % window;
      rings.set(key, ring);
    },
    /** {source: {stage: {samples, p50_ms, p95_ms, max_ms}}} */
    summary() {
      const out = {};
      for (const [key, ring] of rings) {
        const [source, stage] = key.split('|');
        const sorted = [...ring.values].sort((a, b) => a - b);
        (out[source] ??= {})[stage] = {
          samples: sorted.length,
          p50_ms: Math.round(percentile(sorted, 0.5)),
          p95_ms: Math.round(percentile(sorted, 0.95)),
          max_ms: Math.round(sorted.at(-1)),
        };
      }
      return out;
    },
  };
}
