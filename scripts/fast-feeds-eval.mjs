#!/usr/bin/env node
// Evaluates the fast gate against what chosen accounts really posted. Read-only:
// it fetches public posts through Bluesky's API and writes them to a local file
// you name, which holds other people's words: keep it out of the repository.
//
//   fetch   <accounts.json> <posts.jsonl> [--days 21] [--skip-days 0]
//   sample  <posts.jsonl> <dev|test|all> <labels.jsonl> [--rejected 150] [--seed 1]
//   score   <posts.jsonl> <labels.jsonl>
//
// `sample` writes every post the gate passes, and a random sample of what it
// rejects, for someone to label: `current` true when the post reports a specific
// event of a kind this system watches, happening now or within about two days.
// `score` reads those labels. Tune on `dev`. Look at `test` once, afterwards.

import fs from 'node:fs';
import { gateReport } from '../server/providers/fastfeeds/gate.js';
import { resolvePlace } from '../server/providers/fastfeeds/places.js';

const API = 'https://public.api.bsky.app/xrpc';
const DAY = 24 * 3600_000;
const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? Number(process.argv[at + 1]) : fallback;
};

/** The words a report offers the gate: the post, and the headline it links. */
export const reportText = (post) => post.text;

async function fetchPosts(accountsFile, outFile) {
  const days = option('days', 21);
  // --skip-days leaves the newest days out, to fetch an older, unseen period.
  const until = Date.now() - option('skip-days', 0) * DAY;
  const since = until - days * DAY;
  const { bluesky } = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  const out = fs.createWriteStream(outFile);
  for (const account of bluesky.accounts) {
    let cursor = null;
    let count = 0;
    let oldest = Date.now();
    while (oldest >= since) {
      const url = new URL(`${API}/app.bsky.feed.getAuthorFeed`);
      url.searchParams.set('actor', account.did);
      url.searchParams.set('limit', '100');
      url.searchParams.set('filter', 'posts_no_replies');
      if (cursor) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`${account.label}: HTTP ${response.status}`);
      const page = await response.json();
      for (const item of page.feed) {
        oldest = Math.min(oldest, Date.parse(item.post.indexedAt));
        if (item.reason || item.post.author.did !== account.did) continue;
        const at = Date.parse(item.post.record.createdAt);
        if (at < since || at > until) continue;
        const embed =
          item.post.embed?.external ?? item.post.embed?.media?.external;
        out.write(
          `${JSON.stringify({
            uri: item.post.uri,
            account: account.label,
            at: item.post.record.createdAt,
            lang: item.post.record.langs?.[0],
            text: item.post.record.text,
            link_title: embed?.title ?? null,
            link: embed?.uri ?? null,
          })}\n`,
        );
        count += 1;
      }
      cursor = page.cursor;
      if (!cursor || !page.feed.length) break;
    }
    console.log(`${account.label}: ${count}`);
  }
  await new Promise((resolve) => out.end(resolve));
}

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/**
 * The older part tunes the rules; the newest week is held out to judge them.
 * `all` is for a file fetched separately as its own held-out period.
 */
function split(posts) {
  const sorted = [...posts].sort((a, b) => (a.at < b.at ? -1 : 1));
  const newest = Date.parse(sorted.at(-1).at);
  const cut = newest - 7 * DAY;
  return {
    all: sorted,
    dev: sorted.filter((p) => Date.parse(p.at) < cut),
    test: sorted.filter((p) => Date.parse(p.at) >= cut),
  };
}

const gated = (post) =>
  gateReport(post.text, { language: post.lang, publishedAt: post.at });

