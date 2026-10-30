import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_TOOL_SCHEMAS,
  schemaErrors,
  toolCatalogText,
  validateLocalTurn,
} from './localProtocol.js';
import { createEnergyVad, encodeWav16k, frameDb } from './localAudio.js';
import { createLocalSession, guessLanguage } from './localSession.js';

const turn = (calls, extra = {}) =>
  JSON.stringify({
    language: 'en',
    reply: 'Flying to Paris.',
    calls,
    ...extra,
  });

test('protocol: valid calls pass; any invalid call rejects the whole reply', () => {
  const ok = validateLocalTurn(
    turn([
      { name: 'fly_to_location', arguments: { query: 'Paris' } },
      { name: 'autopilot_control', arguments: { action: 'pause' } },
    ]),
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.turn.calls.length, 2);
  const cases = {
    unknownTool: [
      turn([{ name: 'run_shell', arguments: {} }]),
      /not an allowed value/,
    ],
    badLatitude: [
      turn([
        { name: 'fly_to_location', arguments: { latitude: 200, longitude: 0 } },
      ]),
      /above maximum/,
    ],
    extraArg: [
      turn([
        {
          name: 'autopilot_control',
          arguments: { action: 'pause', shell: 'rm' },
        },
      ]),
      /not allowed/,
    ],
    badEnum: [
      turn([
        { name: 'autopilot_control', arguments: { action: 'self_destruct' } },
      ]),
      /not an allowed value/,
    ],
    badCountry: [
      turn([{ name: 'find_events', arguments: { countries: ['ukraine'] } }]),
      /bad format/,
    ],
    tooMany: [
      turn(Array(4).fill({ name: 'zoom_to_globe', arguments: {} })),
      /too many items/,
    ],
    link: [turn([], { reply: 'See https://evil.example' }), /link/],
    malformed: ['{"reply":', /malformed_json/],
    language: [turn([], { language: 'de' }), /not an allowed value/],
  };
  for (const [name, [text, pattern]] of Object.entries(cases)) {
    const result = validateLocalTurn(text);
    assert.equal(result.ok, false, name);
    assert.match(result.errors.join(' '), pattern, name);
  }
});

test('protocol: a small catalogue of the spoken actions plus Autopilot tools', () => {
  assert.equal(LOCAL_TOOL_SCHEMAS.length, 11);
  assert.ok(toolCatalogText().length < 6000);
  assert.deepEqual(
    schemaErrors(5, { anyOf: [{ type: 'string' }, { type: 'integer' }] }),
    [],
  );
  assert.equal(schemaErrors(5.5, { type: 'integer' }).length, 1);
});

test('audio: 16 kHz mono WAV from any device rate', () => {
  const samples = new Float32Array(48_000).fill(0.5); // 1 s at 48 kHz
  const wav = encodeWav16k(samples, 48_000);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 16_000 * 2);
  assert.ok(Math.abs(view.getInt16(44, true) - 16384) <= 1);
  assert.ok(frameDb(new Float32Array(100).fill(0.5)) > -7);
});

test('audio: energy detector starts on speech, ends on silence, drops blips', () => {
  const vad = createEnergyVad({ frameMs: 40 });
  const feed = (db, frames) => {
    const edges = [];
    for (let i = 0; i < frames; i++) {
      const edge = vad.push(db);
      if (edge) edges.push(edge);
    }
    return edges;
  };
  feed(-70, 50); // learn a quiet room
  assert.deepEqual(feed(-25, 10), ['start']);
  assert.deepEqual(feed(-70, 30), ['end']); // 1.2 s of silence
  // A 160 ms click starts, but too little speech follows: discarded.
  assert.deepEqual([...feed(-25, 4), ...feed(-70, 30)], ['start', 'discard']);
});

test('language guess for typed commands', () => {
  assert.equal(guessLanguage('Покажи Европу'), 'ru');
  assert.equal(guessLanguage('Show Europe'), 'en');
});

