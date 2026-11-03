import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntelEngine } from './engine.js';
import { fastStatus } from './fastStatus.js';
import { createMemoryIntelStore } from './memoryStore.js';
import { stepScheduler, createSchedulerState } from './scheduler.js';
import { clusterEvents } from './clustering.js';
import { AUTOPILOT_DEFAULTS, SOCIAL_MARKER_TTL_MS } from './taxonomy.js';
import { independentLineages } from './scoring.js';

const START = Date.UTC(2026, 9, 31, 3, 0, 0);
const KYIV = { lat: 50.45, lon: 30.52, precision: 'city', place: 'Kyiv' };
const LVIV = { lat: 49.84, lon: 24.03, precision: 'city', place: 'Lviv' };

function world(settings = {}) {
  let clock = START;
  const store = createMemoryIntelStore();
  const engine = createIntelEngine({
    store,
    now: () => clock,
    settings: { ...AUTOPILOT_DEFAULTS, ...settings },
  });
  return {
    store,
    engine,
    now: () => clock,
    advance(ms) {
      clock += ms;
    },
  };
}

let serial = 0;
const post = (overrides = {}) => {
  serial += 1;
  return {
    provider: 'bluesky',
    source_item_id: `at://did:plc:a/app.bsky.feed.post/${serial}`,
    publisher: 'did:plc:a',
    source_type: 'social_claim',
    category: 'armed_conflict',
    subtype: 'explosion',
    title: `Explosions heard in central Kyiv tonight, report ${serial}`,
    published_at: START,
    location: KYIV,
    metrics: { severity_hint: 70 },
    ...overrides,
  };
};
const official = (overrides = {}) => {
  serial += 1;
  return {
    provider: 'gdacs',
    source_item_id: `official-${serial}`,
    event_key: `official-${serial}`,
    publisher: 'State Emergency Service',
    source_type: 'primary_official',
    category: 'armed_conflict',
    title: 'Explosions in central Kyiv confirmed by the emergency service',
    published_at: START,
    location: KYIV,
    metrics: { severity_hint: 80 },
    ...overrides,
  };
};
const only = (w) => w.engine.activeEvents(w.now());

test('one post is a drawn claim, below any camera or critical path', () => {
  const w = world();
  w.engine.ingest([post()], { receivedAt: START + 4_000 });
  const [event] = only(w);
  assert.equal(event.verification, 'unverified');
  assert.equal(event.confidence, 0.25);
  assert.equal(event.camera_eligible, false);
  assert.equal(event.critical_qualified, false);
  assert.equal(fastStatus(event), 'provisional');
});

test('a post with no place, or little severity, stays a candidate', () => {
  const w = world();
  w.engine.ingest([post({ location: {}, metrics: { severity_hint: 70 } })]);
  w.engine.ingest([
    post({
      title: 'Small protest in Lviv',
      category: 'civil_unrest',
      subtype: 'protest',
      location: LVIV,
      metrics: { severity_hint: 30 },
    }),
  ]);
  assert.deepEqual(only(w).map(fastStatus), ['candidate', 'candidate']);
});

test('many agreeing accounts never reach a critical interruption alone', () => {
  const w = world();
  const wording = [
    'Explosions heard in central Kyiv, windows shaking',
    'Kyiv centre explosions now, heard from the river',
    'Loud blasts across central Kyiv, sirens followed',
    'Central Kyiv explosions reported by neighbours here',
    'Explosions over Kyiv centre, smoke visible nearby',
  ];
  wording.forEach((title, i) =>
    w.engine.ingest([
      post({
        title,
        publisher: `did:plc:reporter${i}`,
        metrics: { severity_hint: 95 },
      }),
    ]),
  );
  const [event] = only(w);
  assert.equal(event.verification, 'corroborated');
  assert.equal(
    event.confidence,
    0.6,
    'capped, whatever the number of accounts',
  );
  assert.equal(event.critical_qualified, false);
});

