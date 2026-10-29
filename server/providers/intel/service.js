// The event-intelligence service: evidence store + deterministic engine + feed
// runners + an optional replay world + operator settings. HTTP lives in
// index.js; this module owns state and lifetimes and is unit-testable with an
// in-memory store and fake clock.

import fs from 'node:fs';
import path from 'node:path';
import { clusterEvents } from '../../../src/intel/clustering.js';
import { createIntelEngine } from '../../../src/intel/engine.js';
import { createReplay } from '../../../src/intel/replay.js';
import {
  AUTOPILOT_DEFAULTS,
  CATEGORIES,
  SCORE_WEIGHTS,
} from '../../../src/intel/taxonomy.js';
import { createAssessor } from './assessor.js';
import { createFeedRunner } from './feeds.js';
import { createSqliteIntelStore } from './store.js';

const RETENTION_DAYS = 90;

const PRUNE_EVERY_MS = 6 * 3600_000;
const MAX_LIST = 500;

/** Operator settings: defaults plus validated, bounded overrides. */
export function sanitizeSettings(input = {}) {
  const out = {};
  const num = (key, lo, hi) => {
    const value = Number(input[key]);
    if (input[key] !== undefined && Number.isFinite(value))
      out[key] = Math.min(hi, Math.max(lo, value));
  };
  num('minimumAttentionScore', 0, 100);
  num('minimumCameraConfidence', 0, 1);
  num('groupingRadiusKm', 25, 5000);
  num('minimumDwellMs', 5_000, 600_000);
  num('repeatFocusCooldownMs', 0, 24 * 3600_000);
  // 101 disables critical interruptions (no score reaches it).
  num('criticalInterruptThreshold', 50, 101);
  num('normalPreemptionMargin', 0, 100);
  num('preemptionConfirmMs', 0, 120_000);
  num('maxMarkersInView', 10, 2000);
  num('tourDwellMs', 15_000, 600_000);
  num('tourMinimumScore', 0, 100);
  num('pullBackHoldMs', 0, 120_000);
  num('pullBackStepMs', 2_000, 60_000);
  for (const key of [
    'autopilotEnabled',
    'narrationEnabled',
    'localAiEnabled',
    'tourWhenIdle',
    'pullBackEnabled',
    'tourAnalystIncidents',
  ])
    if (typeof input[key] === 'boolean') out[key] = input[key];
  if (input.categoryRelevance && typeof input.categoryRelevance === 'object') {
    out.categoryRelevance = {};
    for (const category of CATEGORIES) {
      const value = Number(input.categoryRelevance[category]);
      if (Number.isFinite(value))
        out.categoryRelevance[category] = Math.min(100, Math.max(0, value));
    }
  }
  if (input.weights && typeof input.weights === 'object') {
    out.weights = {};
    for (const term of Object.keys(SCORE_WEIGHTS)) {
      const value = Number(input.weights[term]);
      if (Number.isFinite(value))
        out.weights[term] = Math.min(1, Math.max(0, value));
    }
  }
  return out;
}

/** Public shape of an event: internal matching state removed. */
export function publicEvent(event) {
  const {
    tokens,
    lineage_keys: lineageKeys,
    event_keys: eventKeys,
    ...rest
  } = event;
  return {
    ...rest,
    synthetic: event.providers?.includes('replay') ?? false,
    explanation: {
      attention: Object.entries(event.score_terms ?? {}).map(
        ([term, value]) => ({
          term,
          value,
          weight: event.score_weights?.[term] ?? null,
          contribution:
            Math.round((event.score_weights?.[term] ?? 0) * value * 10) / 10,
        }),
      ),
      critical_blocked: event.critical_blocked ?? null,
      evidence_factor: event.evidence_factor ?? null,
      camera_blocked:
        event.lifecycle === 'active' && !event.camera_eligible
          ? 'below_camera_confidence_or_filtered'
          : null,
      independent_sources: event.lineages?.length ?? 0,
      duplicates_suppressed: event.duplicate_count ?? 0,
      last_change_reasons: event.last_change_reasons ?? ['new_event'],
    },
  };
}

/**
 * @param {{storeFile?: string, connectors?: object[], now?: () => number,
 *   settingsFile?: string|null, fetchImpl?: Function, log?: Function,
 *   scenarios?: Record<string, object>}} options
 */
