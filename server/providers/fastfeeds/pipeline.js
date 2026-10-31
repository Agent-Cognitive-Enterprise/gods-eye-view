// From queue to engine: one bounded pass over waiting reports. The fast path is
// deterministic and needs no model, so nothing a slow or absent Qwen does can
// hold back a first report. A report becomes one raw observation; the existing
// engine decides what it means, exactly as for every other feed.

import { gateReport } from './gate.js';
import { resolvePlace } from './places.js';

const PER_PASS = 200;
// Everything here is synchronous, on the one thread that also serves the app:
// a pass stops at this budget and the rest waits for the next one.
const PASS_BUDGET_MS = 40;
const MAX_TITLE_FROM_TEXT = 200;
// One account may not fill the queue: this many posts a minute, then deferred.
const ACCOUNT_POSTS_PER_MINUTE = 30;
const MINUTE = 60_000;

/** First line of a post as a title; the rest stays in the summary. */
function titleOf(text) {
  const line =
    String(text)
      .split(/\r?\n/)
      .find((part) => part.trim()) ?? '';
  return line.length > MAX_TITLE_FROM_TEXT
    ? `${line.slice(0, MAX_TITLE_FROM_TEXT - 1).trimEnd()}…`
    : line;
}

/** A gated report as a raw observation for the engine. */
export function reportToRecord(report, gate, place) {
  const located = Boolean(place.place_id);
  return {
    provider: report.provider,
    source_item_id: report.native_id,
    publisher: report.publisher,
    source_type: report.source_type,
    url: report.url,
    // One account is one source; so is an article, whoever shares it. A later
    // post of an account's own can therefore correct its earlier claim.
    lineage_key: report.origin ?? report.publisher,
    derived_from: report.derived_from ?? null,
    license: report.license,
    attribution: report.attribution,
    language: gate.language,
    category: gate.category,
    subtype: gate.subtype,
    title: titleOf(report.text),
    summary: report.text,
    // When it happened is unknown: a post says when it was posted, no more.
    occurred_at: null,
    published_at: report.published_at,
    location: place.location,
    status_hint: gate.status_hint,
    // Same kind of incident in the same named place: reports may share
    // almost no words and still be about one thing.
    entities:
      located && gate.subtype ? [`${gate.subtype}@${place.place_id}`] : [],
    metrics: { severity_hint: gate.severity },
  };
}

/**
 * @param {{intake: object, engine: object, latency: object, rules?: object[],
 *   now?: () => number, log?: Function, onCandidate?: Function}} options
 */
export function createPipeline({
  intake,
  engine,
  latency,
  rules,
  now = () => Date.now(),
  log = (...args) => console.warn(...args),
  onCandidate = () => {},
  accountPostsPerMinute = ACCOUNT_POSTS_PER_MINUTE,
}) {
  const recentByAccount = new Map(); // publisher -> {start, count}

  function overRate(publisher, at) {
    const held = recentByAccount.get(publisher);
    if (!held || at - held.start >= MINUTE) {
      recentByAccount.set(publisher, { start: at, count: 1 });
      if (recentByAccount.size > 20_000) recentByAccount.clear();
      return false;
    }
    held.count += 1;
    return held.count > accountPostsPerMinute;
  }

  function processDelete(row) {
    const { report } = row;
    const earlier = intake
      .history(row.source_id, row.native_id)
      .filter((entry) => entry.kind !== 'delete' && entry.event_id);
    let eventId = null;
    for (const entry of earlier) {
      eventId = entry.event_id;
      engine.withdrawReport(entry.event_id, {
        provider: report.provider,
        sourceItemId: row.native_id,
      });
    }
    intake.blank(row.source_id, row.native_id);
    intake.complete(row.seq, {
      status: 'processed',
      outcome: earlier.length ? 'withdrawn' : 'nothing_held',
      eventId,
    });
    intake.count(row.source_id, 'deleted');
  }

  function processReport(row) {
    const { report } = row;
    const gate = gateReport(report.text, {
      language: report.language,
      rules,
      publishedAt: report.published_at,
    });
    if (!gate.pass) {
      intake.complete(row.seq, { status: 'filtered', outcome: gate.reason });
      intake.count(row.source_id, 'filtered');
      return;
    }
    if (overRate(report.publisher, now())) {
      intake.complete(row.seq, { status: 'filtered', outcome: 'rate_limited' });
      intake.count(row.source_id, 'deferred');
      return;
    }
    const place = resolvePlace(report.text);
    const [result] = engine.ingest([reportToRecord(report, gate, place)], {
      receivedAt: row.received_at,
    });
    const eventId = result?.event_id ?? null;
    intake.complete(row.seq, {
      status: result?.status === 'rejected' ? 'filtered' : 'processed',
      outcome: result?.status ?? 'none',
      eventId,
    });
    intake.count(row.source_id, 'accepted');
    latency.record(
      row.source_id,
      'publish_to_receive',
      row.received_at - report.published_at,
    );
    latency.record(row.source_id, 'receive_to_event', now() - row.received_at);
    if (result?.status === 'new_event' && !place.place_id)
      onCandidate({
        eventId,
        sourceId: row.source_id,
        nativeId: row.native_id,
      });
  }

  return {
    /** One pass; returns how many reports it handled. */
    pass(limit = PER_PASS) {
      const rows = intake.next(limit);
      const deadline = performance.now() + PASS_BUDGET_MS;
      let handled = 0;
      for (const row of rows) {
        if (handled && performance.now() >= deadline) break;
        handled += 1;
        const started = now();
        try {
          if (row.kind === 'delete') processDelete(row);
          else processReport(row);
        } catch (error) {
          // One unreadable report never blocks the ones behind it.
          log(`[fast-feeds] ${row.source_id} report failed: ${error.message}`);
          intake.complete(row.seq, { status: 'failed', outcome: 'error' });
          intake.deadLetter(row.source_id, error.message, row.native_id);
        }
        latency.record(row.source_id, 'pipeline', now() - started);
      }
      return handled;
    },
  };
}
