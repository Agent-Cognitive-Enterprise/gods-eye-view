#!/usr/bin/env node
/**
 * Autopilot performance scenes on real hardware (fork tooling).
 *
 *   node scripts/perf-autopilot.mjs --url http://127.0.0.1:4179 --out <dir>
 *     [--chrome <path to chrome.exe>] [--label before] [--seconds 60]
 *     [--scenes idle,hold,flight,fast,airsea,hidden] [--width 1920 --height 1080]
 *     [--overview on|off] [--profile]
 *
 * Runs a visible Chrome (the installed one when --chrome is given, so the real GPU
 * and driver are used) against an isolated staging server (scripts/perf-staging.mjs),
 * and records per scene, over a fixed window after a warm-up:
 *   frame times from requestAnimationFrame (p50, p95, p99, share over 33 ms, 1% low
 *   FPS), Cesium renders (postRender), renderer, GPU and browser CPU time
 *   (SystemInfo.getProcessInfo), main-thread task, script, layout and style time, JS
 *   heap, DOM nodes, event listeners, network requests by kind, render-governor mode
 *   and holds, Autopilot marker rebuilds (PointPrimitiveCollection removeAll/add),
 *   DOM mutations in the AUTOPILOT body, Autopilot flights and the overview map's own
 *   update time when it is present.
 * It writes <out>/<label>.json and prints a table. The governor's pass/fail contract
 * stays with scripts/qa-perf.mjs; this script measures, it does not assert.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const URL = option('--url', 'http://127.0.0.1:4179').replace(/\/$/, '');
const OUT = path.resolve(option('--out', 'perf-results'));
const LABEL = option('--label', 'run');
const SECONDS = Number(option('--seconds', '60'));
const WIDTH = Number(option('--width', '1920'));
const HEIGHT = Number(option('--height', '1080'));
const SCENES = option('--scenes', 'idle,hold,flight,fast,airsea,hidden').split(',');
const CHROME = option('--chrome', null);
const PROFILE = args.includes('--profile');
const OVERVIEW = option('--overview', 'on');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// A freshly started Chrome now and then exits before puppeteer attaches; retry.
const CHROME_ARGS = [
  `--window-size=${WIDTH},${HEIGHT}`,
  '--window-position=0,0',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  // A visible window still counts as occluded behind others; keep rAF honest.
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];
let profileDir = null;

/**
 * From an elevated shell, Chrome on Windows relaunches itself un-elevated and the
 * first process exits 0, which puppeteer.launch reports as a failed launch (and a
 * plain child spawn often loses the relaunch). With --chrome, start it through
 * the shell with a debugging port and connect; without, puppeteer launches its own.
 */
function startChrome(chromeArgs) {
  if (process.platform !== 'win32') {
    spawn(CHROME, chromeArgs, { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  // PowerShell reads typographic single quotes as quotes too, and Start-Process
  // passes each element as it is, so one holding a space is wrapped in "...".
  const quote = (value) => {
    let text = String(value).replaceAll('\\', '/');
    if (/\s/.test(text)) text = `"${text}"`;
    return `'${text.replace(/['‘’‚‛]/g, '$&$&')}'`;
  };
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Start-Process -FilePath ${quote(CHROME)} -ArgumentList ${chromeArgs.map(quote).join(',')}`,
  ]);
}

async function launch() {
  for (let attempt = 1; ; attempt += 1) {
    // Only plain characters in the folder name: it is matched with PowerShell -like.
    const safeLabel = LABEL.replace(/[^\w.-]/g, '_');
    profileDir = path.join(OUT, `profile-${safeLabel}-${Date.now()}-${attempt}`);
    try {
      if (!CHROME) {
        return await puppeteer.launch({ headless: false, userDataDir: profileDir, defaultViewport: null, args: CHROME_ARGS });
      }
      const port = 9300 + Math.floor(Math.random() * 600);
      startChrome([`--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, ...CHROME_ARGS, 'about:blank']);
      for (let i = 0; i < 40; i += 1) {
        await sleep(500);
        const browser = await puppeteer
          .connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null, protocolTimeout: 180_000 })
          .catch(() => null);
        if (browser) return browser;
      }
      throw new Error(`Chrome did not open port ${port}`);
    } catch (error) {
      killProfile();
      if (attempt >= 3) throw error;
      await sleep(3000);
    }
  }
}

