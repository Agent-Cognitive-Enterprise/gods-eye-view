import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessor } from './assessor.js';
import { createLocalLlm, loopbackBaseUrl } from './localLlm.js';
import { createIntelService } from './service.js';

const T0 = Date.parse('2026-10-29T00:00:00Z');
const BASE = 'http://127.0.0.1:5001/v1';

const unrest = {
  provider: 'fixture',
  source_item_id: 'a',
  publisher: 'Wire',
  source_type: 'eyewitness',
  url: 'https://wire.example/a',
  category: 'civil_unrest',
  title: 'Crowds rally at parliament over fuel prices',
  summary: 'Protest grows outside parliament.',
  published_at: T0,
  location: { lat: 44.8, lon: 20.4, precision: 'city' },
  entities: ['parliament'],
  metrics: { severity_hint: 70, affected: 30000 },
};

const goodReply = JSON.stringify({
  category: 'civil_unrest',
  severity: 72,
  escalation: 'increasing',
  confidence: 0.55,
  material_update: false,
  summary: 'An eyewitness source reports a growing protest; unconfirmed.',
  title_en: 'Protest grows at parliament',
  title_ru: 'Протест у парламента растёт',
  evidence_ids: ['e1'],
  uncertainties: [],
});

/** A fake KoboldCpp. `chat` decides each completion; every URL is recorded. */
function fakeServer({
  chat = () => goodReply,
  perf = { queue: 0, idle: 1 },
} = {}) {
  const urls = [];
  let completions = 0;
  const json = (value) => new Response(JSON.stringify(value), { status: 200 });
  const fetchImpl = async (url, init = {}) => {
    urls.push(String(url));
    if (url.endsWith('/v1/models'))
      return json({
        data: [{ id: 'koboldcpp/Qwen-test', status: { value: 'loaded' } }],
      });
    if (url.endsWith('/api/extra/version'))
      return json({ result: 'KoboldCpp', version: '1.119' });
    if (url.endsWith('/api/extra/perf')) return json(perf);
    if (url.endsWith('/chat/completions')) {
      completions += 1;
      const content = await chat(init, completions);
      return json({
        choices: [{ message: { content } }],
        usage: { total_tokens: 10 },
      });
    }
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, urls, completions: () => completions };
}

function serviceWith(server, options = {}) {
  const llm = createLocalLlm({
    baseUrl: BASE,
    fetchImpl: server.fetchImpl,
    now: () => T0,
    ...options,
  });
  const service = createIntelService({ now: () => T0, llm, log: () => {} });
  service.engine.ingest([unrest], { receivedAt: T0 });
  return service;
}

test('only loopback base URLs are accepted (no SSRF, no cloud)', () => {
  assert.equal(
    loopbackBaseUrl('http://127.0.0.1:8790/v1/'),
    'http://127.0.0.1:8790/v1',
  );
  assert.equal(
    loopbackBaseUrl('http://localhost:5001/v1'),
    'http://localhost:5001/v1',
  );
  assert.equal(loopbackBaseUrl('http://[::1]:5001/v1'), 'http://[::1]:5001/v1');
  for (const bad of [
    'http://192.168.0.5:5001/v1',
    'https://api.openai.com/v1',
    'http://127.0.0.1.evil.example/v1',
    'http://user:pass@127.0.0.1/v1',
    'file:///etc/passwd',
    'http://127.0.0.1:5001/v1?x=1',
  ])
    assert.equal(loopbackBaseUrl(bad), null, bad);
  const llm = createLocalLlm({
    baseUrl: 'https://api.openai.com/v1',
    fetchImpl: () => assert.fail('fetched'),
  });
  assert.equal(llm.status().status, 'refused_non_loopback');
});

test('a valid assessment is applied, bounded, and only loopback is contacted', async () => {
  const server = fakeServer();
  const service = serviceWith(server);
  const before = service.engine.activeEvents(T0)[0];
  assert.equal(await service.assessNow(), 'ok');
  const after = service.engine.activeEvents(T0)[0];
  assert.equal(after.model_applied, true);
  assert.equal(after.assessment.title_ru, 'Протест у парламента растёт');
  assert.ok(Math.abs(after.severity - before.rule_severity) <= 25);
  assert.equal(
    after.verification,
    before.verification,
    'the model cannot verify',
  );
  assert.ok(
    server.urls.every((u) => u.startsWith('http://127.0.0.1:5001/')),
    server.urls.join(),
  );
  assert.equal(await service.assessNow(), 'ok');
  assert.equal(
    server.completions(),
    1,
    'an assessed revision is not sent again',
  );
  assert.equal(service.aiStatus().assessed, 1);
});

test('A15: invalid replies are retried once, then rejected without looping', async () => {
  const server = fakeServer({
    chat: () =>
      JSON.stringify({
        ...JSON.parse(goodReply),
        evidence_ids: ['e7'],
        lat: 1,
      }),
  });
  const service = serviceWith(server);
  const before = service.engine.activeEvents(T0)[0];
  await service.assessNow();
  await service.assessNow();
  assert.equal(server.completions(), 2);
  const after = service.engine.activeEvents(T0)[0];
  assert.equal(after.model_applied, false);
  assert.equal(after.attention_score, before.attention_score);
  assert.equal(service.aiStatus().rejected, 1);
  assert.ok(
    service.aiStatus().last_rejection.errors.includes('unknown_evidence:e7'),
  );
});

