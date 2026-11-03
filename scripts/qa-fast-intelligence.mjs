#!/usr/bin/env node
/**
 * Browser gate for the fork's panels on the Vue panel rail: FAST INTELLIGENCE,
 * FEEDS and AUTOPILOT.
 *
 * Needs a dev server with GEV_INTEL_ENABLED=1 and GEV_FAST_FEEDS=1:
 *
 *   node scripts/qa-fast-intelligence.mjs --url http://127.0.0.1:4179
 *
 * One synthetic Bluesky report is added to the event list inside the browser, so
 * nothing reaches the server and no real account is involved. Real clicks prove:
 *   - each panel has a rail icon; FEEDS and FAST INTELLIGENCE stay open together
 *     and it takes the height FEEDS leaves; any other panel closes both;
 *   - the report is listed and drawn as a marker;
 *   - the panel's chips change what the map draws, and the choice survives a reload;
 *   - opening the report shows its timeline and flies there on request;
 *   - Autopilot never goes to it by itself;
 *   - a panel that is down reads as down, and the panel follows the language.
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option('--url', 'http://127.0.0.1:4179').replace(/\/$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SOCIAL_ID = 'evt_qa_fast_social';
const socialEvent = (now, template) => ({
  ...template,
  event_id: SOCIAL_ID,
  title: 'QA SYNTHETIC: first report of an explosion near the harbour',
  category: 'armed_conflict',
  subtype: 'explosion',
  providers: ['bluesky'],
  lineages: [
    { key: 'qa', source_type: 'social_claim', publisher: 'qa.example' },
  ],
  official: false,
  official_feed: false,
  fast_status: 'provisional',
  verification: 'unverified',
  confidence: 0.25,
  attention_score: 88,
  lifecycle: 'active',
  camera_eligible: false,
  critical_qualified: false,
  posts_held_from_camera: true,
  first_seen_at: now - 60_000,
  first_published_at: now - 90_000,
  last_meaningful_update_at: now - 60_000,
  location: {
    lat: 46.48,
    lon: 30.73,
    precision: 'city',
    place: 'Odesa',
    geolocation_status: 'needs_verification',
  },
  explanation: { ...template.explanation, independent_sources: 1 },
});

const timeline = {
  event_time_known: false,
  first_detected_at: Date.now() - 60_000,
  first_displayed_at: Date.now() - 55_000,
  location: { place: 'Odesa' },
  evidence: [
    {
      excerpt: 'QA SYNTHETIC post text',
      url: 'https://bsky.app/profile/qa.example/post/1',
      attribution: 'qa.example',
    },
  ],
};

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
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

let failures = 0;
const record = (name, passed, detail = '') => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? `: ${detail}` : ''}`);
  if (!passed) failures += 1;
};
const errors = [];

async function openPage(query = '') {
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(String(error).slice(0, 300)));
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    try {
      if (url.pathname === '/api/intel/events') {
        const answer = await fetch(request.url());
        const body = await answer.json();
        const template = body.events[0] ?? {};
        body.events = [socialEvent(Date.now(), template), ...body.events];
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      } else if (url.pathname === `/api/intel/fast/events/${SOCIAL_ID}`) {
        await request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(timeline),
        });
      } else await request.continue();
    } catch {
      /* the page went away mid-request */
    }
  });
  await page.goto(`${APP_URL}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__gevIntel?.snapshot().enabled &&
      window.__godsEyeView?.viewer &&
      window.__gevIntel.snapshot().events > 0,
    { timeout: 180_000 },
  );
  await sleep(2500);
  return page;
}

/** Clicks the rail item for a panel, by its visible name. */
const railClick = (page, name) =>
  page.evaluate((label) => {
    const item = [...document.querySelectorAll('.gev-panel-rail button')].find(
      (button) =>
        [button.getAttribute('aria-label'), button.title, button.textContent]
          .filter(Boolean)
          .some((text) => text.trim() === label),
    );
    item?.click();
    return Boolean(item);
  }, name);

/** How the left lane is shared: each panel's box, and the lane's own limits. */
const lane = (page) =>
  page.evaluate(() => {
    const box = (id) => {
      const rect = document.getElementById(id).getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    const stack = document.getElementById('left-panel-stack');
    return {
      viewport: innerHeight,
      safeTop: (Number(stack.dataset.safeTopPct) / 100) * innerHeight,
      safeBottom: (Number(stack.dataset.safeBottomPct) / 100) * innerHeight,
      mode: stack.dataset.layoutMode,
      feeds: box('intel-feeds-panel'),
      fast: box('fast-intel-panel'),
      feedsBody: document.getElementById('intel-feeds-body').scrollHeight,
    };
  });

const isOpen = (page, id) =>
  page.evaluate((panelId) => {
    const panel = document.getElementById(panelId);
    return Boolean(panel) && !panel.hidden && !panel.classList.contains('collapsed');
  }, id);

const chip = (page, text) =>
  page.evaluate((label) => {
    const button = [
      ...document.querySelectorAll('#fast-intel-body .data-toggle-chip'),
    ].find((item) => item.textContent.trim() === label);
    button?.click();
    return Boolean(button);
  }, text);

const snap = (page) => page.evaluate(() => window.__gevIntel.snapshot());

try {
  const page = await openPage();

  for (const name of ['FAST INTELLIGENCE', 'FEEDS', 'AUTOPILOT'])
    record(`${name} is on the panel rail`, await railClick(page, name));

  await railClick(page, 'FEEDS');
  await sleep(600);
  if (!(await isOpen(page, 'intel-feeds-panel')))
    await railClick(page, 'FEEDS');
  await sleep(600);
  record('FEEDS opens', await isOpen(page, 'intel-feeds-panel'));
  const feedRows = await page.evaluate(
    () => document.querySelectorAll('#intel-feeds-body li, #intel-feeds-body tr, #intel-feeds-body div').length,
  );
  record('FEEDS lists the feeds', feedRows > 3, `${feedRows} rows`);

  await railClick(page, 'FAST INTELLIGENCE');
  await sleep(600);
  if (!(await isOpen(page, 'fast-intel-panel')))
    await railClick(page, 'FAST INTELLIGENCE');
  await sleep(600);
  record('FAST INTELLIGENCE opens', await isOpen(page, 'fast-intel-panel'));
  record(
    'FEEDS stays open beside it',
    await isOpen(page, 'intel-feeds-panel'),
  );
  const pressed = await page.evaluate(
    () =>
      [...document.querySelectorAll('.gev-panel-rail [aria-pressed="true"]')].length,
  );
  record('both rail icons read as open', pressed === 2, `${pressed} pressed`);
  const shared = await lane(page);
  record(
    'FAST INTELLIGENCE runs down to the end of the lane',
    Math.abs(shared.fast.bottom - shared.safeBottom) <= 12,
    `bottom ${Math.round(shared.fast.bottom)} of ${Math.round(shared.safeBottom)}, mode ${shared.mode}`,
  );
  record(
    'FEEDS sits above it and they do not overlap',
    shared.feeds.bottom <= shared.fast.top + 1,
    `feeds ${Math.round(shared.feeds.top)} to ${Math.round(shared.feeds.bottom)}, fast ${Math.round(shared.fast.top)} to ${Math.round(shared.fast.bottom)}`,
  );

  await railClick(page, 'FEEDS');
  await sleep(800);
  record('FEEDS can close alone', !(await isOpen(page, 'intel-feeds-panel')));
  record('FAST INTELLIGENCE stays open', await isOpen(page, 'fast-intel-panel'));
  const alone = await lane(page);
  record(
    'alone it takes the whole lane',
    alone.fast.height > shared.fast.height + 40 &&
      Math.abs(alone.fast.bottom - alone.safeBottom) <= 12,
    `${Math.round(alone.fast.height)} high, was ${Math.round(shared.fast.height)}`,
  );

  await railClick(page, 'DATA LAYERS');
  await sleep(800);
  record('another panel closes it', !(await isOpen(page, 'fast-intel-panel')));
  await railClick(page, 'FEEDS');
  await sleep(600);
  await railClick(page, 'FAST INTELLIGENCE');
  await sleep(800);
  record(
    'opening both again closes the other panel',
    !(await isOpen(page, 'data-panel')) &&
      (await isOpen(page, 'intel-feeds-panel')) &&
      (await isOpen(page, 'fast-intel-panel')),
  );
  await railClick(page, 'DATA LAYERS');
  await sleep(800);
  record(
    'and another panel closes both',
    !(await isOpen(page, 'intel-feeds-panel')) &&
      !(await isOpen(page, 'fast-intel-panel')),
  );
  await railClick(page, 'FAST INTELLIGENCE');
  await sleep(800);

  await page.waitForFunction(
    () => /QA SYNTHETIC/.test(document.getElementById('fast-intel-body')?.textContent ?? ''),
    { timeout: 30_000 },
  );
  record('the report is listed', true);
  const body = await page.$eval('#fast-intel-body', (node) => node.textContent);
  record(
    'the panel says what an empty map means',
    /No pin does not mean|NO LIVE PUSH SOURCE/.test(body),
  );
  const count = await page.$eval('#fast-intel-count', (node) => node.textContent);
  record('the count shows sources up', /\d+\/\d+ up/.test(count), count);

  const shown = await snap(page);
  record('the report is drawn on the map', shown.markers > 0, `${shown.markers} markers, ${shown.events} events`);

  record('the ON MAP chip exists', await chip(page, 'ON MAP'));
  await sleep(1000);
  const hidden = await snap(page);
  record(
    'hiding takes the report off the map and nothing else',
    hidden.events === shown.events - 1,
    `${shown.events} to ${hidden.events} events, ${shown.markers} to ${hidden.markers} markers`,
  );
  record('it can be turned back on', await chip(page, 'HIDDEN'));
  await sleep(1000);
  record('showing brings it back', (await snap(page)).events === shown.events);

  await chip(page, 'CONFLICT');
  await sleep(1000);
  record('a topic chip filters it', (await snap(page)).events === shown.events - 1);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__gevIntel?.snapshot().enabled && window.__gevIntel.snapshot().events > 0,
    { timeout: 180_000 },
  );
  await sleep(2500);
  const stored = await page.evaluate(() => localStorage.getItem('gev.fastintel.view'));
  record('the filter survives a reload', JSON.parse(stored).categories.armed_conflict === false);
  await railClick(page, 'FAST INTELLIGENCE');
  await sleep(600);
  if (!(await isOpen(page, 'fast-intel-panel')))
    await railClick(page, 'FAST INTELLIGENCE');
  await sleep(600);
  await chip(page, 'CONFLICT');
  await sleep(1000);

  // Autopilot on: it must never pick the report by itself.
  await page.evaluate(() => {
    if (window.__gevIntel.snapshot().mode === 'off') window.__gevIntel.toggleAutopilot();
  });
  await sleep(4000);
  let wentThere = false;
  for (let i = 0; i < 12; i += 1) {
    const state = await snap(page);
    if (state.current?.eventIds?.includes(SOCIAL_ID)) wentThere = true;
    await sleep(2000);
  }
  record('Autopilot never goes to the report', !wentThere);
  record('Autopilot is still on', (await snap(page)).mode === 'auto');

  const before = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera.positionCartographic;
    return { lat: c.latitude, lon: c.longitude };
  });
  await page.$eval('#fast-intel-body .fast-row-button', (button) => button.click());
  await page.waitForFunction(
    () => /QA SYNTHETIC post text/.test(document.querySelector('.fast-timeline')?.textContent ?? ''),
    { timeout: 15_000 },
  );
  record('opening the report shows its timeline', true);
  const link = await page.$eval('.fast-timeline a', (node) => node.getAttribute('rel'));
  record('the source link is safe', link === 'noopener noreferrer');
  await sleep(6000);
  const after = await page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera.positionCartographic;
    return { lat: c.latitude, lon: c.longitude };
  });
  record(
    'an operator can still fly to it',
    Math.abs(after.lat - before.lat) + Math.abs(after.lon - before.lon) > 1e-4,
  );
  const selected = await snap(page);
  record('that pauses Autopilot', selected.mode !== 'auto', selected.pauseReason ?? selected.mode);

  await railClick(page, 'AUTOPILOT');
  await sleep(600);
  if (!(await isOpen(page, 'intel-panel'))) await railClick(page, 'AUTOPILOT');
  await sleep(600);
  record('AUTOPILOT opens', await isOpen(page, 'intel-panel'));
  record('RESUME is offered', await page.$eval('.intel-resume-btn', (node) => !node.hidden));
  await page.close();

  const arabic = await openPage('?lang=ar');
  const title = await arabic.$eval(
    '#fast-intel-panel .panel-title',
    (node) => node.textContent.trim(),
  );
  record('the panel follows the language', title === 'الاستخبارات السريعة', title);
  await arabic.close();

  record('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  record('the run finished', false, String(error).slice(0, 300));
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