/** Ends every Chrome process using this run's profile, whoever started it. */
function killProfile() {
  if (!profileDir || process.platform !== 'win32') return;
  const needle = path.basename(profileDir).replace(/'/g, "''");
  spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ]);
}

const browser = await launch();
const [page] = await browser.pages();
await page.setViewport({ width: WIDTH, height: HEIGHT });
const cdp = await page.createCDPSession();
const browserCdp = await browser.target().createCDPSession();
await cdp.send('Performance.enable');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
const requests = [];
page.on('request', (r) => requests.push({ at: Date.now(), url: r.url(), type: r.resourceType() }));

await page.evaluateOnNewDocument((overview) => {
  sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
  // The world overview's own switch: '0' hides the map, as the person can.
  localStorage.setItem('gev.worldOverview.open', overview === 'off' ? '0' : '1');
  const rec = (window.__perf = { frames: [], recording: false });
  const loop = (t) => {
    if (rec.recording) rec.frames.push(t);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}, OVERVIEW);
await page.goto(`${URL}/`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
await page.waitForFunction(
  () => window.__gevIntel?.snapshot?.().enabled === true && window.__godsEyeView?.viewer,
  { timeout: 240_000 },
);
await sleep(8000);

// Counters inside the page: renders, marker rebuilds, AUTOPILOT DOM churn.
const environment = await page.evaluate(() => {
  const viewer = window.__godsEyeView.viewer;
  const counters = (window.__perfCounters = {
    renders: 0,
    removeAll: 0,
    adds: 0,
    mutations: 0,
    flights: 0,
    overviewUpdates: 0,
    overviewMs: [],
  });
  viewer.scene.postRender.addEventListener(() => (counters.renders += 1));
  const collections = viewer.scene.primitives._primitives ?? [];
  for (const c of collections) {
    if (typeof c.removeAll !== 'function' || typeof c.add !== 'function') continue;
    if (!c.constructor?.name?.includes('PointPrimitiveCollection')) continue;
    const removeAll = c.removeAll.bind(c);
    const add = c.add.bind(c);
    c.removeAll = (...a) => {
      counters.removeAll += 1;
      return removeAll(...a);
    };
    c.add = (...a) => {
      counters.adds += 1;
      return add(...a);
    };
  }
  const body = document.getElementById('intel-panel-body');
  if (body)
    new MutationObserver((list) => (counters.mutations += list.length)).observe(body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
  let lastKey = null;
  setInterval(() => {
    const key = window.__gevIntel.snapshot().current?.key ?? null;
    if (key && key !== lastKey) counters.flights += 1;
    lastKey = key;
  }, 250);
  const gl = viewer.scene.context?._gl;
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    userAgent: navigator.userAgent,
    devicePixelRatio: window.devicePixelRatio,
    viewport: `${innerWidth}x${innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    webgl: gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : null,
    webgl2: typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext,
    pointCollectionsWrapped: collections.filter((c) => c.constructor?.name?.includes('PointPrimitiveCollection')).length,
  };
});
environment.browserVersion = await browser.version();

const metrics = async () => {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
};
const processCpu = async () => {
  try {
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const out = {};
    for (const p of processInfo) out[p.type] = (out[p.type] ?? 0) + p.cpuTime;
    return out;
  } catch {
    return {};
  }
};
/** Whole-machine CPU busy share between two os.cpus() readings. */
const machineTimes = () =>
  os.cpus().reduce(
    (acc, c) => {
      const t = c.times;
      acc.busy += t.user + t.nice + t.sys + t.irq;
      acc.all += t.user + t.nice + t.sys + t.irq + t.idle;
      return acc;
    },
    { busy: 0, all: 0 },
  );
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? null;
const round = (v, d = 1) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

async function measure(name, seconds = SECONDS) {
  const m0 = await metrics();
  const c0 = await processCpu();
  const os0 = machineTimes();
  const k0 = await page.evaluate(() => ({ ...window.__perfCounters, overviewMs: undefined }));
  const t0 = Date.now();
  await page.evaluate(() => {
    window.__perf.frames = [];
    window.__perf.recording = true;
    window.__perfCounters.overviewMs = [];
  });
  if (PROFILE) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  await sleep(seconds * 1000);
  let hot = null;
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const total = profile.samples.length || 1;
    const counts = new Map();
    for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const node of profile.nodes) {
      const f = node.callFrame;
      const where = `${f.functionName || '(anonymous)'} ${f.url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')}:${f.lineNumber + 1}`;
      self.set(where, (self.get(where) ?? 0) + (counts.get(node.id) ?? 0));
    }
    hot = [...self.entries()]
      .filter(([name]) => !/^\((idle|program|garbage collector|root)\)/.test(name))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, n]) => [name, round((n / total) * 100)]);
    fs.writeFileSync(path.join(OUT, `${LABEL}-${name}.cpuprofile`), JSON.stringify(profile));
  }
  const frames = await page.evaluate(() => {
    window.__perf.recording = false;
    return window.__perf.frames;
  });
  const t1 = Date.now();
  const m1 = await metrics();
  const c1 = await processCpu();
  const os1 = machineTimes();
  const k1 = await page.evaluate(() => window.__perfCounters);
  const gov = await page.evaluate(() => (window.__gevRenderGovernor?.getDiagnostics?.() ?? window.__godsEyeView?.getRenderGovernorDiagnostics?.() ?? null));
  const snap = await page.evaluate(() => window.__gevIntel.snapshot());
  const intervals = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const wall = (t1 - t0) / 1000;
  const window_ = requests.filter((r) => r.at >= t0 && r.at <= t1);
  const kinds = {};
  for (const r of window_) {
    const kind = /\/api\/intel/.test(r.url)
      ? 'intel-api'
      : /\/api\//.test(r.url)
        ? 'other-api'
        : /tile|imagery|\.(png|jpe?g|webp|terrain|pbf|b3dm|glb)(\?|$)/i.test(r.url)
          ? 'tiles'
          : r.type;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  const d = (key) => (m1[key] ?? 0) - (m0[key] ?? 0);
  const cpu = (type) => round(((c1[type] ?? 0) - (c0[type] ?? 0)) / wall * 100);
  const overview = [...(k1.overviewMs ?? [])].sort((a, b) => a - b);
  const result = {
    scene: name,
    seconds: round(wall),
    frames: frames.length,
    fps: round(frames.length / wall),
    frameP50: round(quantile(intervals, 0.5)),
    frameP95: round(quantile(intervals, 0.95)),
    frameP99: round(quantile(intervals, 0.99)),
    longFramePct: round((intervals.filter((v) => v > 33.4).length / Math.max(1, intervals.length)) * 100),
    low1Fps: intervals.length ? round(1000 / quantile(intervals, 0.99)) : null,
    renders: k1.renders - k0.renders,
    rendersPerS: round((k1.renders - k0.renders) / wall),
    cpuRendererPct: cpu('renderer'),
    cpuGpuPct: cpu('GPU'),
    cpuBrowserPct: cpu('browser'),
    machineCpuPct: round(((os1.busy - os0.busy) / Math.max(1, os1.all - os0.all)) * 100),
    taskMsPerS: round((d('TaskDuration') * 1000) / wall),
    scriptMsPerS: round((d('ScriptDuration') * 1000) / wall),
    layoutMsPerS: round(((d('LayoutDuration') + d('RecalcStyleDuration')) * 1000) / wall),
    heapMb: round((m1.JSHeapUsedSize ?? 0) / 1048576),
    heapDeltaMb: round(d('JSHeapUsedSize') / 1048576),
    domNodes: m1.Nodes,
    listeners: m1.JSEventListeners,
    markerRebuilds: k1.removeAll - k0.removeAll,
    markerAdds: k1.adds - k0.adds,
    panelMutations: k1.mutations - k0.mutations,
    flights: k1.flights - k0.flights,
    requests: window_.length,
    requestKinds: kinds,
    governorMode: gov?.mode ?? null,
    governorHolds: gov?.holds ?? null,
    autopilot: { mode: snap.mode, events: snap.events, markers: snap.markers ?? null },
    overviewUpdates: (k1.overviewUpdates ?? 0) - (k0.overviewUpdates ?? 0),
    overviewP95Ms: overview.length ? round(quantile(overview, 0.95), 3) : null,
    hot,
  };
  console.log(
    `${name.padEnd(10)} fps ${String(result.fps).padStart(5)} p50 ${String(result.frameP50).padStart(5)} p95 ${String(result.frameP95).padStart(6)} renders/s ${String(result.rendersPerS).padStart(5)} rend% ${String(result.cpuRendererPct).padStart(5)} gpu% ${String(result.cpuGpuPct).padStart(5)} script ${String(result.scriptMsPerS).padStart(6)}ms/s machine ${result.machineCpuPct}% heap ${result.heapMb}MB rebuilds ${result.markerRebuilds} req ${result.requests}`,
  );
  return result;
}

const setAutopilot = (mode) =>
  page.evaluate(async (want) => {
    const intel = window.__gevIntel;
    for (let i = 0; i < 4 && intel.snapshot().mode !== want; i += 1) {
      intel.toggleAutopilot();
      await new Promise((r) => setTimeout(r, 400));
    }
    return intel.snapshot().mode;
  }, mode);
const setLayers = (ids, on) =>
  page.evaluate(
    async (list, enabled) => {
      const dm = window.__godsEyeView.dataManager;
      for (const id of list) await dm.setEnabled?.(id, enabled);
    },
    ids,
    on,
  );
const enabledLayers = () =>
  page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    return [...(dm.layers?.entries?.() ?? [])].filter(([, l]) => l.enabled).map(([id]) => id);
  });
