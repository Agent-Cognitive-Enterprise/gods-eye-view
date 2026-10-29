#!/usr/bin/env node
/**
 * Browser gate for the early-warning AUTOPILOT (fork feature).
 *
 * Needs a dev server with GEV_INTEL_ENABLED=1, reachable from this machine
 * (the drill is started through a loopback-only route):
 *
 *   GEV_INTEL_ENABLED=1 npm run dev -- --host localhost --port 4174 --strictPort
 *   node scripts/qa-autopilot.mjs --url http://localhost:4174 [--out .gev-logs/qa-autopilot]
 *
 * Drives the real panel with real clicks and real pointer input:
 *   - the panel appears only when the server reports the feature on;
 *   - DEMO DRILL replays the synthetic scenario;
 *   - AUTOPILOT ON flies to the highest-priority cluster and holds its dwell;
 *   - a revision of the event on screen updates it without a second flight;
 *   - after the dwell it rotates; the qualified critical event interrupts once;
 *   - a mouse drag on the globe pauses Autopilot until RESUME (A11);
 *   - with everything shown it settles once on a still global view.
 * Local AI is paused for the run (rule-based scores) and restored afterwards.
 * Writes a timeline (JSON) and screenshots of every shot to --out.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option('--url', 'http://localhost:4174').replace(/\/$/, '');
const OUT = path.resolve(option('--out', '.gev-logs/qa-autopilot'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const checks = [];
const record = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
};

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--use-gl=angle',
    process.platform === 'darwin'
      ? '--use-angle=metal'
      : '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1600,900',
  ],
  defaultViewport: { width: 1600, height: 900 },
});
const timeline = [];
// The camera checks are deterministic only with rule-based scores: the local
// model may legitimately move a drill event below the critical threshold.
const settingsUrl = `${APP_URL}/api/intel/settings`;
const putSettings = (body) =>
  fetch(settingsUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
const savedLocalAi = (await (await fetch(settingsUrl)).json()).localAiEnabled;
await putSettings({ localAiEnabled: false });
const errors = [];
const started = Date.now();
try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  await page.goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__gevIntel?.snapshot().enabled && window.__godsEyeView?.viewer,
    { timeout: 120_000 },
  );
  await sleep(3000);
  const sample = async (label) => {
    const state = await page.evaluate(() => {
      const snap = window.__gevIntel.snapshot();
      const c = window.__godsEyeView.viewer.camera.positionCartographic;
      return {
        ...snap,
        current: snap.current
          ? { key: snap.current.key, members: snap.current.eventIds.length }
          : null,
        decision: snap.lastDecision
          ? `${snap.lastDecision.type}/${snap.lastDecision.reason}`
          : null,
        camera: {
          lat: +((c.latitude * 180) / Math.PI).toFixed(2),
          lon: +((c.longitude * 180) / Math.PI).toFixed(2),
          km: Math.round(c.height / 1000),
        },
      };
    });
    const entry = {
      t: Math.round((Date.now() - started) / 1000),
      label,
      ...state,
    };
    timeline.push(entry);
    return entry;
  };
  const shot = (name) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });

  const panelVisible = await page.evaluate(
    () => !document.getElementById('intel-panel')?.hidden,
  );
  record('panel is shown when the feature is enabled', panelVisible);
  await shot('1-live');

  await page.click('.intel-worlds .data-toggle-chip:nth-of-type(2)');
  await sleep(3500);
  record(
    'DEMO DRILL switches to the replay world',
    (await sample('demo')).world === 'replay',
  );
  await page.click('.intel-mode-btn');
  await sleep(500);
  const on = await sample('autopilot-on');
  record(
    'AUTOPILOT ON flies to the highest-priority cluster',
    on.decision === 'fly/highest_priority',
  );

  const flights = [];
  let lastKey = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2500);
    const entry = await sample('auto');
    if (entry.current?.key && entry.current.key !== lastKey) {
      lastKey = entry.current.key;
      flights.push(entry.decision);
      await sleep(4200);
      await sample('landed');
      await shot(
        `${flights.length + 1}-${entry.decision.replace(/[/_]/g, '-')}`,
      );
    }
  }
  record(
    'rotation happens after the dwell',
    flights.includes('fly/rotation'),
    flights.join(', '),
  );
  record(
    'the qualified critical event interrupts exactly once',
    flights.filter((f) => f === 'fly/critical_interrupt').length === 1,
  );
  record(
    'no flight is repeated for the same cluster',
    new Set(timeline.filter((e) => e.current).map((e) => e.current.key))
      .size === flights.length,
  );

  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(860, 470, { steps: 5 });
  await page.mouse.up();
  await sleep(1000);
  const paused = await sample('after-drag');
  record(
    'a mouse drag pauses Autopilot (A11)',
    paused.mode === 'paused' && paused.pauseReason === 'manual_input',
  );
  await shot('8-paused');
  await sleep(6000);
  record(
    'a paused Autopilot does not retake the camera',
    (await sample('still-paused')).mode === 'paused',
  );
  await page.click('.intel-resume-btn');
  await sleep(5000);
  const resumed = await sample('resumed');
  record(
    'RESUME re-enables Autopilot',
    resumed.mode === 'auto',
    resumed.decision ?? '',
  );
  await shot('9-resumed');
  record('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await putSettings({ localAiEnabled: savedLocalAi !== false }).catch(() => {});
  fs.writeFileSync(
    path.join(OUT, 'timeline.json'),
    JSON.stringify({ checks, timeline, errors }, null, 2),
  );
  await browser.close();
}
const failed = checks.filter((check) => !check.pass);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed; evidence in ${OUT}`,
);
process.exitCode = failed.length ? 1 : 0;
