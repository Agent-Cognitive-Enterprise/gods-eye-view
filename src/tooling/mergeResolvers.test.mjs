import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPrettierJson,
  mergeBoundaries,
  mergeIconList,
  mergeLocale,
  mergeText,
  ruleFor,
} from '../../scripts/merge-resolvers.mjs';

const locale = (value) => `${JSON.stringify(value, null, 2)}\n`;

test('a locale catalog keeps what each side added, changed or removed', () => {
  const base = {
    Ships: 'Schiffe',
    Old: 'Alt',
    Edit: 'Bearbeiten',
    Gone: 'Weg',
  };
  const ours = { ...base, Edit: 'Ändern', Banking: 'Bankwesen' };
  delete ours.Gone;
  const upstream = { ...base, Old: 'Älter', Rail: 'Bahn' };
  const out = mergeLocale({
    base: locale(base),
    ours: locale(ours),
    upstream: locale(upstream),
  });
  assert.equal(out.refused, undefined);
  assert.deepEqual(out.notes, []);
  // Upstream's order, then the keys only ours has.
  assert.equal(
    out.text,
    locale({
      Ships: 'Schiffe',
      Old: 'Älter',
      Edit: 'Ändern',
      Rail: 'Bahn',
      Banking: 'Bankwesen',
    }),
  );
});

test('a key both sides set differently takes upstream and is listed for a person', () => {
  const base = { Ships: 'Schiffe', Camera: 'Kamera' };
  const out = mergeLocale({
    base: locale(base),
    ours: locale({ ...base, Camera: 'Telecamera', 'Move up': 'Nach oben' }),
    upstream: locale({
      ...base,
      Camera: 'Fotocamera',
      'Move up': 'Nach oben verschieben',
    }),
  });
  assert.deepEqual(JSON.parse(out.text), {
    Ships: 'Schiffe',
    Camera: 'Fotocamera',
    'Move up': 'Nach oben verschieben',
  });
  assert.equal(out.notes.length, 2);
  assert.match(
    out.notes[0],
    /^"Camera": both sides changed it; kept upstream's "Fotocamera" over ours "Telecamera"$/,
  );
  assert.match(out.notes[1], /^"Move up": both sides added it/);
});

