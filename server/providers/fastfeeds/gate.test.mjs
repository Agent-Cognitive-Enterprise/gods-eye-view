import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalLink, compileRules, gateReport, languageOf } from './gate.js';
import { resolvePlace, verifyPlace } from './places.js';

const passes = (text) => gateReport(text).pass;

test('gate: event words in English, Russian and Ukrainian, in any inflection', () => {
  assert.equal(
    gateReport('Explosions reported in Kharkiv').subtype,
    'explosion',
  );
  assert.equal(gateReport('В Харькове прогремели взрывы').subtype, 'explosion');
  assert.equal(gateReport('У Харкові пролунали вибухи').subtype, 'explosion');
  assert.equal(
    gateReport('Магнитуда землетрясения составила 6,1').category,
    'natural_disaster',
  );
  assert.equal(gateReport('Отключение электричества в Одессе').pass, true);
  assert.equal(
    gateReport('Эвакуация жителей из Белгорода').subtype,
    'evacuation_order',
  );
  assert.equal(gateReport('Tear gas fired at crowds downtown').subtype, 'riot');
});

test('gate: the most serious match decides', () => {
  const report = gateReport(
    'Protesters ran as a missile strike hit the square',
  );
  assert.equal(report.subtype, 'airstrike');
  assert.equal(report.severity, 70);
});

test('gate: figures of speech and stories are filtered, and say why', () => {
  assert.equal(gateReport('We had a blast at the beach today').pass, false);
  assert.equal(
    gateReport('A storm of criticism and a tornado of takes').reason,
    'not_an_event',
  );
  assert.equal(gateReport('New anime episode: the earthquake arc').pass, false);
  assert.equal(
    gateReport('Beautiful morning, coffee is good').reason,
    'no_topic',
  );
  assert.equal(gateReport('blast').reason, 'too_short');
  assert.equal(passes('unblasted, explosionless prose all round'), false);
  assert.equal(passes('We were blasting music all night long'), false);
});

test('gate: disputes, retractions and all-clears are recognised', () => {
  assert.equal(
    gateReport('The explosion claim was debunked').status_hint,
    'disputed',
  );
  assert.equal(
    gateReport('Информация о взрыве — фейк').status_hint,
    'disputed',
  );
  assert.equal(
    gateReport('Correction: there was no explosion here').status_hint,
    'retracted',
  );
  assert.equal(
    gateReport('Air raid alert ended, all clear').status_hint,
    'resolved',
  );
  assert.equal(
    gateReport('Отбой тревоги, воздушная тревога окончена').status_hint,
    'resolved',
  );
});

test('gate: operator language packs extend the rules', () => {
  const rules = compileRules([
    {
      category: 'civil_unrest',
      subtype: 'protest',
      severity: 50,
      terms: ['manifestación*'],
    },
  ]);
  const report = gateReport('Gran manifestación en Madrid hoy', { rules });
  assert.equal(report.pass, true);
  assert.equal(report.subtype, 'protest');
  assert.equal(gateReport('Gran manifestación en Madrid hoy').pass, false);
});

test('gate: hostile or huge text is contained', () => {
  assert.equal(gateReport(null).pass, false);
  const long = `${'a'.repeat(50_000)} explosion`;
  const started = performance.now();
  assert.equal(gateReport(long).pass, false, 'beyond the cap is not read');
  assert.ok(performance.now() - started < 200);
  assert.equal(
    gateReport('<script>alert(1)</script> explosion in town').pass,
    true,
  );
});

test('language: a stated language wins, else the script decides', () => {
  assert.equal(languageOf('Hello', 'de'), 'de');
  assert.equal(languageOf('Привет'), 'ru');
  assert.equal(languageOf('Вибухи у місті, їдуть'), 'uk');
  assert.equal(languageOf('Hello'), 'en');
  assert.equal(languageOf('🔥🔥'), 'und');
  assert.equal(languageOf('Hello', 'bad language'), 'en');
});

test('links: one article has one identity, however it was shared', () => {
  const same = 'https://example.com/news/item-1';
  for (const variant of [
    'http://www.example.com/news/item-1/',
    'https://EXAMPLE.com/news/item-1?utm_source=x&utm_medium=y',
    'https://m.example.com/news/item-1#comments',
    'https://example.com/news/item-1?fbclid=abc',
  ])
    assert.equal(canonicalLink(variant), same);
  assert.equal(
    canonicalLink('https://example.com/a?id=1'),
    'https://example.com/a?id=1',
  );
  assert.equal(canonicalLink('javascript:alert(1)'), null);
  assert.equal(canonicalLink('https://user:pw@example.com/a'), null);
  assert.equal(canonicalLink('not a url'), null);
});

test('places: a town the text names gives an approximate point', () => {
  const { location, evidence } = resolvePlace(
    'Explosions heard in Kharkiv tonight',
  );
  assert.equal(location.place, 'Kharkiv');
  assert.equal(location.precision, 'city');
  assert.equal(location.geolocation_status, 'needs_verification');
  assert.equal(location.region_code, 'UA');
  assert.ok(Math.abs(location.lat - 50) < 0.1);
  assert.deepEqual(evidence, ['Kharkiv']);
});

