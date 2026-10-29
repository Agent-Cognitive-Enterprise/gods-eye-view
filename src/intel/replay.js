// Deterministic replay of a scenario through the same engine as live data.
// Scenario records carry minute offsets; `expandScenario` turns them into raw
// observations at absolute times, including syndicated copies and repeated
// republishes. A replay owns its own memory store, so a drill never writes to
// the live evidence archive. Pure and portable: the caller supplies the clock.

import { createIntelEngine } from './engine.js';
import { createMemoryIntelStore } from './memoryStore.js';

const MIN = 60_000;
const at = (base, minutes) =>
  Number.isFinite(minutes) ? base + minutes * MIN : undefined;

/**
 * Raw records with absolute times and a `release_at` (when the feed would
 * deliver them), sorted by release time then id.
 * @param {{records: object[]}} scenario
 * @param {number} base Epoch ms of minute 0.
 */
export function expandScenario(scenario, base) {
  const out = [];
  for (const record of scenario.records ?? []) {
    const {
      at_min: atMin = 0,
      occurred_min: occurredMin,
      published_min: publishedMin,
      copies_of: copiesOf,
      copies = 0,
      repeat_every_min: every,
      repeat_count: repeatCount = 0,
      ...rest
    } = record;
    const shape = (extra, offsetMin = 0) => ({
      provider: 'replay',
      license: 'Synthetic test data',
      attribution: "God's Eye View drill fixture (synthetic)",
      language: 'en',
      ...rest,
      occurred_at: at(base, occurredMin),
      published_at: at(
        base,
        Number.isFinite(publishedMin) ? publishedMin + offsetMin : undefined,
      ),
      release_at: base + (atMin + offsetMin) * MIN,
      ...extra,
    });
    if (copiesOf) {
      for (let n = 1; n <= copies; n++)
        out.push(
          shape({
            source_item_id: `${rest.source_item_id}-${n}`,
            publisher: `Drill Aggregator ${n}`,
            url: `https://drill-aggregator-${n}.example/${copiesOf}`,
          }),
        );
    } else if (every && repeatCount) {
      for (let n = 0; n < repeatCount; n++)
        out.push(
          shape({ source_item_id: `${rest.source_item_id}-${n}` }, n * every),
        );
    } else out.push(shape({}));
  }
  return out.sort(
    (a, b) =>
      a.release_at - b.release_at ||
      (a.source_item_id < b.source_item_id ? -1 : 1),
  );
}

/**
 * A replay world: simulated clock, own store and engine.
 * @param {{scenario: object, base: number, settings?: object}} options
 */
export function createReplay({ scenario, base, settings = {} }) {
  const records = expandScenario(scenario, base);
  let clock = base;
  let released = 0;
  const store = createMemoryIntelStore();
  const engine = createIntelEngine({ store, now: () => clock, settings });
  const log = [];

  /** Advance the simulated clock (never backwards) and deliver due records. */
  function advanceTo(ms) {
    clock = Math.max(clock, ms);
    while (released < records.length && records[released].release_at <= clock) {
      const due = records[released].release_at;
      const batch = [];
      while (released < records.length && records[released].release_at === due)
        batch.push(records[released++]);
      for (const result of engine.ingest(batch, { receivedAt: due }))
        log.push({ at: due, ...result });
    }
    return clock;
  }

  return {
    id: scenario.id,
    base,
    store,
    engine,
    advanceTo,
    now: () => clock,
    log: () => [...log],
    done: () => released >= records.length,
    endsAt: base + (scenario.duration_min ?? 60) * MIN,
  };
}