test('a copy of one post shared by twenty accounts is one source', () => {
  const w = world();
  const title = 'BREAKING explosions in central Kyiv, everyone stay inside now';
  for (let i = 0; i < 20; i++)
    w.engine.ingest([post({ title, publisher: `did:plc:bot${i}` })]);
  const [event] = only(w);
  assert.equal(event.lineages.length, 1);
  assert.equal(event.verification, 'unverified');
});

test('a wave of posts does not renew an official event or lift its cooldown', () => {
  const w = world();
  w.engine.ingest([official()], { receivedAt: START });
  const [before] = only(w);
  w.advance(60_000);
  for (let i = 0; i < 10; i++)
    w.engine.ingest(
      [
        post({
          title: `Kyiv centre explosions confirmed around here, witness ${i} says`,
          publisher: `did:plc:echo${i}`,
          published_at: w.now(),
        }),
      ],
      { receivedAt: w.now() },
    );
  const [after] = only(w);
  assert.equal(after.revision, before.revision);
  assert.equal(
    after.last_meaningful_update_at,
    before.last_meaningful_update_at,
  );
  assert.equal(after.lineages.length, 1);
  assert.ok(
    w.store.observationsFor(after.event_id).length > 1,
    'still on the card',
  );
});

test('the second independent account is news; the third is an echo', () => {
  const w = world();
  w.engine.ingest([post({ title: 'Explosions heard over central Kyiv now' })]);
  const results = [
    'Explosions over central Kyiv, I can see the smoke',
    'Central Kyiv explosions, our building shook here',
  ].map(
    (title, i) =>
      w.engine.ingest([post({ title, publisher: `did:plc:other${i}` })])[0],
  );
  assert.equal(results[0].status, 'material_update');
  assert.equal(results[1].status, 'non_material');
});

test('an official report lifts a claim out of the social limits', () => {
  const w = world();
  w.engine.ingest([post()]);
  w.engine.ingest([official({ metrics: { severity_hint: 99 } })]);
  const [event] = only(w);
  assert.equal(event.verification, 'officially_reported');
  assert.equal(event.confidence, 0.85);
  assert.equal(fastStatus(event), 'official');
  assert.equal(event.critical_qualified, true);
});

test('an unconfirmed claim leaves the map after its short lifetime', () => {
  const w = world();
  w.engine.ingest([post()], { receivedAt: START });
  w.advance(SOCIAL_MARKER_TTL_MS - 1_000);
  assert.equal(only(w).length, 1);
  w.advance(2_000);
  assert.equal(only(w).length, 0);
  assert.equal(w.store.listEvents().length, 1, 'kept in the archive');
});

test('a deleted post stops counting, its words go, its existence stays', () => {
  const w = world();
  const first = post({ title: 'Explosions over central Kyiv tonight' });
  const second = post({
    title: 'Central Kyiv explosions, I can see the smoke',
    publisher: 'did:plc:b',
  });
  w.engine.ingest([first]);
  w.engine.ingest([second]);
  assert.equal(only(w)[0].verification, 'corroborated');
  const eventId = only(w)[0].event_id;
  const updateBefore = only(w)[0].last_meaningful_update_at;

  const outcome = w.engine.withdrawReport(eventId, {
    provider: 'bluesky',
    sourceItemId: first.source_item_id,
  });
  assert.deepEqual(outcome, { event_id: eventId, retracted: false });
  const [event] = only(w);
  assert.equal(event.verification, 'unverified');
  assert.equal(event.title, second.title);
  assert.equal(event.last_meaningful_update_at, updateBefore, 'no renewal');
  const held = w.store.observationsFor(eventId);
  assert.equal(held.length, 2, 'the record stays');
  assert.equal(held.find((o) => o.withdrawn).summary, '');
  assert.ok(!JSON.stringify(held).includes(first.title), 'its words are gone');
  assert.equal(w.store.revisions(eventId).at(-1).outcome, 'source_withdrawn');

  assert.equal(
    w.engine.withdrawReport(eventId, {
      provider: 'bluesky',
      sourceItemId: first.source_item_id,
    }),
    null,
    'a replayed delete changes nothing',
  );
});