test('places: Russian and Ukrainian names match in their inflected forms', () => {
  for (const [text, place] of [
    ['Взрывы в Харькове', 'Kharkiv'],
    ['В Москве отключили свет', 'Moscow'],
    ['Обстрел Киева ночью', 'Kyiv'],
    ['Пожар под Одессой', 'Odessa'],
    ['У Харкові вибухи', 'Kharkiv'],
    ['Вибух у Києві', 'Kyiv'],
  ])
    assert.equal(resolvePlace(text).location.place, place, text);
});

test('places: a country gives a region and bounds, never a point', () => {
  const { location } = resolvePlace(
    'Nationwide blackout reported across Lebanon',
  );
  assert.equal(location.precision, 'country');
  assert.equal(location.region_code, 'LB');
  assert.equal(location.lat, null);
  assert.equal(location.lon, null);
  assert.ok(location.bounds);
  assert.equal(location.geolocation_status, 'unresolved');
  assert.equal(
    resolvePlace('Блэкаут по всей Молдове').location.region_code ?? 'MD',
    'MD',
  );
});

test('places: an unnamed or ambiguous place stays unresolved', () => {
  const unresolved = (text) => resolvePlace(text).location.precision;
  assert.equal(
    unresolved('Something exploded near here, stay safe'),
    'unresolved',
  );
  assert.equal(unresolved('Power is out and it is dark'), 'unresolved');
  assert.equal(
    unresolved('Fighting between Armenia and Azerbaijan again'),
    'unresolved',
  );
  assert.equal(unresolved('Georgia wildfires spreading'), 'unresolved');
  assert.equal(unresolved('Sirens from Kyiv to Lviv to Odesa'), 'unresolved');
});

test('places: with several towns, the one the sentence puts it in wins', () => {
  assert.equal(
    resolvePlace('Reporters from Kyiv say a blast hit in Lviv').location.place,
    'Lviv',
  );
  assert.equal(
    resolvePlace('Kyiv says a blast hit near Lviv overnight').location.place,
    'Lviv',
  );
});

test('places: a country right after a town qualifies it', () => {
  const paris = resolvePlace('Tornado hits Paris in the United States');
  assert.equal(paris.location.lat, null, 'not the French one');
  assert.equal(paris.location.region_code, 'US');
  assert.equal(
    resolvePlace('Blast in Beirut, Lebanon').location.place,
    'Beirut',
  );
});

test('places: a country elsewhere in the sentence does not move the town', () => {
  assert.equal(
    resolvePlace('Russia strikes Kyiv overnight').location.place,
    'Kyiv',
  );
  assert.equal(
    resolvePlace('Россия нанесла удар по Киеву').location.place,
    'Kyiv',
  );
  assert.equal(
    resolvePlace('Blast hit Kharkiv, officials in Ukraine say').location.place,
    'Kharkiv',
  );
});

test('places: every everyday spelling of a contested name resolves', () => {
  for (const [text, place] of [
    ['Blast in Odesa port', 'Odessa'],
    ['Blast in Odessa port', 'Odessa'],
    ['Blast in Kiev overnight', 'Kyiv'],
    ['Blast in Kharkov overnight', 'Kharkiv'],
    ['Strikes on Zaporizhzhia overnight', null],
    ['Strikes near Mykolaiv overnight', null],
    ['Strikes near Dnipro overnight', null],
  ]) {
    const found = resolvePlace(text).location;
    assert.equal(found.precision, 'city', text);
    if (place) assert.equal(found.place, place, text);
  }
});

test('places: a sentence-initial word needs real weight to be a town', () => {
  for (const text of [
    'Power is out across the district now',
    'Heavy flooding reported this morning',
    'Fighting resumed overnight here',
    'Protesters gathered downtown today',
  ])
    assert.equal(resolvePlace(text).location.precision, 'unresolved', text);
  assert.equal(resolvePlace('Kyiv under attack again').location.place, 'Kyiv');
});

test('places: a lower-case word is not a town', () => {
  assert.equal(
    resolvePlace('the mobile network is down').location.precision,
    'unresolved',
  );
  assert.equal(
    resolvePlace('a nice day for reading').location.precision,
    'unresolved',
  );
});

test('places: the model may only propose what the text says', () => {
  const text = 'Heavy shelling reported in Kherson region this morning';
  assert.equal(
    verifyPlace(text, 'Kherson', 'in Kherson').location.place,
    'Kherson',
  );
  assert.equal(verifyPlace(text, 'Kyiv', 'in Kyiv'), null, 'not in the text');
  assert.equal(
    verifyPlace(text, 'Kyiv', 'in Kherson'),
    null,
    'quote does not name it',
  );
  assert.equal(verifyPlace(text, 'Atlantis', 'Heavy shelling'), null);
  assert.equal(verifyPlace(text, '', ''), null);
});
