// Assessment scheduler: which events the local model looks at, and when.
// Deterministic pre-selection (active, reasonably important, revision not yet
// assessed), highest attention first, a few per cycle, one at a time, under an
// hourly cap — and never while KoboldCpp is busy with someone else's work.
// A failure, timeout or invalid reply leaves the rule-based scores in place.

import {
  ASSESSMENT_SCHEMA,
  PROMPT_VERSION,
  assessmentCacheKey,
  buildAssessmentPrompt,
  validateAssessment,
} from '../../../src/intel/assessment.js';
import { foregroundActive } from './llmGate.js';

const CYCLE_MS = 15_000;
const PROBE_EVERY_MS = 60_000;
const MAX_CACHE = 2_000;
const MIN_ATTENTION_FOR_AI = 40;
// After a failed generation (usually a timeout on a busy GPU) the model gets
// a rest, and that event revision is not tried again for a while.
const FAILURE_PAUSE_MS = 5 * 60_000;
const FAILED_RETRY_MS = 30 * 60_000;
// A frequently revised event (US weather alerts) is re-assessed at most this
// often; in between its score is rule-based.
const REASSESS_GAP_MS = 20 * 60_000;

/**
 * @param {{llm: object, worlds: () => Array<{name: string, engine: object,
 *   store: object, now: number}>, enabled: () => boolean, now?: () => number,
 *   perCycle?: number, hourlyCap?: number, log?: Function}} options
 */
export function createAssessor({
  llm,
  worlds,
  enabled,
  now = () => Date.now(),
  perCycle = 3,
  hourlyCap = 40,
  log = (...args) => console.warn(...args),
}) {
  const cache = new Map(); // cache key -> {ok, at, errors?}
  const recent = []; // generation start times, for the hourly cap
  const counts = { assessed: 0, rejected: 0, failed: 0, skipped_busy: 0 };
  let timer = null;
  let running = false;
  let cycling = null;
  let pending = 0;
  let lastCycleAt = null;
  let lastRejection = null;
  let pausedUntil = 0;

  const remember = (key, value) => {
    cache.set(key, value);
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
  };

  /** Events worth a model's time, best first, across worlds. */
  function candidates(model) {
    const out = [];
    for (const world of worlds()) {
      for (const event of world.engine.activeEvents(world.now)) {
        if (
          event.attention_score < MIN_ATTENTION_FOR_AI &&
          !event.camera_eligible
        )
          continue;
        if (event.verification === 'retracted') continue;
        if (
          event.assessment?.model === model &&
          (event.assessment.revision === event.revision ||
            now() - (event.assessment.assessed_at ?? 0) < REASSESS_GAP_MS)
        )
          continue;
        const prompt = buildAssessmentPrompt(
          event,
          world.store.observationsFor(event.event_id),
          { exercise: world.name === 'replay' },
        );
        const key = assessmentCacheKey(event, prompt.digest, model);
        const seen = cache.get(key);
        if (seen && !(seen.failed && now() - seen.at >= FAILED_RETRY_MS))
          continue;
        out.push({ world, event, prompt, key });
      }
    }
    return out.sort(
      (a, b) =>
        b.event.attention_score - a.event.attention_score ||
        (a.event.event_id < b.event.event_id ? -1 : 1),
    );
  }

  async function assessOne({ world, event, prompt, key }, model) {
    let lastErrors = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      recent.push(now());
      const { text, latencyMs } = await llm.complete(
        prompt.messages,
        ASSESSMENT_SCHEMA,
      );
      const result = validateAssessment(text, {
        evidenceMap: prompt.evidenceMap,
      });
      if (result.ok) {
        world.engine.setAssessment(event.event_id, {
          ...result.assessment,
          revision: event.revision,
          model,
          prompt_version: PROMPT_VERSION,
          assessed_at: now(),
          latency_ms: latencyMs,
        });
        remember(key, { ok: true, at: now() });
        counts.assessed += 1;
        return;
      }
      lastErrors = result.errors;
    }
    // Rejected twice: keep rule-based scoring for this revision, do not loop.
    counts.rejected += 1;
    lastRejection = { event_id: event.event_id, errors: lastErrors, at: now() };
    remember(key, { ok: false, at: now(), errors: lastErrors });
    log(
      `[intel] model output rejected for ${event.event_id}: ${lastErrors.join(', ')}`,
    );
  }

  async function runCycle() {
    lastCycleAt = now();
    if (!enabled()) return 'disabled';
    // A voice conversation has the model (and its prompt cache) to itself.
    if (foregroundActive(now())) return 'foreground';
    let status = llm.status();
    if (status.status === 'refused_non_loopback') return 'refused';
    if (
      status.status !== 'online' &&
      now() - (status.last_probe_at ?? 0) >= PROBE_EVERY_MS
    )
      status = await llm.probe();
    if (status.status !== 'online') return 'offline';
    if (now() < pausedUntil) return 'backing_off';
    const model = status.model;
    const queue = candidates(model);
    pending = queue.length;
    let done = 0;
    for (const job of queue) {
      if (done >= perCycle || !enabled()) break;
      while (recent.length && now() - recent[0] > 3_600_000) recent.shift();
      if (recent.length >= hourlyCap) return 'hourly_cap';
      // Checked before every job: a voice turn waits for at most one assessment.
      if (foregroundActive(now())) return 'foreground';
      if (await llm.busy()) {
        counts.skipped_busy += 1;
        return 'busy_elsewhere';
      }
      try {
        await assessOne(job, model);
      } catch (error) {
        counts.failed += 1;
        remember(job.key, { ok: false, failed: true, at: now() });
        pausedUntil = now() + FAILURE_PAUSE_MS;
        log(
          `[intel] local model failed for ${job.event.event_id}: ${error.message}`,
        );
        return 'failed';
      }
      done += 1;
      pending -= 1;
    }
    return 'ok';
  }

  /**
   * One cycle at a time: a manual trigger joins the running cycle instead of
   * starting a second one, whose own generation would read as "busy elsewhere".
   */
  function cycle() {
    cycling ??= runCycle()
      .catch((error) => {
        log('[intel] assessment cycle failed:', error.message);
        return 'failed';
      })
      .finally(() => {
        cycling = null;
      });
    return cycling;
  }

  async function loop() {
    if (!running) return;
    await cycle();
    if (running) {
      timer = setTimeout(loop, CYCLE_MS);
      timer.unref?.();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      llm.probe().finally(loop);
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
    cycle,
    status() {
      const s = llm.status();
      return {
        enabled: enabled(),
        state: !enabled() ? 'paused' : s.in_flight ? 'busy' : s.status,
        model: s.model,
        server: s.server,
        base_url: s.base_url,
        last_ok_at: s.last_ok_at,
        last_error: s.last_error,
        queue_length: pending,
        last_cycle_at: lastCycleAt,
        last_rejection: lastRejection,
        backoff_until: pausedUntil > now() ? pausedUntil : null,
        prompt_version: PROMPT_VERSION,
        ...counts,
      };
    },
  };
}
