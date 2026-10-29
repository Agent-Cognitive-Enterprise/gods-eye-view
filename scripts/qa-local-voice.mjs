#!/usr/bin/env node
/**
 * Browser gate for local voice and narration (fork feature).
 *
 * Needs the autopilot instance with local voice (GEV_LOCAL_VOICE=1, the
 * whisper.cpp sidecar, Piper and the local model) and a WAV whose speech is
 * a command (Chrome plays it as the microphone, looping):
 *
 *   node scripts/qa-local-voice.mjs --url http://localhost:4174 \
 *     --mic voice/download/mic-ru.wav --expect париж --lat 48.86 --lon 2.35
 *
 * A16: the spoken command is transcribed, interpreted by the local model,
 *      executed through the app's action runner (camera reaches the place)
 *      and answered aloud; stopping voice releases the microphone.
 * A17: Autopilot narration speaks with a caption and stops at once when the
 *      operator drags the map (no orphan playback).
 * A18: no voice or model request leaves this machine.
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
const MIC = option('--mic', null);
const EXPECT = option('--expect', '').toLowerCase();
const LAT = Number(option('--lat', NaN));
const LON = Number(option('--lon', NaN));
const OUT = path.resolve(option('--out', '.gev-logs/qa-local-voice'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const record = (name, pass, detail = '') => {
  checks.push({ name, pass, detail });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
};
if (!MIC || !fs.existsSync(MIC)) {
  console.error('--mic <command.wav> is required');
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const settingsUrl = `${APP_URL}/api/intel/settings`;
const saved = await (await fetch(settingsUrl)).json();
const putSettings = (body) =>
  fetch(settingsUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--use-gl=angle',
    process.platform === 'darwin'
      ? '--use-angle=metal'
      : '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${path.resolve(MIC)}`,
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1600,900',
  ],
  defaultViewport: { width: 1600, height: 900 },
});
const offMachine = [];
const errors = [];
try {
  const page = await browser.newPage();
  const appHost = new URL(APP_URL).host;
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (
      url.host !== appHost &&
      /openai|gemini|realtime|speech|voice|chat\/completions|transcri/i.test(
        url.href,
      )
    )
      offMachine.push(url.href.slice(0, 120));
  });
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 200)));
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
    localStorage.setItem('gev:locale:v1', 'en');
  });
  // The app may re-navigate once at startup (locale); wait for it instead.
  await page
    .goto(`${APP_URL}/`, { waitUntil: 'domcontentloaded' })
    .catch(() => {});
  await page.waitForFunction(
    () => window.__gevIntel?.snapshot().enabled && window.__gevVoiceCommands,
    { timeout: 120_000 },
  );
  await sleep(2000);

  // ---------------------------------------------------------------- A16
  const offered = await page.$$eval('#gev-voice-provider option', (o) =>
    o.map((x) => x.value),
  );
  record(
    'the provider list offers local voice',
    offered.includes('local'),
    offered.join(','),
  );
  await page.select('#gev-voice-provider', 'local');
  await sleep(500);
  await page.evaluate(() => {
    window.__qaVoice = [];
    window.__gevVoiceCommands.session.subscribe((event) =>
      window.__qaVoice.push(event),
    );
  });
  await page.click('#gev-voice-button');
  const started = Date.now();
  await page
    .waitForFunction(
      () =>
        window.__qaVoice.some(
          (e) => e.type === 'transcript' && e.role === 'assistant',
        ),
      { timeout: 90_000, polling: 500 },
    )
    .catch(() => {});
  const voice = await page.evaluate(() =>
    window.__qaVoice.map((e) => ({
      type: e.type,
      role: e.role,
      text: e.text,
      name: e.name,
      state: e.state,
      detail: e.detail,
    })),
  );
  const heard =
    voice.find((e) => e.type === 'transcript' && e.role === 'user')?.text ?? '';
  const answer =
    voice.find((e) => e.type === 'transcript' && e.role === 'assistant')
      ?.text ?? '';
  const calls = voice
    .filter((e) => e.type === 'action-call')
    .map((e) => e.name);
  record(
    'A16: speech is transcribed locally',
    heard.toLowerCase().includes(EXPECT),
    heard,
  );
  record(
    'A16: the local model chose a validated action',
    calls.length > 0,
    calls.join(','),
  );
  record(
    'A16: a spoken reply was produced',
    Boolean(answer),
    `${answer} · ${Math.round((Date.now() - started) / 1000)} s`,
  );
  await sleep(6000); // let the flight land
  const camera = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera.positionCartographic;
    return {
      lat: (c.latitude * 180) / Math.PI,
      lon: (c.longitude * 180) / Math.PI,
    };
  });
  if (Number.isFinite(LAT))
    record(
      'A16: the camera reached the requested place',
      Math.abs(camera.lat - LAT) < 3 && Math.abs(camera.lon - LON) < 3,
      `${camera.lat.toFixed(2)}, ${camera.lon.toFixed(2)}`,
    );
  await page.screenshot({ path: path.join(OUT, 'a16-voice.png') });
  await page.click('#gev-voice-button'); // stop voice
  await sleep(1000);
  const state = await page.evaluate(() => window.__gevVoiceCommands.state);
  record('voice stops cleanly (microphone released)', state === 'idle', state);

  // ---------------------------------------------------------------- A17
  await putSettings({
    narrationEnabled: true,
    localAiEnabled: false,
    tourWhenIdle: false,
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gevIntel?.snapshot().enabled, {
    timeout: 120_000,
  });
  await sleep(2000);
  // The reload can still be settling: confirm the drill is on screen.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.click('.intel-worlds .data-toggle-chip:nth-of-type(2)');
    const replay = await page
      .waitForFunction(() => window.__gevIntel.snapshot().world === 'replay', {
        timeout: 8000,
      })
      .then(() => true)
      .catch(() => false);
    if (replay) break;
  }
  await sleep(1500);
  await page.click('.intel-mode-btn');
  await page
    .waitForFunction(() => Boolean(window.__gevIntel.snapshot().narrating), {
      timeout: 60_000,
      polling: 250,
    })
    .catch(() => {});
  const narrating = await page.evaluate(
    () => window.__gevIntel.snapshot().narrating,
  );
  const caption = await page.evaluate(() => {
    const el = document.querySelector('.intel-caption');
    return el && !el.hidden ? el.textContent : null;
  });
  record(
    'A17: narration speaks a grounded briefing with a caption',
    Boolean(narrating && caption),
    narrating ?? '',
  );
  await page.screenshot({ path: path.join(OUT, 'a17-narration.png') });
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(850, 470, { steps: 4 });
  await page.mouse.up();
  await sleep(500);
  const after = await page.evaluate(() => ({
    narrating: window.__gevIntel.snapshot().narrating,
    mode: window.__gevIntel.snapshot().mode,
    caption: !document.querySelector('.intel-caption')?.hidden,
  }));
  record(
    'A17: a map drag stops narration at once (no orphan playback)',
    !after.narrating && !after.caption && after.mode === 'paused',
    JSON.stringify(after),
  );

  // ---------------------------------------------------------------- A18
  record(
    'A18: no voice or model request left this machine',
    offMachine.length === 0,
    offMachine.join(' | '),
  );
  record('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await putSettings({
    narrationEnabled: saved.narrationEnabled === true,
    localAiEnabled: saved.localAiEnabled !== false,
    tourWhenIdle: saved.tourWhenIdle !== false,
  }).catch(() => {});
  fs.writeFileSync(
    path.join(OUT, 'result.json'),
    JSON.stringify({ checks }, null, 2),
  );
  await browser.close();
}
const failed = checks.filter((check) => !check.pass);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed; evidence in ${OUT}`,
);
process.exitCode = failed.length ? 1 : 0;