test('deleting the only source retracts the event, with the history kept', () => {
  const w = world();
  const report = post();
  w.engine.ingest([report]);
  const eventId = only(w)[0].event_id;
  const outcome = w.engine.withdrawReport(eventId, {
    provider: 'bluesky',
    sourceItemId: report.source_item_id,
  });
  assert.equal(outcome.retracted, true);
  assert.equal(only(w).length, 0);
  const archived = w.engine.getEvent(eventId);
  assert.equal(archived.verification, 'retracted');
  assert.equal(fastStatus(archived), 'retracted');
});

test('deleting a post keeps a source that a copy still carries', () => {
  const w = world();
  const title = 'Explosions in central Kyiv, everybody stay inside right now';
  const original = post({ title });
  const copy = post({ title, publisher: 'did:plc:copy' });
  const other = post({
    title: 'Explosions in central Kyiv, sirens across the city',
    publisher: 'did:plc:third',
  });
  w.engine.ingest([original]);
  w.engine.ingest([copy]);
  w.engine.ingest([other]);
  const [event] = only(w);
  assert.equal(event.lineages.length, 2);
  w.engine.withdrawReport(event.event_id, {
    provider: 'bluesky',
    sourceItemId: original.source_item_id,
  });
  assert.equal(only(w)[0].lineages.length, 2, 'the copy still stands');
});

test('Autopilot never flies to an unverified post, and an official one still can', () => {
  const w = world({ minimumAttentionScore: 40 });
  w.engine.ingest([post({ metrics: { severity_hint: 100 } })]);
  const scheduled = () => {
    const events = only(w);
    const state = { ...createSchedulerState(), mode: 'auto' };
    return stepScheduler(state, {
      now: w.now(),
      events,
      clusters: clusterEvents(
        events.filter((e) => e.camera_eligible),
        { diameterKm: 800 },
      ),
      settings: { minimumAttentionScore: 40, tourWhenIdle: true },
    }).decision;
  };
  assert.notEqual(scheduled().type, 'fly');
  w.engine.ingest([official({ metrics: { severity_hint: 99 } })]);
  assert.equal(scheduled().type, 'fly');
});

test('posts alone never move the camera, however well corroborated', () => {
  const w = world({ minimumAttentionScore: 20 });
  [
    'Explosions over central Kyiv now',
    'Central Kyiv explosions, I can see smoke',
  ].forEach((title, i) =>
    w.engine.ingest([
      post({
        title,
        publisher: `did:plc:held${i}`,
        metrics: { severity_hint: 99 },
      }),
    ]),
  );
  const [event] = only(w);
  assert.equal(event.verification, 'corroborated');
  assert.equal(event.posts_held_from_camera, true);
  assert.equal(event.camera_eligible, false);
  assert.equal(event.critical_qualified, false);
  assert.equal(fastStatus(event), 'corroborated', 'still shown for what it is');
  const clusters = clusterEvents([event], { diameterKm: 800 });
  const decision = stepScheduler(
    { ...createSchedulerState(), mode: 'auto' },
    {
      now: w.now(),
      events: [event],
      clusters,
      settings: {
        minimumAttentionScore: 20,
        tourWhenIdle: true,
        tourMinimumScore: 0,
      },
    },
  ).decision;
  assert.notEqual(
    decision.type,
    'fly',
    'not as a shot, and not as a tour stop',
  );
});

test('a trust tag does not get posts past the camera hold', () => {
  const w = world();
  w.engine.ingest([
    post({
      source_type: 'secondary_reporting',
      title: 'Reporter says explosions over central Kyiv',
    }),
  ]);
  w.engine.ingest([
    post({
      source_type: 'primary_official',
      publisher: 'did:plc:tagged',
      title: 'Tagged account says explosions over central Kyiv tonight',
      metrics: { severity_hint: 99 },
    }),
  ]);
  const [event] = only(w);
  assert.equal(event.posts_held_from_camera, true);
  assert.equal(event.camera_eligible, false);
  assert.equal(event.critical_qualified, false);
});