test('A14: the model server stopping mid-generation times out to rule-based scoring', async () => {
  const server = fakeServer({
    // Never answers: the connection hangs until our timeout aborts it.
    chat: (init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener(
          'abort',
          () => reject(init.signal.reason),
          { once: true },
        ),
      ),
  });
  const service = serviceWith(server, { timeoutMs: 50 });
  const before = service.engine.activeEvents(T0)[0];
  assert.equal(await service.assessNow(), 'failed');
  const ai = service.aiStatus();
  assert.equal(ai.state, 'offline');
  assert.equal(ai.last_error, 'timeout');
  const after = service.listEvents('live').events[0];
  assert.equal(
    after.attention_score,
    before.attention_score,
    'scores unchanged',
  );
  assert.equal(after.model_applied, false);
  assert.ok(server.urls.every((u) => u.startsWith('http://127.0.0.1:5001/')));
});

test('a timeout stops the abandoned generation and rests the model', async () => {
  let clock = T0;
  const server = fakeServer({
    chat: (init, n) =>
      n === 1
        ? new Promise((_, reject) =>
            init.signal.addEventListener(
              'abort',
              () => reject(init.signal.reason),
              { once: true },
            ),
          )
        : goodReply,
  });
  const llm = createLocalLlm({
    baseUrl: BASE,
    fetchImpl: server.fetchImpl,
    now: () => clock,
    timeoutMs: 50,
  });
  const service = createIntelService({ now: () => clock, llm, log: () => {} });
  service.engine.ingest([unrest], { receivedAt: T0 });
  assert.equal(await service.assessNow(), 'failed');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(
    server.urls.includes('http://127.0.0.1:5001/api/extra/abort'),
    'the abandoned generation is stopped',
  );
  clock += 2 * 60_000; // the server answers probes again
  assert.equal(await service.assessNow(), 'backing_off');
  assert.ok(service.aiStatus().backoff_until > clock);
  clock += 5 * 60_000;
  assert.equal(await service.assessNow(), 'ok');
  assert.equal(server.completions(), 1, 'the failed revision waits');
  clock += 30 * 60_000;
  assert.equal(await service.assessNow(), 'ok');
  assert.equal(server.completions(), 2, 'retried once the wait is over');
  assert.equal(service.aiStatus().assessed, 1);
});

test('busy elsewhere: no request competes with the operator’s own generation', async () => {
  const server = fakeServer({ perf: { queue: 1, idle: 0 } });
  const service = serviceWith(server);
  assert.equal(await service.assessNow(), 'busy_elsewhere');
  assert.equal(server.completions(), 0);
});

test('pausing local AI stops assessments; an unreachable server reads offline', async () => {
  const server = fakeServer();
  const service = serviceWith(server);
  service.updateSettings({ localAiEnabled: false });
  assert.equal(await service.assessNow(), 'disabled');
  assert.equal(service.aiStatus().state, 'paused');

  const down = createLocalLlm({
    baseUrl: BASE,
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  });
  const assessor = createAssessor({
    llm: down,
    worlds: () => [],
    enabled: () => true,
    log: () => {},
  });
  assert.equal(await assessor.cycle(), 'offline');
  assert.equal(assessor.status().state, 'offline');
});

test('concurrent triggers join one cycle instead of competing for the model', async () => {
  const server = fakeServer();
  const service = serviceWith(server);
  const [a, b] = await Promise.all([service.assessNow(), service.assessNow()]);
  assert.deepEqual([a, b], ['ok', 'ok']);
  assert.equal(server.completions(), 1);
  assert.equal(service.aiStatus().skipped_busy, 0);
});

test('our own just-finished generation is not mistaken for someone else’s', async () => {
  let clock = T0;
  const server = fakeServer({ perf: { queue: 0, idle: 0 } });
  const llm = createLocalLlm({
    baseUrl: BASE,
    fetchImpl: server.fetchImpl,
    now: () => clock,
  });
  await llm.probe();
  await llm.complete([], {});
  assert.equal(await llm.busy(), false, 'within the grace after our request');
  clock += 10_000;
  assert.equal(await llm.busy(), true, 'idle=0 later is another client');
});

test('a voice claim stops the assessor between jobs, not only between cycles', async () => {
  const { claimForeground, releaseForeground } = await import('./llmGate.js');
  const server = fakeServer({
    chat: () => {
      claimForeground(60_000); // the operator starts talking mid-cycle
      return goodReply;
    },
  });
  const llm = createLocalLlm({
    baseUrl: BASE,
    fetchImpl: server.fetchImpl,
    now: () => T0,
  });
  const service = createIntelService({ now: () => T0, llm, log: () => {} });
  service.engine.ingest(
    [
      unrest,
      {
        ...unrest,
        source_item_id: 'b',
        title: 'Port strike halts terminals',
        entities: ['port'],
        location: { lat: 10, lon: 10, precision: 'city' },
      },
    ],
    { receivedAt: T0 },
  );
  releaseForeground();
  assert.equal(await service.assessNow(), 'foreground');
  assert.equal(
    server.completions(),
    1,
    'the second job waited for the operator',
  );
  releaseForeground();
});