export function createIntelService({
  storeFile = ':memory:',
  connectors = [],
  now = () => Date.now(),
  settingsFile = null,
  fetchImpl,
  log = (...args) => console.warn(...args),
  scenarios = {},
  llm = null,
} = {}) {
  const readSettings = () => {
    if (!settingsFile) return {};
    try {
      return sanitizeSettings(
        JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
      );
    } catch {
      return {};
    }
  };
  let overrides = readSettings();
  const settings = () => ({ ...AUTOPILOT_DEFAULTS, ...overrides });
  const store = createSqliteIntelStore({
    file: storeFile,
    retentionDays: RETENTION_DAYS,
    now,
    warn: log,
  });
  const engine = createIntelEngine({ store, now, settings: settings() });
  const runners = connectors.map((connector) =>
    createFeedRunner({
      connector,
      ingest: engine.ingest,
      now,
      fetchImpl,
      log,
      maxRecordAgeMs: RETENTION_DAYS * 24 * 3600_000,
    }),
  );
  let replay = null; // {world, startedAt, speed}
  let pruneTimer = null;
  let started = false;
  // Local model (Phase 3): bounded assessments for the live world and any
  // running drill. Without a model, or while paused, scores stay rule-based.
  const assessor = llm
    ? createAssessor({
        llm,
        now,
        log,
        enabled: () => settings().localAiEnabled !== false,
        worlds: () =>
          [world('live'), replay ? world('replay') : null]
            .filter(Boolean)
            .map((w) => ({ ...w, name: w.kind })),
      })
    : null;

  function world(name) {
    if (name !== 'replay') return { engine, store, now: now(), kind: 'live' };
    if (!replay) return null;
    const simulated =
      replay.world.base + (now() - replay.startedAt) * replay.speed;
    replay.world.advanceTo(Math.min(simulated, replay.world.endsAt));
    return {
      engine: replay.world.engine,
      store: replay.world.store,
      now: replay.world.now(),
      kind: 'replay',
    };
  }

  function listEvents(name, { minScore = 0 } = {}) {
    const w = world(name);
    if (!w) return null;
    const active = w.engine.activeEvents(w.now).slice(0, MAX_LIST);
    const s = settings();
    const eligible = active.filter(
      (e) => e.camera_eligible && e.attention_score >= s.minimumAttentionScore,
    );
    return {
      world: w.kind,
      now: w.now,
      events: active
        .filter((e) => e.attention_score >= minScore)
        .map(publicEvent),
      clusters: clusterEvents(eligible, { diameterKm: s.groupingRadiusKm }),
    };
  }

  function eventDetail(name, id) {
    const w = world(name);
    const event = w?.engine.getEvent(id, w.now);
    if (!event) return null;
    return {
      world: w.kind,
      now: w.now,
      event: publicEvent(event),
      evidence: w.store.evidenceFor(id).map(({ observation, link }) => ({
        observation,
        grouping: {
          method: link.method,
          material: link.material,
          reasons: link.reasons,
          lineage: link.lineage,
          match: link.match ?? null,
        },
      })),
      revisions: w.store.revisions(id),
    };
  }

  return {
    store,
    engine,
    runners,
    start() {
      if (started) return;
      started = true;
      try {
        store.prune();
      } catch (error) {
        log('[intel] prune failed:', error.message);
      }
      pruneTimer = setInterval(() => {
        try {
          store.prune();
        } catch (error) {
          log('[intel] prune failed:', error.message);
        }
      }, PRUNE_EVERY_MS);
      pruneTimer.unref?.();
      for (const runner of runners) runner.start();
      assessor?.start();
    },
    stop() {
      started = false;
      clearInterval(pruneTimer);
      for (const runner of runners) runner.stop();
      assessor?.stop();
    },
    close() {
      this.stop();
      store.close();
    },
    listEvents,
    eventDetail,
    archive: (filter, limit) =>
      store
        .listEvents(filter, { limit })
        .map((e) => publicEvent(engine.evaluate(e))),
    feeds: () => runners.map((runner) => runner.health()),
    aiStatus: () =>
      assessor?.status() ?? { state: 'not_configured', enabled: false },
    assessNow: () => assessor?.cycle() ?? null,
    pollFeed: (id) => runners.find((r) => r.id === id)?.pollOnce() ?? null,
    settings,
    updateSettings(input) {
      overrides = { ...overrides, ...sanitizeSettings(input) };
      engine.configure(settings());
      if (settingsFile) {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        fs.writeFileSync(settingsFile, JSON.stringify(overrides, null, 2));
      }
      return settings();
    },
    resetSettings() {
      overrides = {};
      engine.configure(settings());
      if (settingsFile) fs.rmSync(settingsFile, { force: true });
      return settings();
    },
    startReplay(id, { speed = 1 } = {}) {
      const scenario = scenarios[id];
      if (!scenario) return null;
      replay = {
        world: createReplay({ scenario, base: now(), settings: settings() }),
        startedAt: now(),
        speed: Math.min(600, Math.max(1, Number(speed) || 1)),
      };
      return {
        scenario: id,
        speed: replay.speed,
        base: replay.world.base,
        ends_at: replay.world.endsAt,
      };
    },
    stopReplay() {
      replay = null;
    },
    replayStatus: () =>
      replay
        ? {
            scenario: replay.world.id,
            speed: replay.speed,
            base: replay.world.base,
            now: world('replay').now,
            ends_at: replay.world.endsAt,
          }
        : null,
    flagMerge(eventId, observationId, note) {
      store.flagMerge({
        event_id: String(eventId).slice(0, 80),
        observation_id: String(observationId ?? '').slice(0, 300),
        note: String(note ?? '').slice(0, 500),
        at: now(),
      });
    },
    clearHistory: () => store.clear(),
    status() {
      return {
        enabled: true,
        started,
        store: store.stats(),
        feeds: runners.map((r) => ({ id: r.id, status: r.health().status })),
        replay: this.replayStatus(),
        settings: settings(),
        scenarios: Object.keys(scenarios),
        ai: assessor?.status() ?? { state: 'not_configured', enabled: false },
      };
    },
  };
}