/** A fake same-origin server, microphone and speaker for the adapter. */
function harness({ status, turnReply, statusCode = 200 } = {}) {
  const requests = [];
  const events = [];
  const actions = [];
  const consoleCalls = [];
  let segment;
  const capture = { started: false, stopped: false, paused: false };
  const json = (value, code = 200) =>
    new Response(JSON.stringify(value), { status: code });
  const fetchImpl = async (url, init = {}) => {
    requests.push(url);
    if (url.endsWith('/status'))
      return json(
        status ?? {
          enabled: true,
          stt: { available: true },
          tts: { available: true },
          llm: { state: 'online' },
        },
      );
    if (url.endsWith('/turn'))
      return json(
        turnReply ?? {
          ok: true,
          turn: {
            language: 'ru',
            reply: 'Ставлю автопилот на паузу и лечу в Париж.',
            calls: [
              { name: 'autopilot_control', arguments: { action: 'pause' } },
              { name: 'fly_to_location', arguments: { query: 'Paris' } },
            ],
          },
        },
        statusCode,
      );
    if (url.endsWith('/transcribe'))
      return json({ text: 'Покажи Париж', language: 'ru' });
    if (url.endsWith('/speak'))
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    return json({});
  };
  let resolvePlay;
  const player = {
    playing: false,
    play() {
      this.playing = true;
      return new Promise((resolve) => {
        resolvePlay = (value) => {
          this.playing = false;
          resolve(value);
        };
      });
    },
    stop() {
      if (this.playing) resolvePlay(false);
    },
  };
  const session = createLocalSession({
    emit: (event) => events.push(event),
    runAction: async (name, args) => {
      actions.push([name, args]);
      return { ok: true };
    },
    signal: new AbortController().signal,
    fetchImpl,
    documentRef: null,
    player,
    autopilot: () => ({
      voiceControl: async (action) => {
        consoleCalls.push(action);
        return { ok: true, text: 'Автопилот на паузе.' };
      },
      findEvents: async () => ({ ok: true, text: 'found' }),
    }),
    createCapture: ({ onSegment }) => {
      segment = onSegment;
      return {
        start: async () => {
          capture.started = true;
        },
        stop: () => {
          capture.stopped = true;
        },
        setPaused: (value) => {
          capture.paused = value;
        },
        beginManual: () => true,
        endManual: () => {},
      };
    },
  });
  return {
    session,
    requests,
    events,
    actions,
    consoleCalls,
    capture,
    player,
    say: (wav) => segment(wav),
    finishSpeech: () => resolvePlay(true),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('session: refuses to start without local services, with a clear reason', async () => {
  const h = harness({
    status: {
      enabled: true,
      stt: { available: false },
      llm: { state: 'online' },
    },
  });
  await assert.rejects(h.session.start(), /speech-to-text/);
  assert.equal(h.capture.started, false);
});

test('A16 (adapter): a Russian utterance runs validated calls and speaks the reply', async () => {
  const h = harness();
  await h.session.start();
  assert.equal(h.capture.started, true);
  h.say(new Uint8Array(100));
  for (let i = 0; i < 20 && !h.player.playing; i++) await settle();
  assert.deepEqual(
    h.consoleCalls,
    ['pause'],
    'Autopilot tool goes to the console',
  );
  assert.deepEqual(
    h.actions,
    [['fly_to_location', { query: 'Paris' }]],
    'app actions go to the runner',
  );
  const user = h.events.find(
    (e) => e.type === 'transcript' && e.role === 'user',
  );
  const assistant = h.events.find(
    (e) => e.type === 'transcript' && e.role === 'assistant',
  );
  assert.equal(user.text, 'Покажи Париж');
  assert.match(assistant.text, /Ставлю автопилот на паузу/);
  h.finishSpeech();
  await settle();
  assert.equal(h.events.at(-1).state, 'listening');
  // A18 (browser side): every request stays on this origin's local-voice routes.
  assert.ok(
    h.requests.every((url) => url.startsWith('/api/voice-local/')),
    h.requests.join(),
  );
});

test('A17 (adapter): speech arriving during a reply interrupts it and leaves no orphan playback', async () => {
  const h = harness();
  await h.session.start();
  h.session.sendText('Fly to Paris');
  for (let i = 0; i < 20 && !h.player.playing; i++) await settle();
  assert.equal(h.player.playing, true);
  h.say(new Uint8Array(100)); // operator speaks again
  // Interruption is synchronous: the old reply stops before any request.
  assert.equal(h.player.playing, false);
  for (let i = 0; i < 20; i++) await settle();
  const completions = h.events.filter((e) => e.type === 'completion');
  assert.equal(completions[0]?.status, 'interrupted');
});

test('session: stop releases the microphone and the model claim', async () => {
  const h = harness();
  await h.session.start();
  h.session.stop();
  assert.equal(h.capture.stopped, true);
  await settle();
  assert.equal(h.requests.filter((u) => u.endsWith('/session')).length, 2);
});

test('session: an unusable model reply is said, nothing runs', async () => {
  const h = harness({ turnReply: { ok: false, error: 'invalid_model_reply' } });
  await h.session.start();
  h.session.sendText('do something odd');
  for (let i = 0; i < 20 && !h.player.playing; i++) await settle();
  assert.deepEqual(h.actions, []);
  assert.match(
    h.events.find((e) => e.role === 'assistant').text,
    /could not understand/,
  );
});

test('tool arguments: prototype names are not declared properties', async () => {
  const { schemaErrors } = await import('./localProtocol.js');
  const schema = {
    type: 'object',
    properties: { action: { type: 'string' } },
    required: ['action'],
    additionalProperties: false,
  };
  const parsed = JSON.parse(
    '{"action":"on","__proto__":{"x":1},"constructor":5}',
  );
  assert.ok(schemaErrors(parsed, schema).length >= 2);
  assert.ok(schemaErrors({}, schema).some((e) => e.includes('required')));
  assert.deepEqual(schemaErrors({ action: 'on' }, schema), []);
});
