// Score the automatic cable signal rules on the labelled notices.
//   node tools/cable-incidents/evaluate.mjs [labelled.json]
// A wrong clear signal would put a cable fault on the map with no person to
// catch it, so it is reported first; misses come next.
import { readFileSync } from 'node:fs';
import { CABLE_SOURCES } from '../../server/providers/intel/connectors/cables.js';
import { catalogueNames } from '../../src/intel/cableInbox.js';
import { scoreLabelled } from '../../src/intel/cableSignals.js';

const file =
  process.argv[2] ?? new URL('./labelled-notices.json', import.meta.url);
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
const { notices } = JSON.parse(readFileSync(file, 'utf8'));
const score = scoreLabelled({ notices, sources: CABLE_SOURCES, names });
console.log(
  `notices ${score.total}; expected clear ${score.expectedClear}; ` +
    `clear and right ${score.rightClear}; wrong clear ${score.wrongClear.length}; ` +
    `missed ${score.missed.length}; red flags ${score.redFlags}`,
);
for (const n of score.wrongClear) console.log(`WRONG CLEAR  ${n.title}`);
for (const n of score.missed)
  console.log(
    `missed${n.synthetic ? ' (synthetic)' : ''}, ${n.reason}: ${n.title}`,
  );
process.exitCode = score.wrongClear.length ? 1 : 0;
