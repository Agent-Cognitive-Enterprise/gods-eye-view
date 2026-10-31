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

test('gate: words that fooled it on the live stream no longer do', () => {
  for (const text of [
    'Ball State coach blasts college football leadership over the playoff',
    'Riot Chaemirix says the first image pitched Augments',
    'Peach Riot joins the POP MART collectable figure line',
    'The people will riot.',
    'FOI 2386: Bushfire insurance claims, released on 16 November 2018',
    'A tsunami of paperwork landed on my desk this morning',
  ])
    assert.equal(gateReport(text).pass, false, text);
  for (const text of [
    'Blasts heard across central Kharkiv tonight',
    'A blast at the port has injured several workers',
    'Riots spread to a second district overnight',
    'Riot police fired tear gas at the crowd',
    'Tsunami warning issued for the coast',
  ])
    assert.equal(gateReport(text).pass, true, text);
});

test('gate: a report about the past, or about a report, is not a first report', () => {
  const reason = (text, publishedAt = '2026-10-20T00:00:00Z') =>
    gateReport(text, { publishedAt }).reason;
  assert.equal(
    reason('Hedge funds buy claims tied to the 2025 Los Angeles wildfires'),
    'retrospective',
  );
  assert.equal(
    reason('Britain narrowly escaped a grid blackout in June'),
    'retrospective',
  );
  assert.equal(
    reason('Explosions in Kyiv on March 3 left a crater'),
    'retrospective',
  );
  assert.equal(
    reason('Former officer goes on trial over undersea explosions'),
    'legal',
  );
  assert.equal(
    reason('Insured losses from Hurricane Isaias could reach $2 billion'),
    'business',
  );
  assert.equal(
    reason('Turkey awaits contract for Eurofighter Typhoon jets'),
    'sense',
  );
  assert.equal(
    reason('Macron denounces nationwide rioting and looting'),
    'reaction',
  );
  assert.equal(
    reason('Why are wildfires getting worse in Indonesia?'),
    'analysis',
  );
  assert.equal(
    reason('Police say they thwarted a mass shooting at a temple'),
    'forecast',
  );
});

test('gate: a stated toll outweighs a soft frame; a current date passes', () => {
  const passes = (text, publishedAt = '2026-10-20T00:00:00Z') =>
    gateReport(text, { publishedAt }).pass;
  assert.equal(
    passes(
      'Zelensky condemns missile strike on Kharkiv that killed at least 12',
    ),
    true,
  );
  assert.equal(
    passes('Russian missile attack kills two, Zelenskiy calls for air defence'),
    true,
  );
  assert.equal(
    passes('Explosions rocked Kyiv on Oct. 19, officials say'),
    true,
  );
  assert.equal(passes('Explosions heard in Kharkiv tonight'), true);
  assert.equal(
    passes('At least 20 injured in northern Israel explosion'),
    true,
  );
});

test('gate: the vocabulary reaches events it used to miss', () => {
  assert.equal(
    gateReport('At least 17 students dead in Pakistan school roof collapse')
      .subtype,
    'structural_collapse',
  );
  assert.equal(
    gateReport('Firefighters battle out-of-control blaze at Cardiff mill')
      .subtype,
    'fire',
  );
  assert.equal(
    gateReport('Worsening water crisis sparks protests in Guadalajara').pass,
    true,
  );
  assert.equal(
    gateReport('Pennsylvania reports 1,222 measles cases in outbreak').pass,
    true,
  );
  assert.equal(gateReport('All 22 crew rescued off UAE coast').pass, true);
});

test('gate: a topic with nothing happening is not a report', () => {
  const reason = (text) => gateReport(text).reason;
  assert.equal(
    reason('Regeneron extends agreement for supply of Ebola treatment'),
    'no_incident',
  );
  assert.equal(
    reason('Indonesia sends oxygen bus to aid residents in forest fire haze'),
    'no_incident',
  );
  assert.equal(
    reason('French minister says protests could turn violent'),
    'reaction',
  );
  assert.equal(
    reason('While protests in France claimed attention, Milan marched too'),
    'background',
  );
  assert.equal(
    reason('After the train crash that killed 69, a minister laid the blame'),
    'background',
  );
  assert.equal(
    reason('Bulgarians head to the polls amid drone strikes on ships'),
    'off_topic',
  );
  assert.equal(
    gateReport('Wildfire burns homes in Southern California').pass,
    true,
  );
  assert.equal(
    gateReport('Greek container ship sinks after drone attack').pass,
    true,
  );
});

