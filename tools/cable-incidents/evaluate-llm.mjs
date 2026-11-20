// Score phase 2 (the local model) on the labelled notices the rules leave in
// doubt. Uses title and summary only (no article fetch), one notice at a
// time, only while the model is idle.
//   node tools/cable-incidents/evaluate-llm.mjs [--limit N] [--base-url URL]
// A wrong llm-clear would put a cable fault on the map with nobody to stop
// it, so it is reported first.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CABLE_SOURCES } from '../../server/providers/intel/connectors/cables.js';
import { createLocalLlm } from '../../server/providers/intel/localLlm.js';
import { catalogueNames, cableMentions } from '../../src/intel/cableInbox.js';
import { assessNotice, datedNotice } from '../../src/intel/cableSignals.js';
import {
  buildCablePrompt,
  cableAssessmentSchema,
  validateCableAssessment,
} from '../../src/intel/cableAssessment.js';

const { values } = parseArgs({
  options: {
    limit: { type: 'string', default: '40' },
    match: { type: 'string' },
    'base-url': { type: 'string', default: process.env.GEV_LLM_BASE_URL },
  },
});
const names = catalogueNames(
  JSON.parse(
    readFileSync(
      new URL(
        '../../src/data/local_data/telegeography_submarine_cables/cable-geo.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ),
);
const { notices } = JSON.parse(
  readFileSync(new URL('./labelled-notices.json', import.meta.url), 'utf8'),
);
const byId = new Map(CABLE_SOURCES.map((s) => [s.id, s]));
const llm = createLocalLlm({ baseUrl: values['base-url'] });
await llm.probe();
if (llm.status().status !== 'online') {
  console.log(
    `Local model not online (${llm.status().last_error ?? 'no answer'})`,
  );
  process.exit(2);
}
// The model judges each notice as of the day it was published.
const doubt = notices
  .map((notice) => ({ notice: datedNotice(notice), raw: notice }))
  .filter(({ notice }) => {
    const source = byId.get(notice.sourceId);
    const got = assessNotice({
      item: notice,
      source,
      names,
      now: Date.parse(notice.publishedAt ?? '') + 3600_000 || Date.now(),
    });
    return got.signal === 'doubt' && got.cables.length;
  })
  .filter(({ notice }) => !values.match || notice.title.includes(values.match))
  .slice(0, Number(values.limit));
const tally = {
  right: 0,
  wrongClear: [],
  wrongUnverified: [],
  missed: 0,
  rejected: {},
};
for (const { notice, raw } of doubt) {
  while (await llm.busy()) await new Promise((r) => setTimeout(r, 5000));
  const source = byId.get(notice.sourceId);
  const cables = [
    ...new Map(
      cableMentions(`${notice.title}\n${notice.summary}`, names).map((c) => [
        c.cableId,
        { cableId: c.cableId, name: c.name },
      ]),
    ).values(),
  ];
  const published = Date.parse(notice.publishedAt ?? '') || Date.now();
  const today = new Date(published).toISOString().slice(0, 10);
  let verdict;
  try {
    const reply = await llm.complete(
      buildCablePrompt({ notice, source, cables, today, article: '' }),
      cableAssessmentSchema(cables.map((c) => c.cableId)),
    );
    verdict = validateCableAssessment(reply.text, {
      notice,
      article: '',
      source,
      cables,
      now: published + 3600_000,
    });
  } catch (error) {
    verdict = { signal: 'llm-rejected', reason: `error: ${error.message}` };
  }
  const wanted = raw.expected;
  if (verdict.signal === 'llm-clear') {
    if (wanted === `clear-${verdict.claim}`) tally.right += 1;
    else tally.wrongClear.push(`${notice.title} (said ${verdict.claim})`);
  } else if (verdict.signal === 'llm-unverified') {
    if (
      wanted === 'not-clear' &&
      !/fault|outage|cut|damage|repair|restor/i.test(notice.title)
    )
      tally.wrongUnverified.push(notice.title);
  } else {
    tally.rejected[verdict.reason] = (tally.rejected[verdict.reason] ?? 0) + 1;
    if (wanted !== 'not-clear') tally.missed += 1;
  }
  process.stdout.write(
    `${verdict.signal.padEnd(15)} ${wanted.padEnd(15)} ${String(verdict.cableId ?? verdict.reason ?? '').padEnd(28)} ${notice.title.slice(0, 80)}\n`,
  );
}
console.log(
  `\nchecked ${doubt.length}; right llm-clear ${tally.right}; WRONG llm-clear ${tally.wrongClear.length}; missed ${tally.missed}`,
);
for (const t of tally.wrongClear) console.log(`WRONG CLEAR  ${t}`);
console.log('rejected:', JSON.stringify(tally.rejected));
process.exitCode = tally.wrongClear.length ? 1 : 0;