const putSettings = (body) =>
  fetch(`${URL}/api/intel/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.status);
const railClick = (name) =>
  page.evaluate((label) => {
    const item = [...document.querySelectorAll('.gev-panel-rail button')].find(
      (b) => b.getAttribute('aria-label') === label,
    );
    item?.click();
    return Boolean(item);
  }, name);
const parkCamera = () =>
  page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.camera.setView({
      destination: viewer.camera.position.constructor.fromDegrees(10, 30, 15_000_000),
    });
  });

const results = [];
const save = (extra = {}) =>
  fs.writeFileSync(
    path.join(OUT, `${LABEL}.json`),
    JSON.stringify({ label: LABEL, at: new Date().toISOString(), environment, results, pageErrors: errors, ...extra }, null, 1),
  );
// A page that stops answering (a frozen tab, a CDP call that never returns) would
// otherwise hold the run for hours: keep what was measured, then leave.
const budgetMs = 120_000 + SCENES.length * (SECONDS * 2_000 + 90_000);
setTimeout(() => {
  console.log(`watchdog: no finish within ${Math.round(budgetMs / 1000)} s; saving ${results.length} scenes`);
  try { save({ timedOut: true }); } catch {}
  killProfile();
  process.exit(2);
}, budgetMs).unref();
const settingsBefore = await fetch(`${URL}/api/intel/settings`).then((r) => r.json());
try {
  const initialLayers = await enabledLayers();
  if (SCENES.includes('idle')) {
    await setAutopilot('off');
    await setLayers(initialLayers, false);
    await parkCamera();
    await sleep(20_000);
    results.push(await measure('idle'));
    await setLayers(initialLayers, true);
  }
  if (SCENES.includes('hold')) {
    // Autopilot holding one shot: dwell longer than the window.
    await putSettings({ minimumDwellMs: 600_000, tourWhenIdle: false, localAiEnabled: false });
    await setAutopilot('auto');
    await sleep(25_000);
    results.push(await measure('hold'));
  }
  if (SCENES.includes('flight')) {
    // Short dwell, the tour on and the zoom-out on: as many flights as the rules allow.
    await putSettings({ minimumDwellMs: 15_000, tourWhenIdle: true, tourDwellMs: 15_000 });
    await setAutopilot('off');
    await setAutopilot('auto');
    await sleep(10_000);
    results.push(await measure('flight', Math.max(SECONDS, 120)));
  }
  if (SCENES.includes('fast')) {
    await putSettings({ minimumDwellMs: 600_000 });
    await railClick('FAST INTELLIGENCE');
    await sleep(800);
    // Report arrivals: new synthetic posts in each events response, inside this browser.
    await page.setRequestInterception(true);
    let n = 0;
    page.on('request', async (request) => {
      if (!request.isInterceptResolutionHandled?.() && new globalThis.URL(request.url()).pathname === '/api/intel/events') {
        try {
          const answer = await fetch(request.url());
          const body = await answer.json();
          const template = body.events[0] ?? {};
          n += 1;
          const reports = Array.from({ length: Math.min(n, 30) }, (_, i) => ({
            ...template,
            event_id: `evt_perf_${i}`,
            title: `PERF SYNTHETIC report ${i}`,
            providers: ['bluesky'],
            lineages: [{ key: `p${i}`, source_type: 'social_claim', publisher: 'perf.example' }],
            fast_status: 'provisional',
            camera_eligible: false,
            posts_held_from_camera: true,
            first_seen_at: Date.now() - i * 20_000,
            last_meaningful_update_at: Date.now() - i * 20_000,
            location: { lat: 10 + i, lon: 20 + i * 3, precision: 'city', place: `Place ${i}` },
          }));
          body.events = [...reports, ...body.events];
          await request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        } catch {
          await request.continue().catch(() => {});
        }
      } else if (!request.isInterceptResolutionHandled?.()) await request.continue().catch(() => {});
    });
    await sleep(15_000);
    results.push(await measure('fast'));
    await page.setRequestInterception(false);
    await railClick('FAST INTELLIGENCE');
  }
  if (SCENES.includes('airsea')) {
    await setAutopilot('off');
    await page.evaluate(() => {
      for (const id of ['air-traffic', 'sea-traffic'])
        localStorage.setItem(`gev.airsea.${id}.window.density`, '24h');
    });
    await setLayers(['air-traffic', 'sea-traffic'], true);
    await sleep(25_000);
    results.push(await measure('airsea'));
    await setLayers(['air-traffic', 'sea-traffic'], false);
  }
  if (SCENES.includes('hidden')) {
    await setAutopilot('auto');
    const other = await browser.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await sleep(5000);
    const hidden = await measure('hidden');
    hidden.documentHidden = await page.evaluate(() => document.hidden);
    results.push(hidden);
    await page.bringToFront();
    const t = Date.now();
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const recovery = await measure('foreground', 30);
    recovery.firstFrameMs = Date.now() - t;
    results.push(recovery);
    await other.close();
  }
} finally {
  await putSettings({
    minimumDwellMs: settingsBefore.minimumDwellMs,
    tourWhenIdle: settingsBefore.tourWhenIdle,
    tourDwellMs: settingsBefore.tourDwellMs,
    localAiEnabled: settingsBefore.localAiEnabled,
  }).catch(() => {});
  save();
  // close() can wait forever on a renderer that will not exit.
  await Promise.race([browser.close().catch(() => {}), sleep(10_000)]);
  killProfile();
}
console.log(JSON.stringify(environment));
console.log(`page errors: ${errors.length}`);
process.exit(0);