function sample(postsFile, part, labelsFile) {
  const posts = split(readJsonl(postsFile))[part];
  let state = option('seed', 1);
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), 2654435761) >>> 0;
    state = (state + 0x9e3779b9) >>> 0;
    return state / 4294967296;
  };
  const passed = posts.filter((post) => gated(post).pass);
  const rejected = posts.filter((post) => !gated(post).pass);
  const wanted = option('rejected', 150);
  const chosen = [...rejected]
    .map((post) => [random(), post])
    .sort((a, b) => a[0] - b[0])
    .slice(0, wanted)
    .map(([, post]) => post);
  // Labels are only ever added to. A post the rules no longer pass keeps its
  // row, or the score would quietly lose the evidence against those rules.
  const held = fs.existsSync(labelsFile) ? readJsonl(labelsFile) : [];
  const known = new Set(held.map((row) => row.uri));
  // The rejected sample is drawn once; later samples add only new passes.
  const fresh = (held.length ? passed : [...passed, ...chosen]).filter(
    (post) => !known.has(post.uri),
  );
  const added = fresh.map((post) => {
    const gate = gated(post);
    const place = resolvePlace(post.text);
    return {
      uri: post.uri,
      account: post.account,
      passed: gate.pass,
      subtype: gate.subtype ?? null,
      place: place.location.place ?? null,
      precision: place.location.precision,
      current: null,
      why: null,
      place_ok: null,
      text: post.text.replace(/\s+/g, ' ').slice(0, 220),
    };
  });
  const rows = [...held, ...added];
  fs.writeFileSync(labelsFile, rows.map((r) => JSON.stringify(r)).join('\n'));
  console.log(
    JSON.stringify({
      part,
      posts: posts.length,
      passed: passed.length,
      labelled_rows: rows.length,
      unlabelled: rows.filter((r) => r.current === null).length,
    }),
  );
}

function score(postsFile, labelsFile) {
  const posts = new Map(readJsonl(postsFile).map((post) => [post.uri, post]));
  const labels = readJsonl(labelsFile).filter((row) => row.current !== null);
  // Re-gated with the rules as they are now, whatever they were when labelled.
  const rows = labels.map((row) => ({
    ...row,
    pass: gated(posts.get(row.uri)).pass,
  }));
  const passed = rows.filter((row) => row.pass);
  const hits = passed.filter((row) => row.current);
  const missed = rows.filter((row) => !row.pass && row.current);
  const population = [...posts.values()];
  const rejectedAll = population.filter((post) => !gated(post).pass).length;
  const rejectedLabelled = rows.filter((row) => !row.pass).length;
  const missRate = rejectedLabelled ? missed.length / rejectedLabelled : 0;
  const estimatedMissed = missRate * rejectedAll;
  const why = {};
  for (const row of passed.filter((r) => !r.current))
    why[row.why ?? 'unstated'] = (why[row.why ?? 'unstated'] ?? 0) + 1;
  const byAccount = {};
  for (const row of passed) {
    const held = (byAccount[row.account] ??= { passed: 0, real: 0 });
    held.passed += 1;
    if (row.current) held.real += 1;
  }
  const places = hits.filter((row) => row.place_ok !== null);
  console.log(
    JSON.stringify(
      {
        labelled: rows.length,
        passed: passed.length,
        real: hits.length,
        precision_percent:
          Math.round((hits.length / passed.length) * 1000) / 10,
        false_positive_classes: why,
        by_account: byAccount,
        rejected_labelled: rejectedLabelled,
        missed_in_sample: missed.length,
        estimated_recall_percent:
          Math.round((hits.length / (hits.length + estimatedMissed)) * 1000) /
          10,
        located_real_reports: places.length,
        place_correct_percent: places.length
          ? Math.round(
              (places.filter((r) => r.place_ok).length / places.length) * 1000,
            ) / 10
          : null,
      },
      null,
      1,
    ),
  );
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'fetch') await fetchPosts(rest[0], rest[1]);
else if (command === 'sample') sample(rest[0], rest[1], rest[2]);
else if (command === 'score') score(rest[0], rest[1]);
else {
  console.error('usage: fetch | sample | score (see the top of this file)');
  process.exit(2);
}
