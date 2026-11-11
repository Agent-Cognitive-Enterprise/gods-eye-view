import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  aggregateCountries,
  assessEvent,
  DECAY_MS,
  normalizeEvent,
} from '../../../src/bankingAccess/model.js';
import { clientKey, makeRateLimiter } from '../common/rate-limit.js';
import { admitSameSiteKeyless } from '../common/same-site.js';
import { createNewsCandidates } from './news.js';

// Banking-access disruptions (fork feature): reviewed events from the
// bundled data file, plus an operator's own file (GEV_BANKING_ACCESS_EVENTS,
// an absolute path; its events add to or replace bundled ones by id), scored
// per country against World Bank population. Optional news candidates
// (GEV_BANKING_NEWS=1) are leads for review, never drawn. GET only.

const BUNDLED = new URL('./events.json', import.meta.url);
const POPULATION = new URL('./population.json', import.meta.url);
const RELOAD_MS = 30_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function readEvents(file) {
  const size = statSync(file).size;
  if (size > MAX_FILE_BYTES) throw new Error('events file too large');
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(doc?.events)) throw new Error('no "events" array');
  return doc.events;
}

/** The population table: iso3 -> { population, year }. */
export function loadPopulation(file = POPULATION) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const table = new Map();
  for (const [iso3, [population, year]] of Object.entries(doc.countries ?? {}))
    table.set(iso3, { population, year });
  return { table, meta: doc.meta ?? {} };
}

/** Every event checked; bad entries listed by reason, the rest kept. */
export function loadEvents({
  bundled = BUNDLED,
  local = null,
  now = Date.now(),
} = {}) {
  const byId = new Map();
  const problems = [];
  const files = [['bundled', bundled], ...(local ? [['local', local]] : [])];
  for (const [origin, file] of files) {
    let raw;
    try {
      raw = readEvents(file);
    } catch (error) {
      // The browser sees this: say what is wrong, never the path.
      const why =
        error.code === 'ENOENT'
          ? 'not found'
          : error instanceof SyntaxError
            ? 'not valid JSON'
            : error.code
              ? 'cannot be read'
              : error.message;
      problems.push(`${origin} file: ${why}`);
      continue;
    }
    const seen = new Set();
    for (const entry of raw) {
      const { event, error } = normalizeEvent(entry, { now });
      if (error) {
        problems.push(`${origin}: ${error}`);
        continue;
      }
      if (seen.has(event.id)) {
        problems.push(`${origin}: ${event.id}: duplicate id (later one kept)`);
      }
      seen.add(event.id);
      byId.set(event.id, { ...event, origin });
    }
  }
  return { events: [...byId.values()], problems };
}

/** The route's answer as of `now`. */
export function bankingAccessSnapshot({
  events,
  problems = [],
  population,
  news,
  now,
  history = false,
}) {
  const assessed = events.map((event) =>
    assessEvent(event, {
      now,
      population: population.table.get(event.iso3)?.population ?? null,
    }),
  );
  const countries = aggregateCountries(assessed, {
    history,
    populationOf: (iso3) => population.table.get(iso3)?.population ?? null,
  }).map((c) => ({
    ...c,
    population: population.table.get(c.iso3)?.population ?? null,
    populationYear: population.table.get(c.iso3)?.year ?? null,
  }));
  const shown = new Set(countries.flatMap((c) => c.eventIds));
  const knownUrls = new Set(events.flatMap((e) => e.sources.map((s) => s.url)));
  return {
    schemaVersion: 1,
    generatedAt: now,
    decayDays: DECAY_MS / 86_400_000,
    countries,
    events: assessed
      .filter((e) => shown.has(e.id))
      .sort((a, b) => b.updatedAt - a.updatedAt),
    counts: {
      events: events.length,
      active: assessed.filter((e) => e.active).length,
      stale: assessed.filter((e) => e.stale).length,
      fading: assessed.filter((e) => !e.active && !e.historical && !e.upcoming)
        .length,
      upcoming: assessed.filter((e) => e.upcoming).length,
      historical: assessed.filter((e) => e.historical).length,
    },
    problems,
    population: {
      source: population.meta.source ?? null,
      license: population.meta.license ?? null,
    },
    news: news.snapshot({ knownUrls }),
  };
}

export function bankingAccessProxy({
  env = process.env,
  now = () => Date.now(),
  fetchImpl,
  bundled = BUNDLED,
} = {}) {
  const localFile = env.GEV_BANKING_ACCESS_EVENTS?.trim() || null;
  const local = localFile && path.isAbsolute(localFile) ? localFile : null;
  const population = loadPopulation();
  const news = createNewsCandidates({
    enabled: env.GEV_BANKING_NEWS === '1',
    ...(fetchImpl ? { fetchImpl } : {}),
    now,
  });
  const allow = makeRateLimiter({ windowMs: 60_000, max: 60, globalMax: 600 });
  let loaded = null;
  let loadedAt = -Infinity;
  const current = () => {
    if (!loaded || now() - loadedAt > RELOAD_MS) {
      loaded = loadEvents({ bundled, local, now: now() });
      if (localFile && !local)
        loaded.problems.push(
          'GEV_BANKING_ACCESS_EVENTS must be an absolute path',
        );
      loadedAt = now();
    }
    return loaded;
  };

  function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...(status === 405 ? { Allow: 'GET' } : {}),
        ...(status === 429 ? { 'Retry-After': '60' } : {}),
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSiteKeyless(req, res)) return;
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const [route, query = ''] = (req.url || '/').split('?');
    if (route !== '/' && route !== '')
      return json(404, { error: 'unknown_route' });
    if (!allow(clientKey(req))) return json(429, { error: 'rate_limited' });
    const { events, problems } = current();
    json(
      200,
      bankingAccessSnapshot({
        events,
        problems,
        population,
        news,
        now: now(),
        history: new URLSearchParams(query).get('history') === '1',
      }),
    );
  }

  return {
    name: 'banking-access',
    configureServer({ middlewares }) {
      middlewares.use('/api/banking-access', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/banking-access', handler);
    },
  };
}