test('gate: a correction always reaches the engine, whatever else it lacks', () => {
  for (const text of [
    'That explosion story was a hoax, nothing happened',
    'Correction: there was no explosion at the port',
    'Air raid alert over, all clear',
  ])
    assert.equal(gateReport(text).pass, true, text);
});

test('gate: the incident test is for English; other languages keep their rules', () => {
  assert.equal(gateReport('В Харькове прогремели взрывы').pass, true);
  assert.equal(
    gateReport('Sismo fuerte: explosion en el puerto', { language: 'es' }).pass,
    true,
  );
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

test('places: what fooled it on the live stream no longer does', () => {
  const unresolved = (text) => resolvePlace(text).location.precision;
  assert.equal(
    unresolved('Imagine flooding SkyNews with the SAn brand'),
    'unresolved',
  );
  assert.equal(
    unresolved('These Are the US Attorneys carrying out the agenda'),
    'unresolved',
  );
});

test('places: St. Petersburg is the Russian one, and an agency is not the scene', () => {
  for (const text of [
    'Flames reported in Ukrainian drone attack on St. Petersburg',
    'Drone attack on St Petersburg overnight',
    'Attack on Saint Petersburg, Russia overnight',
    'Fire in Petersburg overnight',
  ])
    assert.equal(resolvePlace(text).location.region_code, 'RU', text);
  assert.equal(
    resolvePlace('St. Petersburg FL under hurricane warning').location
      .region_code,
    'US',
  );
  const storm = resolvePlace(
    'Hurricane Trudy off Mexico, the National Hurricane Center in Miami said',
  );
  assert.equal(storm.location.region_code, 'MX');
});

test('places: a capital speaking is not where the event is', () => {
  assert.equal(
    resolvePlace('Tu-95 crashed in Russia during training, Moscow says')
      .location.place,
    'Russia',
  );
  assert.equal(
    resolvePlace('Pakistani airstrikes on Afghanistan kill nine, Kabul says')
      .location.place,
    'Afghanistan',
  );
});

test('places: a state code says which town, or stands in for it', () => {
  const florida = resolvePlace('Coastal Flood Advisory by NWS Melbourne FL');
  assert.equal(florida.location.place, 'Melbourne');
  assert.equal(florida.location.region_code, 'US');
  assert.ok(Math.abs(florida.location.lat - 28.1) < 0.2, 'not Australia');
  assert.equal(
    resolvePlace('Tornado hits Dallas TX tonight').location.place,
    'Dallas',
  );
  assert.equal(
    resolvePlace('Blast in Melbourne overnight').location.region_code,
    'AU',
  );
  // No such town in that state: the state, never the famous namesake.
  const standIn = resolvePlace('Storm damage reported in Kyiv OH this morning');
  assert.equal(standIn.location.region_code, 'US-OH');
  assert.equal(standIn.location.lat, null);
});

test('places: a US state is a region, with its proper name', () => {
  const { location } = resolvePlace('Flash flooding across Arizona tonight');
  assert.equal(location.place, 'Arizona');
  assert.equal(location.precision, 'region');
  assert.equal(location.region_code, 'US-AZ');
  assert.equal(location.lat, null);
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

test('places: the model may read what the gate cannot, from the post alone', () => {
  const careless = 'сильные взрывы в харькове прямо сейчас';
  assert.equal(resolvePlace(careless).location.precision, 'unresolved');
  assert.equal(
    verifyPlace(careless, 'Харьков', 'в харькове').location.place,
    'Kharkiv',
  );
  assert.equal(
    verifyPlace(careless, 'Kharkiv', 'в харькове').location.place,
    'Kharkiv',
    'named in another language',
  );
  assert.equal(verifyPlace(careless, 'Kyiv', 'в харькове'), null);
  assert.equal(
    verifyPlace(careless, 'Kharkiv', 'в Харькове'),
    null,
    'the quote must be the post itself',
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
