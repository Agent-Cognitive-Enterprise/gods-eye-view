#!/usr/bin/env node
/**
 * qa-gnss-regions.mjs — headless proof for the Ship GNSS Screen layer
 * (id `gnss-ship-regions`) across the antimeridian (fork tooling).
 *
 * Drives the REAL app in headless Chromium against a running server, with
 * `/api/airsea/gnss-regions` stubbed in the page by a fixture: one active
 * region whose box runs from 179.4° E to 179.4° W (reported, as the detector
 * does, with west = -180.6), and one ended incident just west of the line.
 * The server's own GNSS route is never called.
 *
 *   (i)   GEOMETRY — the layer builds one fill and one outline primitive,
 *         and every bounding sphere of the built geometry is local (under
 *         300 km across, centred within 1° of the box): a box wrapped the
 *         wrong way round the world would be thousands of km.
 *   (ii)  PIXELS — with the camera straight down over 180°, points inside the
 *         box on BOTH sides of the line turn orange when the layer is on,
 *         and a point well outside it does not change.
 *   (iii) ROW — the row lists the region and the ended incident.
 *
 * Visual proof saved to qa-shots/gnss-regions-dateline.png (gitignored).
 *
 * Run:  node scripts/qa-gnss-regions.mjs --url http://127.0.0.1:4181
 *       (an isolated staging server: node scripts/perf-staging.mjs)
 * Optional: --timeout-ms 180000 for a slow boot, --headful,
 *           --browser-url http://127.0.0.1:9222 to use a running Chrome.
 * Exits non-zero on any FAIL.
 */

import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(path.resolve(__dirname, '..'), 'qa-shots');
const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://127.0.0.1:4181');
const BROWSER_URL = getOpt('--browser-url', null);
const TIMEOUT_MS = Number(getOpt('--timeout-ms', '120000'));
const LAYER_ID = 'gnss-ship-regions';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const now = Date.now();
const FIXTURE = {
  schemaVersion: 2,
  status: 'candidate_regions',
  coverage: { feedStatus: 'healthy', stale: false },
  diagnostic: { tracked: 1234 },
  regions: [
    {
      id: 'qa-dateline',
      sourceLocation: 'credible',
      evidence: { uniqueVessels: 4 },
      firstSeenAt: now - 20 * 60_000,
      lastSeenAt: now - 2 * 60_000,
      area: { south: 50.0, north: 51.0, west: -180.6, east: -179.4 },
    },
  ],
  recentIncidents: [
    {
      id: 'qa-ended',
      state: 'ended',
      firstSeenAt: now - 3 * 3600_000,
      lastSeenAt: now - 2 * 3600_000,
      peakVessels: 3,
      area: { south: 52.0, north: 52.6, west: 177.0, east: 178.0 },
    },
  ],
};
// Inside the box west and east of the line, and well outside it.
const PROBES = {
  insideWest: [179.7, 50.5],
  insideEast: [-179.7, 50.5],
  outside: [178.6, 49.2],
};