test('a key upstream removed and ours changed is removed, and listed', () => {
  const base = { A: 'a', B: 'b' };
  const out = mergeLocale({
    base: locale(base),
    ours: locale({ A: 'a', B: 'b2' }),
    upstream: locale({ A: 'a' }),
  });
  assert.deepEqual(JSON.parse(out.text), { A: 'a' });
  assert.match(out.notes[0], /kept upstream's \(removed\) over ours "b2"/);
});

test('plural entries (objects) compare by value', () => {
  const plural = { one: '# Schiff', other: '# Schiffe' };
  const base = { '# ships': plural };
  const out = mergeLocale({
    base: locale(base),
    ours: locale({ '# ships': { ...plural } }),
    upstream: locale({ '# ships': { ...plural }, X: 'x' }),
  });
  assert.deepEqual(out.notes, []);
  assert.deepEqual(JSON.parse(out.text), { '# ships': plural, X: 'x' });
});

test('a catalog that is not valid, not an object, or not laid out as written is refused', () => {
  const good = locale({ A: 'a' });
  assert.match(
    mergeLocale({ base: good, ours: '{ "A": ', upstream: good }).refused,
    /ours side is not valid JSON/,
  );
  assert.match(
    mergeLocale({ base: good, ours: good, upstream: '[1]\n' }).refused,
    /upstream side is not a JSON object/,
  );
  // A duplicate key would be dropped by JSON.parse: refused, not lost.
  assert.match(
    mergeLocale({
      base: good,
      ours: '{\n  "A": "a",\n  "A": "b"\n}\n',
      upstream: good,
    }).refused,
    /ours side is not laid out as this rule writes it/,
  );
  assert.match(
    mergeLocale({ base: '{"A":"a"}', ours: good, upstream: good }).refused,
    /base side is not laid out/,
  );
});

const page = (icons, title = 'GEV') =>
  `<!doctype html>\n<title>${title}</title>\n<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined&icon_names=${icons}" rel="stylesheet" />\n<body></body>\n`;

test("the icon list keeps both sides' additions and removals, sorted", () => {
  const out = mergeIconList({
    base: page('add,close,flight'),
    ours: page('add,close,flight,live_tv,rss_feed'),
    upstream: page('add,arrow_upward,flight'),
  });
  assert.equal(out.refused, undefined);
  // close: removed upstream; live_tv, rss_feed: ours; arrow_upward: upstream.
  assert.equal(out.text, page('add,arrow_upward,flight,live_tv,rss_feed'));
});

test('the rest of index.html still merges three ways around the list', () => {
  const out = mergeIconList({
    base: page('add,flight'),
    ours: page('add,flight,live_tv'),
    upstream: page('add,arrow_upward,flight', 'GEV upstream'),
  });
  assert.equal(
    out.text,
    page('add,arrow_upward,flight,live_tv', 'GEV upstream'),
  );
  const clash = mergeIconList({
    base: page('add,flight'),
    ours: page('add,flight,live_tv', 'GEV fork'),
    upstream: page('add,arrow_upward,flight', 'GEV upstream'),
  });
  assert.match(clash.refused, /conflicts outside the icon_names list/);
});

test('an icon list that is missing, repeated or unsorted is refused', () => {
  assert.match(
    mergeIconList({ base: '<p></p>\n', ours: page('a'), upstream: page('a') })
      .refused,
    /base side has 0 icon_names lists/,
  );
  assert.match(
    mergeIconList({
      base: page('a'),
      ours: page('a') + page('b'),
      upstream: page('a'),
    }).refused,
    /ours side has 2 icon_names lists/,
  );
  assert.match(
    mergeIconList({ base: page('a'), ours: page('a'), upstream: page('b,a') })
      .refused,
    /upstream side's icon_names list is not sorted/,
  );
});

test('mergeText merges clean three-way changes and reports a clash as null', () => {
  assert.equal(mergeText('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n'), 'A\nb\nC\n');
  assert.equal(mergeText('a\n', 'b\n', 'c\n'), null);
});

test('formatPrettierJson breaks an array whose line, comma included, passes 80 columns', () => {
  const fits = { g: { modules: ['x'.repeat(30), 'y'.repeat(25)] } };
  // `    "modules": [` + items + `]` is 78 columns, with no comma after it.
  assert.equal(
    formatPrettierJson(fits),
    `{\n  "g": {\n    "modules": ["${'x'.repeat(30)}", "${'y'.repeat(25)}"]\n  }\n}\n`,
  );
  const exactly80 = { g: { modules: ['x'.repeat(30), 'y'.repeat(26)], z: [] } };
  // 80 columns with its comma: still one line.
  assert.match(formatPrettierJson(exactly80), /"modules": \["x+", "y+"\],\n/);
  const over = { g: { modules: ['x'.repeat(30), 'y'.repeat(27)], z: [] } };
  assert.match(
    formatPrettierJson(over),
    /"modules": \[\n {6}"x+",\n {6}"y+"\n {4}\],\n/,
  );
  assert.equal(
    formatPrettierJson({ a: {}, b: [] }),
    '{\n  "a": {},\n  "b": []\n}\n',
  );
});

const groups = (value) => formatPrettierJson(value);

test("package boundaries merge list by list and keep each side's changes", () => {
  const base = {
    ui: {
      exports: ['./ui'],
      modules: ['a.js', 'b.js', 'old.js'],
      external: ['vue'],
    },
    gone: { exports: [], modules: ['g.js'], external: [] },
  };
  const ours = {
    ui: {
      exports: ['./ui'],
      modules: ['a.js', 'b.js', 'old.js', 'fork.js'],
      external: ['vue', 'hls.js'],
    },
    gone: base.gone,
    fork: { exports: ['./fork'], modules: ['f.js'], external: [] },
  };
  const upstream = {
    rail: { exports: ['./rail'], modules: ['r.js'], external: [] },
    ui: {
      exports: ['./ui'],
      modules: ['a.js', 'b.js', 'new.js'],
      external: ['vue'],
    },
  };
  const out = mergeBoundaries({
    base: groups(base),
    ours: groups(ours),
    upstream: groups(upstream),
  });
  assert.equal(out.refused, undefined);
  assert.deepEqual(JSON.parse(out.text), {
    rail: upstream.rail,
    ui: {
      exports: ['./ui'],
      modules: ['a.js', 'b.js', 'new.js', 'fork.js'],
      external: ['vue', 'hls.js'],
    },
    fork: ours.fork,
  });
  assert.equal(out.text, formatPrettierJson(JSON.parse(out.text)));
});

test('package boundaries refuse what the lists cannot settle', () => {
  const base = { ui: { exports: ['./ui'], modules: ['a.js'], strict: true } };
  const run = (ours, upstream) =>
    mergeBoundaries({
      base: groups(base),
      ours: groups(ours),
      upstream: groups(upstream),
    }).refused;
  assert.match(
    run(
      { ui: { ...base.ui, strict: false, modules: ['a.js', 'x.js'] } },
      { ui: { ...base.ui, strict: 'loose', modules: ['a.js', 'y.js'] } },
    ),
    /"ui"\.strict was changed differently on both sides/,
  );
  assert.match(
    run({}, { ui: { ...base.ui, modules: ['a.js', 'y.js'] } }),
    /"ui" was deleted on one side and changed on the other/,
  );
  assert.match(
    run({ ui: { ...base.ui, modules: ['a.js', 'x.js'] } }, { ui: [] }),
    /"ui" is not an object on every side/,
  );
  // A list on one side and anything else on the other.
  assert.match(
    run(
      { ui: { ...base.ui, modules: ['a.js', 'x.js'] } },
      { ui: { ...base.ui, modules: 'a.js' } },
    ),
    /"ui"\.modules was changed differently/,
  );
  assert.match(
    mergeBoundaries({
      base: JSON.stringify(base),
      ours: groups(base),
      upstream: groups(base),
    }).refused,
    /base side is not laid out/,
  );
});

test('rules are picked by path', () => {
  assert.equal(ruleFor('src/i18n/locales/sv.json').name, 'locale catalog');
  assert.equal(ruleFor('index.html').name, 'icon list');
  assert.equal(
    ruleFor('scripts/package-boundaries.json').name,
    'package boundaries',
  );
  assert.equal(ruleFor('src/i18n/same-as-english.json'), null);
  assert.equal(ruleFor('src/i18n/locales/sub/x.json'), null);
  assert.equal(ruleFor('dev/conformance/index.html'), null);
  assert.equal(ruleFor('package.json'), null);
});