test('an official feed behind the event lifts the hold; so can the operator', () => {
  const w = world();
  w.engine.ingest([post()]);
  w.engine.ingest([official({ metrics: { severity_hint: 99 } })]);
  assert.equal(only(w)[0].posts_held_from_camera, false);
  assert.equal(only(w)[0].critical_qualified, true);

  const allowed = world({ socialCameraEnabled: true });
  allowed.engine.ingest([post({ source_type: 'secondary_reporting' })]);
  assert.equal(only(allowed)[0].posts_held_from_camera, false);
});

// Each of these was proved against the first version of these rules.

const officialEvent = (w, over = {}) => {
  w.engine.ingest(
    [
      official({
        url: 'https://alerts.example/warning/1',
        title: 'Flood warning issued for central Kyiv by the emergency service',
        category: 'natural_disaster',
        subtype: 'flood',
        location: {
          region_code: 'UA',
          precision: 'region',
          bounds: { west: 30, south: 50, east: 31, north: 51 },
          place: 'Kyiv region',
        },
        ...over,
      }),
    ],
    { receivedAt: START },
  );
  return only(w)[0];
};
const floodPost = (over = {}) =>
  post({
    title: 'Flood warning for central Kyiv, water rising in the streets',
    category: 'natural_disaster',
    subtype: 'flood',
    location: KYIV,
    ...over,
  });

test('no post can retract, resolve or dispute an official event', () => {
  for (const [label, hint, extra] of [
    ['correction from an account on the card', 'retracted', {}],
    [
      'linking the official page, all clear',
      'resolved',
      { lineage_key: 'https://alerts.example/warning/1' },
    ],
    [
      'linking the official page, correction',
      'retracted',
      { lineage_key: 'https://alerts.example/warning/1' },
    ],
    ['a hoax call', 'disputed', {}],
    [
      'quoting it',
      'retracted',
      { derived_from: 'https://alerts.example/warning/1' },
    ],
  ]) {
    const w = world();
    const before = officialEvent(w);
    w.engine.ingest([floodPost()]);
    w.engine.ingest([floodPost({ status_hint: hint, ...extra })]);
    const [after] = only(w);
    assert.equal(after?.verification, 'officially_reported', label);
    assert.equal(after.confidence, before.confidence, label);
    assert.equal(after.revision, before.revision, `${label}: no renewal`);
  }
});

test('a post cannot move an official event or re-fire its camera', () => {
  for (const source_type of ['social_claim', 'secondary_reporting']) {
    const w = world();
    const before = officialEvent(w);
    w.engine.ingest([floodPost({ source_type })]);
    const [after] = only(w);
    assert.equal(after.location.place, 'Kyiv region', source_type);
    assert.equal(after.location.lat, null, source_type);
    assert.equal(after.revision, before.revision, source_type);
    assert.equal(
      after.last_meaningful_update_at,
      before.last_meaningful_update_at,
    );
  }
});

test('an official feed lifts the hold even if a post got there first in the same words', () => {
  const w = world();
  const title =
    'Flood warning issued for central Kyiv by the emergency service';
  w.engine.ingest([floodPost({ title, summary: title })]);
  w.engine.ingest([
    official({
      title,
      summary: title,
      category: 'natural_disaster',
      subtype: 'flood',
      location: KYIV,
      metrics: { severity_hint: 99 },
    }),
  ]);
  const [event] = only(w);
  assert.equal(event.verification, 'officially_reported');
  assert.equal(event.posts_held_from_camera, false);
  assert.equal(event.confidence, 0.85);
  assert.equal(
    event.lineages.some((l) => l.official),
    true,
  );
});

