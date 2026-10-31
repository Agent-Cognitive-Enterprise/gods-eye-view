// Fast Intelligence: push sources in front of the existing event engine. This
// module owns their lifetimes, the queue, operator settings and the numbers the
// health panel shows. It adds no scheduler and no event store: what it finds
// becomes ordinary observations, and the Autopilot treats them by the engine's
// rules. It never touches the camera. Off unless GEV_FAST_FEEDS=1; with
// GEV_INTEL_OFFLINE=1 nothing connects to anything.

import path from 'node:path';
import { createBlueskyAdapter, isDid } from './adapters/bluesky.js';
import { createTelegramAdapter } from './adapters/telegram.js';
import { createEnricher } from './enricher.js';
import { canonicalLink, compileRules } from './gate.js';
import { createIntake } from './intake.js';
import { createLatencyBook } from './latency.js';
import { createPipeline } from './pipeline.js';
import { hasLogin, loadLogin, secretFile } from './secretStore.js';
import {
  TRUST_TAGS,
  readFastSettings,
  sanitizeFastSettings,
  writeFastSettings,
} from './settings.js';

const PASS_MS = 250;
// With a backlog, yield to the server and come straight back.
const BUSY_PASS_MS = 5;
const PRUNE_EVERY_MS = 6 * 3600_000;
const MAX_SHOWN_MEMORY = 20_000;
const MAX_POLLED_IDS = 50_000;
const HANDLE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}\.)+[a-zA-Z]{2,63}$/;
const RESOLVE_HOST = 'https://public.api.bsky.app';
export const FAST_PROVIDERS = Object.freeze(['bluesky', 'telegram']);

/** Engineering targets from the specification, in milliseconds at p95. */
export const SLO_P95_MS = Object.freeze({
  receive_to_event: 30_000,
  receive_to_display: 60_000,
});

export const fastFeedsEnabled = (env = process.env) =>
  env.GEV_FAST_FEEDS === '1';

/**
 * Publication delay of the poll-based feeds, for the latency panel. A feed's
 * first batch after a start is everything still in force, some of it days old,
 * and says nothing about delay; only records that appeared since an earlier
 * poll are measured.
 */
export function createPolledObserver(latency) {
  const seen = new Map(); // feed id -> ids already delivered

  return ({ id, records, receivedAt }) => {
    const known = seen.get(id);
    const ids = records.map((record) => record.source_item_id);
    if (!known) {
      seen.set(id, new Set(ids));
      return;
    }
    records.forEach((record, index) => {
      if (known.has(ids[index])) return;
      known.add(ids[index]);
      const published = Date.parse(record.published_at);
      const at = Number.isFinite(published)
        ? published
        : Number(record.published_at);
      latency.record(id, 'publish_to_receive', receivedAt - at);
    });
    if (known.size > MAX_POLLED_IDS) seen.set(id, new Set(ids));
  };
}

/**
 * @param {{engine: object, store: object, llm?: object, dir: string,
 *   env?: object, now?: () => number, log?: Function, latency?: object,
 *   queueFile?: string, WebSocketImpl?: Function, connectTelegram?: Function,
 *   loadTelegramLogin?: Function, fetchImpl?: Function, feeds?: () => object[],
 *   intervalMs?: number}} options
 */
