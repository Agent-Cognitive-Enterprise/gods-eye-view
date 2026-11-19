import { readFileSync } from 'node:fs';
import { replayCableIncidents } from '../../src/intel/cableIncidents.js';

const catalogue = new URL(
  '../../src/data/local_data/telegeography_submarine_cables/cable-geo.json',
  import.meta.url,
);

try {
  const [file, asOf, ...extra] = process.argv.slice(2);
  if (!file || !asOf || extra.length) {
    throw new Error(
      'Usage: node tools/cable-incidents/replay.mjs <evidence.json> <as-of UTC>',
    );
  }
  const { evidence } = JSON.parse(readFileSync(file, 'utf8'));
  const snapshot = replayCableIncidents({
    catalogue: JSON.parse(readFileSync(catalogue, 'utf8')),
    evidence,
    asOf,
  });
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Cable incidents: ${error.message}\n`);
  process.exitCode = 1;
}