test('an aggregator or a news item beside posts does not lift the hold', () => {
  const w = world();
  w.engine.ingest([
    post({ title: 'Explosions over central Kyiv now, loud ones' }),
  ]);
  w.engine.ingest([
    post({
      title: 'Central Kyiv explosions, I can see the smoke here',
      publisher: 'did:plc:b',
    }),
  ]);
  w.engine.ingest([
    post({
      provider: 'gdelt',
      publisher: 'GDELT',
      source_type: 'aggregator',
      title: 'Explosions in central Kyiv reported today by news',
    }),
  ]);
  const [event] = only(w);
  assert.equal(event.posts_held_from_camera, true);
  assert.equal(event.camera_eligible, false);
  assert.equal(event.confidence, 0.6, 'still capped');

  const mixed = world();
  mixed.engine.ingest([
    post({
      provider: 'reliefweb',
      publisher: 'OCHA',
      source_type: 'secondary_reporting',
      title: 'Explosions reported in central Kyiv, assessment under way',
      metrics: {},
    }),
  ]);
  const before = only(mixed)[0];
  mixed.engine.ingest([
    post({
      title: 'Explosions in central Kyiv, assessment of damage under way',
      metrics: { severity_hint: 99 },
    }),
  ]);
  mixed.engine.ingest([
    post({
      title: 'Explosions in central Kyiv, assessment under way say people',
      publisher: 'did:plc:b',
      metrics: { severity_hint: 99 },
    }),
  ]);
  const [after] = only(mixed);
  assert.equal(after.posts_held_from_camera, true);
  assert.equal(
    after.verification,
    'unverified',
    'posts do not corroborate a firmer report',
  );
  assert.equal(after.confidence, before.confidence);
  assert.equal(
    after.rule_severity,
    before.rule_severity,
    'nor set its measured facts',
  );
  assert.equal(independentLineages(after), 1);
});

test('withdrawing a report keeps what stands and renews nothing', () => {
  const w = world();
  const tagged = post({
    source_type: 'primary_official',
    publisher: 'did:plc:tagged',
    title: 'Tagged account says explosions over central Kyiv',
  });
  const reporter = post({
    source_type: 'secondary_reporting',
    publisher: 'did:plc:reporter',
    title: 'Explosions over central Kyiv, a reporter says',
  });
  w.engine.ingest([tagged]);
  w.engine.ingest([reporter]);
  const [event] = only(w);
  assert.equal(event.verification, 'officially_reported');
  const decisionRevision = event.revision - (event.quiet_revisions ?? 0);
  w.engine.withdrawReport(event.event_id, {
    provider: 'bluesky',
    sourceItemId: tagged.source_item_id,
  });
  const [after] = only(w);
  assert.equal(after.official, false, 'official only while its source stands');
  assert.equal(after.verification, 'unverified');
  assert.equal(
    after.revision - after.quiet_revisions,
    decisionRevision,
    'no cooldown lifted',
  );
  const words = JSON.stringify(w.store.revisions(event.event_id));
  assert.ok(!words.includes(tagged.title), 'the history keeps no words of it');
});

test('an echo on the card carries the event when its only lineage withdraws', () => {
  const w = world();
  const first = post({ title: 'Explosions over central Kyiv tonight' });
  w.engine.ingest([first]);
  w.engine.ingest([
    post({
      title: 'Central Kyiv explosions, I can see the smoke',
      publisher: 'did:plc:b',
    }),
  ]);
  w.engine.ingest([
    post({
      title: 'Explosions in central Kyiv, windows shaking here',
      publisher: 'did:plc:c',
    }),
  ]);
  const [event] = only(w);
  w.engine.withdrawReport(event.event_id, {
    provider: 'bluesky',
    sourceItemId: first.source_item_id,
  });
  w.engine.withdrawReport(event.event_id, {
    provider: 'bluesky',
    sourceItemId: w.store.observationsFor(event.event_id)[1].source_item_id,
  });
  const [after] = only(w);
  assert.ok(after, 'a post still stands behind it');
  assert.equal(after.verification, 'unverified');
  assert.equal(after.lineages.length, 1);
});

test('proximity raises attention, never the confidence in a post', () => {
  const plain = world();
  const near = world({
    homeLocations: [{ label: 'home', lat: 50.4, lon: 30.5 }],
  });
  plain.engine.ingest([post()]);
  near.engine.ingest([post()]);
  const [far] = only(plain);
  const [close] = only(near);
  assert.ok(close.attention_score > far.attention_score);
  assert.equal(close.confidence, far.confidence);
  assert.equal(close.critical_qualified, false);
});