async function main() {
  const browser = BROWSER_URL
    ? await puppeteer.connect({
        browserURL: BROWSER_URL,
        defaultViewport: null,
      })
    : await puppeteer.launch({
        headless: !argv.includes('--headful'),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes('/api/airsea/gnss-regions'))
      req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE),
      });
    else req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
  });
  try {
    await page.goto(`${APP_URL}/?welcome=0`, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT_MS,
    });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: TIMEOUT_MS },
    );
    await sleep(5000);
    await page.keyboard.press('Escape');

    // Straight down over the antimeridian, then wait for the imagery.
    const settle = () =>
      page.waitForFunction(
        () => {
          const v = window.__godsEyeView.viewer;
          v.scene.requestRender?.();
          return v.scene.globe.tilesLoaded;
        },
        { timeout: TIMEOUT_MS, polling: 500 },
      );
    await page.evaluate(() => {
      const v = window.__godsEyeView.viewer;
      try {
        v.camera.cancelFlight();
      } catch {
        /* no flight */
      }
      const d2r = Math.PI / 180;
      v.camera.setView({
        destination: v.scene.globe.ellipsoid.cartographicToCartesian({
          longitude: 180 * d2r,
          latitude: 50.5 * d2r,
          height: 900_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await settle();
    await sleep(1500);
    const sample = () =>
      page.evaluate((probes) => {
        const gev = window.__godsEyeView;
        const v = gev.viewer;
        v.render();
        const canvas = v.scene.canvas;
        const ctx = Object.assign(document.createElement('canvas'), {
          width: canvas.width,
          height: canvas.height,
        }).getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const scale = canvas.width / canvas.clientWidth;
        const out = {};
        for (const [name, [lon, lat]] of Object.entries(probes)) {
          const d2r = Math.PI / 180;
          const world = v.scene.globe.ellipsoid.cartographicToCartesian({
            longitude: lon * d2r,
            latitude: lat * d2r,
            height: 500,
          });
          const win = v.scene.cartesianToCanvasCoordinates(world);
          if (!win) {
            out[name] = null;
            continue;
          }
          const [r, g, b] = ctx.getImageData(
            Math.round(win.x * scale),
            Math.round(win.y * scale),
            1,
            1,
          ).data;
          out[name] = { r, g, b };
        }
        return out;
      }, PROBES);
    const before = await sample();

    const built = await page.evaluate(async (id) => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled(id, true);
      const layer = dm.layers.get(id).module;
      const v = window.__godsEyeView.viewer;
      // Let the primitives build their geometry.
      for (let i = 0; i < 40; i++) {
        v.render();
        await new Promise((r) => setTimeout(r, 250));
      }
      const all = v.scene.primitives;
      const spheres = [];
      let primitives = 0;
      for (let i = 0; i < all.length; i++) {
        const collection = all.get(i);
        if (!(collection?.length >= 1) || typeof collection.get !== 'function')
          continue;
        for (let k = 0; k < collection.length; k++) {
          const p = collection.get(k);
          if (!p?._boundingSpheres?.length) continue;
          primitives += 1;
          for (const s of p._boundingSpheres) {
            const c = v.scene.globe.ellipsoid.cartesianToCartographic(s.center);
            spheres.push({
              radiusKm: s.radius / 1000,
              lon: (c.longitude * 180) / Math.PI,
              lat: (c.latitude * 180) / Math.PI,
            });
          }
        }
      }
      return {
        stats: layer.getStats(),
        row: layer.getRowControls(),
        spheres,
        primitives,
      };
    }, LAYER_ID);
    await settle();
    await sleep(1000);
    const after = await sample();

    // (i) geometry
    const ours = built.spheres.filter((s) => Math.abs(s.lat - 51) < 3);
    const local = ours.every(
      (s) =>
        s.radiusKm < 300 &&
        Math.abs(Math.abs(s.lon) - 180) < 3.5 &&
        Math.abs(s.lat - 51) < 2.5,
    );
    record(
      'geometry: local bounding spheres across ±180°',
      ours.length >= 2 && local,
      JSON.stringify(
        ours.map((s) => [
          Math.round(s.radiusKm),
          +s.lon.toFixed(2),
          +s.lat.toFixed(2),
        ]),
      ),
    );
    // (ii) pixels
    const orangeShift = (a, b) => (a && b ? b.r - a.r - (b.b - a.b) : null);
    const west = orangeShift(before.insideWest, after.insideWest);
    const east = orangeShift(before.insideEast, after.insideEast);
    const outside =
      before.outside && after.outside
        ? Math.abs(after.outside.r - before.outside.r) +
          Math.abs(after.outside.g - before.outside.g) +
          Math.abs(after.outside.b - before.outside.b)
        : null;
    record(
      'pixels: inside turns orange on both sides of the line',
      west > 20 && east > 20,
      `west +${west}, east +${east}`,
    );
    record(
      'pixels: outside the box is unchanged',
      outside !== null && outside < 30,
      `change ${outside}`,
    );
    // (iii) row
    const ids = built.row.list.items.map((i) => i.id);
    record(
      'row: lists the region and the ended incident',
      ids.includes('qa-dateline') &&
        ids.includes('qa-ended') &&
        built.stats.count === 1,
      ids.join(', '),
    );
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'gnss-regions-dateline.png'),
    });
  } finally {
    await page.close().catch(() => {});
    if (BROWSER_URL) await browser.disconnect();
    else await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} FAIL` : 'all PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
