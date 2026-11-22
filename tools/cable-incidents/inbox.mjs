// Observe-only submarine cable inbox. See README.md, "Watch for new notices".
//   node tools/cable-incidents/inbox.mjs <poll|list|accept|reject|report> [options]
// State lives in --state (default: ./state next to this file, git-ignored):
// sources.json (yours), inbox.json, evidence.json (reviewed rows), ioda.json.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  acceptProposal,
  buildReport,
  emptyInbox,
  formatReport,
  pollIoda,
  pollSources,
  readSources,
  rejectProposal,
} from '../../server/providers/intel/cableInbox.js';
import { printable } from '../../src/intel/cableInbox.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CATALOGUE = path.join(
  HERE,
  '../../src/data/local_data/telegeography_submarine_cables/cable-geo.json',
);
const USAGE = `Usage:
  inbox.mjs poll   [--state DIR] [--ioda] [--include-existing]
  inbox.mjs list   [--state DIR] [--all]
  inbox.mjs accept <proposal> --claim fault|break|restored --incident ID
                   --effective UTC [--cable ID | --cable-name NAME]
                   [--source-kind KIND] [--url URL] [--state DIR]
  inbox.mjs reject <proposal> [--reason TEXT] [--state DIR]
  inbox.mjs report [--state DIR] [--at UTC]`;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback();
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

/** Write beside the target, then rename: crash-recoverable, not atomically visible. */
function writeJson(file, value) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

const utc = (time) => new Date(time).toISOString().replace('.000Z', 'Z');

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: 'string', default: path.join(HERE, 'state') },
      ioda: { type: 'boolean', default: false },
      'include-existing': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      claim: { type: 'string' },
      incident: { type: 'string' },
      effective: { type: 'string' },
      cable: { type: 'string' },
      'cable-name': { type: 'string' },
      'source-kind': { type: 'string' },
      url: { type: 'string' },
      reason: { type: 'string' },
      at: { type: 'string' },
    },
  });
  const [command, target, ...extra] = positionals;
  if (!command || extra.length) throw new Error(USAGE);
  const dir = path.resolve(values.state);
  mkdirSync(dir, { recursive: true });
  const files = {
    sources: path.join(dir, 'sources.json'),
    inbox: path.join(dir, 'inbox.json'),
    evidence: path.join(dir, 'evidence.json'),
    ioda: path.join(dir, 'ioda.json'),
    lock: path.join(dir, 'inbox.lock'),
  };
  const now = () => Date.now();

  // One run at a time: a second run would overwrite the first one's state.
  let lock;
  try {
    lock = openSync(files.lock, 'wx');
  } catch {
    throw new Error(
      `${files.lock} exists: another run is in progress, or one stopped early (delete the file if none is running)`,
    );
  }
  // Ctrl-C mid-poll: give the lock back before leaving.
  const release = () => {
    rmSync(files.lock, { force: true });
    process.exit(130);
  };
  process.once('SIGINT', release);
  try {
    const catalogue = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
    const inbox = readJson(files.inbox, emptyInbox);
    const evidence = readJson(files.evidence, () => ({
      evidence: [],
    })).evidence;
    if (!Array.isArray(evidence))
      throw new Error(`${files.evidence}: expected {"evidence": [...]}`);
    if (command === 'poll') {
      if (target) throw new Error(USAGE);
      if (!existsSync(files.sources))
        throw new Error(
          `No ${files.sources}. Copy sources.example.json there and review each source first.`,
        );
      const config = readSources(
        JSON.parse(readFileSync(files.sources, 'utf8')),
      );
      const result = await pollSources({
        sources: config.sources,
        inbox,
        catalogue,
        fetchImpl: globalThis.fetch,
        now,
        includeExisting: values['include-existing'],
      });
      writeJson(files.inbox, result.inbox);
      for (const s of result.summary)
        console.log(
          s.error
            ? `${s.source}: failed (${s.error})`
            : `${s.source}: ${s.items} listed, ${s.baseline ? 'baseline recorded' : `${s.added} new`}`,
        );
      if (values.ioda || config.ioda.enabled) {
        try {
          const ioda = await pollIoda({ fetchImpl: globalThis.fetch, now });
          writeJson(files.ioda, ioda);
          console.log(`IODA: ${ioda.outages.length} countries with outages`);
        } catch (error) {
          console.log(`IODA: failed (${error.message})`);
        }
      }
      return;
    }
    if (command === 'list') {
      const shown = inbox.proposals.filter(
        (p) => values.all || p.status === 'new',
      );
      const t = printable;
      for (const p of shown)
        console.log(
          `${t(p.id)} ${t(p.status)} ${t(p.sourceKind)} ${t(p.sourceId)}${p.offHost ? ' (links to another site)' : ''} ${t(p.publishedAt ?? p.seenAt)}\n  ${t(p.title || p.url)}\n  ${t(p.url)}\n  cables: ${p.cables.map((c) => `${t(c.cableId)}${c.weak ? ' (weak)' : ''}`).join(', ') || 'none'}; suggested: ${t(p.suggestedClaim ?? 'none')}${p.cues?.break ? `; break wording: ${p.cues.break.map(t).join(', ')}` : ''}${p.cues?.doubt ? `; doubtful wording: ${p.cues.doubt.map(t).join(', ')}` : ''}`,
        );
      if (!shown.length) console.log('Nothing waiting for review.');
      return;
    }
    if (command === 'accept') {
      if (!target || !values.claim || !values.incident || !values.effective)
        throw new Error(USAGE);
      const result = acceptProposal({
        inbox,
        evidence,
        catalogue,
        proposal: target,
        claim: values.claim,
        incidentId: values.incident,
        effectiveAt: values.effective,
        cableId: values.cable ?? null,
        cableName: values['cable-name'] ?? null,
        sourceKind: values['source-kind'] ?? null,
        sourceUrl: values.url ?? null,
        now,
      });
      writeJson(files.evidence, { evidence: result.evidence });
      writeJson(files.inbox, result.inbox);
      const cable = result.row.cableId ?? `"${result.row.cableName}"`;
      console.log(
        `${result.outcome.lead ? `Added ${result.row.id}, but it stays a lead: ${result.outcome.lead}` : `Added ${result.row.id} to ${files.evidence}`}\n  cable ${cable} (${result.cableFrom === 'matched' ? 'the only cable the notice names' : 'as given'}), ${result.row.sourceKind}, known from ${result.row.knownAt}`,
      );
      return;
    }
    if (command === 'reject') {
      if (!target) throw new Error(USAGE);
      writeJson(
        files.inbox,
        rejectProposal({
          inbox,
          proposal: target,
          reason: values.reason,
          now,
        }),
      );
      console.log(`Rejected ${target}`);
      return;
    }
    if (command === 'report') {
      if (target) throw new Error(USAGE);
      const report = buildReport({
        catalogue,
        evidence,
        inbox,
        ioda: readJson(files.ioda, () => null),
        asOf: values.at ?? utc(now()),
      });
      process.stdout.write(formatReport(report));
      return;
    }
    throw new Error(USAGE);
  } finally {
    process.off('SIGINT', release);
    closeSync(lock);
    rmSync(files.lock, { force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`Cable inbox: ${error.message}\n`);
  process.exitCode = 1;
});