export function createFastFeeds({
  engine,
  store,
  llm = null,
  dir,
  env = process.env,
  now = () => Date.now(),
  log = (...args) => console.warn(...args),
  latency = createLatencyBook(),
  queueFile = path.join(dir, 'fast-intake.sqlite'),
  WebSocketImpl,
  connectTelegram,
  loadTelegramLogin,
  fetchImpl = (...args) => globalThis.fetch(...args),
  feeds = () => [],
  intervalMs = PASS_MS,
}) {
  const offline = env.GEV_INTEL_OFFLINE === '1';
  const settingsFile = path.join(dir, 'fast-feeds.json');
  let settings = readFastSettings(settingsFile, log);
  let rules = compileRules(settings.languagePacks);
  const intake = createIntake({
    file: queueFile,
    rawRetentionDays: settings.rawRetentionDays,
    now,
    warn: log,
  });

  const accounts = () =>
    settings.bluesky.accounts.map((account) => ({
      ...account,
      source_type: TRUST_TAGS[account.tag],
    }));
  const channels = () =>
    settings.telegram.channels.map((channel) => ({
      ...channel,
      source_type: TRUST_TAGS[channel.tag],
    }));

  const enricher = llm
    ? createEnricher({
        llm,
        engine,
        store,
        now,
        log,
        enabled: () => settings.placeEnrichment,
      })
    : null;
  let pipeline = null;
  const buildPipeline = () => {
    pipeline = createPipeline({
      intake,
      engine,
      latency,
      rules,
      now,
      log,
      accountPostsPerMinute: settings.reportsPerAccountPerMinute,
      onCandidate: (job) => enricher?.add(job),
    });
  };
  buildPipeline();

  const bluesky = createBlueskyAdapter({
    accounts,
    intake,
    canonical: canonicalLink,
    now,
    log,
    ...(WebSocketImpl ? { WebSocketImpl } : {}),
  });
  const telegramLoginFile = secretFile(env);
  const telegram = createTelegramAdapter({
    channels,
    intake,
    canonical: canonicalLink,
    now,
    log,
    loadLogin:
      loadTelegramLogin ??
      (() =>
        hasLogin(telegramLoginFile) ? loadLogin(telegramLoginFile) : null),
    connect:
      connectTelegram ??
      (async (login, options) => {
        const { connectTeleproto } =
          await import('./adapters/telegramClient.js');
        return connectTeleproto(login, options);
      }),
  });
  const adapters = [bluesky, telegram];

  let timer = null;
  let pruneTimer = null;
  let running = false;
  const shown = new Set();

  async function loop() {
    if (!running) return;
    let handled = 0;
    try {
      // Drain what is there, a bounded pass at a time, yielding between them.
      handled = pipeline.pass();
    } catch (error) {
      log(`[fast-feeds] pipeline: ${error.message}`);
    }
    timer = setTimeout(loop, handled ? BUSY_PASS_MS : intervalMs);
    timer.unref?.();
  }

  function applyEnabled() {
    bluesky.setEnabled(!offline && settings.bluesky.enabled);
    telegram.setEnabled(!offline && settings.telegram.enabled);
  }

  /** Every push source joined with its counters and latency. */
  function sourceHealth() {
    const counters = intake.counters();
    const measured = latency.summary();
    return adapters.map((adapter) => ({
      ...adapter.health(),
      counters: counters[adapter.id] ?? {},
      latency: measured[adapter.id] ?? {},
    }));
  }

  function slo() {
    const worst = (stage) => {
      const values = Object.values(latency.summary())
        .map((source) => source[stage])
        .filter(Boolean);
      return values.length
        ? {
            samples: values.reduce((sum, v) => sum + v.samples, 0),
            p95_ms: Math.max(...values.map((v) => v.p95_ms)),
          }
        : null;
    };
    return Object.entries(SLO_P95_MS).map(([stage, target]) => {
      const reading = worst(stage);
      return {
        stage,
        target_p95_ms: target,
        measured: reading,
        met: reading ? reading.p95_ms <= target : null,
      };
    });
  }

  return {
    intake,
    latency,
    pipeline: () => pipeline,
    adapters,
    start() {
      if (running) return;
      running = true;
      applyEnabled();
      enricher?.start();
      loop();
      pruneTimer = setInterval(() => {
        try {
          intake.prune();
        } catch (error) {
          log(`[fast-feeds] prune: ${error.message}`);
        }
      }, PRUNE_EVERY_MS);
      pruneTimer.unref?.();
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      clearInterval(pruneTimer);
      enricher?.stop();
      await Promise.all(adapters.map((adapter) => adapter.stop()));
    },
    async close() {
      await this.stop();
      intake.close();
    },
    status() {
      return {
        enabled: true,
        offline,
        sources: sourceHealth(),
        polled: feeds().map((feed) => ({
          id: feed.id,
          provider: feed.provider,
          status: feed.status,
          interval_ms: feed.interval_ms,
          last_success_at: feed.last_success_at,
          latest_observation_at: feed.latest_observation_at,
          latency: latency.summary()[feed.id] ?? {},
        })),
        queue: intake.stats(),
        enrichment: enricher?.status() ?? null,
        slo: slo(),
        dead_letters: intake.deadLetters(10),
      };
    },
    /** What went through the gate lately, with no report text. */
    reports: (limit = 50) =>
      intake
        .recent(Math.min(200, Math.max(1, limit)))
        .map(({ body, ...row }) => row),
    settings: () => settings,
    updateSettings(input) {
      const previous = settings;
      settings = sanitizeFastSettings(input, settings);
      writeFastSettings(settingsFile, settings);
      rules = compileRules(settings.languagePacks);
      buildPipeline();
      if (!running) return settings;
      if (
        JSON.stringify(previous.bluesky.accounts) !==
        JSON.stringify(settings.bluesky.accounts)
      )
        bluesky.restart();
      if (
        JSON.stringify(previous.telegram.channels) !==
        JSON.stringify(settings.telegram.channels)
      )
        Promise.resolve(telegram.restart()).catch((error) =>
          log(`[fast-feeds] telegram restart: ${error.message}`),
        );
      applyEnabled();
      return settings;
    },
    /** A public handle to its stable account id, from Bluesky's own directory. */
    async resolveHandle(handle) {
      const name = String(handle ?? '')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();
      if (isDid(name)) return { did: name };
      if (!HANDLE.test(name)) return null;
      const response = await fetchImpl(
        `${RESOLVE_HOST}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(name)}`,
        { redirect: 'error', signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) return null;
      const body = await response.json();
      return isDid(body?.did) ? { did: body.did, handle: name } : null;
    },
    /** The first time events reach the map, for the shown-on-globe latency. */
    noteShown(events) {
      for (const event of events) {
        if (shown.has(event.event_id)) continue;
        if (!event.providers?.some((p) => FAST_PROVIDERS.includes(p))) continue;
        if (event.fast_status === 'candidate') continue;
        shown.add(event.event_id);
        if (shown.size > MAX_SHOWN_MEMORY) shown.clear();
        for (const row of intake.markDisplayed(event.event_id))
          latency.record(
            row.source_id,
            'receive_to_display',
            now() - row.received_at,
          );
      }
    },
    /** Every clock of one event, kept apart. */
    timeline(eventId) {
      const event = engine.getEvent(eventId);
      if (!event) return null;
      const reports = intake.forEvent(eventId);
      const displayed = reports.map((r) => r.displayed_at).filter(Boolean);
      const evidence = store.evidenceFor(eventId).map(({ observation: o }) => ({
        provider: o.provider,
        publisher: o.publisher,
        attribution: o.attribution,
        source_type: o.source_type,
        url: o.url,
        language: o.language,
        excerpt: o.withdrawn ? null : o.summary?.slice(0, 280),
        withdrawn: Boolean(o.withdrawn),
        published_at: o.published_at,
        received_at: o.received_at,
      }));
      return {
        event_id: eventId,
        status: event.verification,
        event_time: event.event_time_known ? event.occurred_at : null,
        event_time_known: Boolean(event.event_time_known),
        first_known_source_publication_time: event.first_published_at ?? null,
        first_detected_at: event.first_seen_at,
        first_displayed_at: displayed.length ? Math.min(...displayed) : null,
        first_corroborated_at: event.first_corroborated_at ?? null,
        last_material_update_at: event.last_meaningful_update_at,
        location: event.location,
        reports,
        evidence,
        changes: store.revisions(eventId).map((revision) => ({
          revision: revision.revision,
          at: revision.recorded_at,
          outcome: revision.outcome,
          reasons: revision.reasons,
        })),
      };
    },
  };
}
