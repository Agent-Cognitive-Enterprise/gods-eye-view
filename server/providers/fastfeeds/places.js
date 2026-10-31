// Naming a place from a report's own words, against the bundled Natural Earth
// gazetteer. Offline and deterministic: a coordinate comes out only for a town
// the text actually names, and always as an approximate one; a country gives
// its region and bounds, never a point; anything ambiguous stays unresolved
// rather than being guessed. Stated post coordinates are never read.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { countryBounds, usStateBounds } from '../intel/geography.js';

const PACK = fileURLToPath(
  new URL(
    '../../../src/data/local_data/natural_earth/places.json',
    import.meta.url,
  ),
);
const LOCATIVES = new Set(
  'in at near outside over around в во на под возле около у біля поблизу під'.split(
    ' ',
  ),
);
// Clear when a same-named town is this many times the size of the next.
const DOMINANT_RATIO = 8;
const MAX_WORDS_IN_NAME = 3;
// A capital at the start of a sentence says nothing; only a town of this size
// counts there without "in" or "near" before it.
const SENTENCE_START_MIN_POPULATION = 100_000;
// A country or state right after a town says which town ("Paris, Texas").
const QUALIFIER_CHARS = 32;
const COUNTRY_ALIASES = Object.freeze({
  US: ['United States', 'USA', 'U.S.', 'US', 'США', 'Сполучені Штати'],
  GB: ['United Kingdom', 'UK', 'Britain', 'Великобритания', 'Британия'],
  RU: ['Russia', 'Россия', 'Росія', 'РФ'],
  KR: ['South Korea', 'Южная Корея', 'Південна Корея'],
  KP: ['North Korea', 'Северная Корея', 'Північна Корея'],
  CD: ['DR Congo', 'DRC'],
  PS: ['Palestine', 'Gaza Strip', 'West Bank', 'Палестина', 'Сектор Газа'],
});
// Names that are people or everyday words far more often than this place.
const COUNTRY_SKIP = new Set(['georgia', 'jordan', 'chad', 'turkey', 'guinea']);
const RU_ENDINGS =
  /(?:ами|ями|ого|ему|ом|ем|ой|ей|ою|ею|ах|ях|ам|ям|ую|ий|ый|а|я|у|ю|е|і|и|ы|ь|й)$/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

const US_STATES = Object.freeze({
  alabama: 'AL',
  alaska: 'AK',
  arizona: 'AZ',
  arkansas: 'AR',
  california: 'CA',
  colorado: 'CO',
  connecticut: 'CT',
  delaware: 'DE',
  florida: 'FL',
  hawaii: 'HI',
  idaho: 'ID',
  illinois: 'IL',
  indiana: 'IN',
  iowa: 'IA',
  kansas: 'KS',
  kentucky: 'KY',
  louisiana: 'LA',
  maine: 'ME',
  maryland: 'MD',
  massachusetts: 'MA',
  michigan: 'MI',
  minnesota: 'MN',
  mississippi: 'MS',
  missouri: 'MO',
  montana: 'MT',
  nebraska: 'NE',
  nevada: 'NV',
  'new hampshire': 'NH',
  'new jersey': 'NJ',
  'new mexico': 'NM',
  'new york state': 'NY',
  'north carolina': 'NC',
  'north dakota': 'ND',
  ohio: 'OH',
  oklahoma: 'OK',
  oregon: 'OR',
  pennsylvania: 'PA',
  'rhode island': 'RI',
  'south carolina': 'SC',
  'south dakota': 'SD',
  tennessee: 'TN',
  texas: 'TX',
  utah: 'UT',
  vermont: 'VT',
  virginia: 'VA',
  'west virginia': 'WV',
  wisconsin: 'WI',
  wyoming: 'WY',
});

/** Case-folded key; Cyrillic keeps its stem so inflected forms meet. */
export function placeKey(words) {
  return words
    .map((word) => {
      const lower = word.toLowerCase().normalize('NFC');
      if (!CYRILLIC.test(lower) || lower.length < 4) return lower;
      const stem = lower.replace(RU_ENDINGS, '');
      // Ukrainian closes the last vowel: Харків, Харкові; Київ, Києві.
      return (stem.length >= 3 ? stem : lower)
        .replace(/ів$/u, 'ов')
        .replace(/їв$/u, 'єв');
    })
    .join(' ');
}

const wordsOf = (text) => text.match(/[\p{L}\p{N}’'.-]+/gu) ?? [];

let cache = null;

function load() {
  if (cache) return cache;
  const pack = JSON.parse(fs.readFileSync(PACK, 'utf8'));
  const names = new Map(); // key -> [{kind, ...}]
  const add = (name, entry) => {
    const key = placeKey(wordsOf(name));
    if (!key) return;
    const held = names.get(key) ?? [];
    held.push(entry);
    names.set(key, held);
  };
  for (const [
    name,
    aliases,
    lat,
    lon,
    iso2,
    population,
    capital,
  ] of pack.cities) {
    const city = { kind: 'city', name, lat, lon, iso2, population, capital };
    for (const label of new Set([name, ...aliases])) add(label, city);
  }
  for (const [iso2, ...labels] of pack.countries) {
    const seen = new Set();
    const name = labels[0];
    for (const label of labels) {
      const key = placeKey(wordsOf(label));
      if (!key || seen.has(key) || COUNTRY_SKIP.has(key)) continue;
      seen.add(key);
      add(label, { kind: 'country', name, iso2 });
    }
  }
  for (const [iso2, labels] of Object.entries(COUNTRY_ALIASES)) {
    const name = pack.countries.find((row) => row[0] === iso2)?.[1] ?? iso2;
    for (const label of labels) add(label, { kind: 'country', name, iso2 });
  }
  for (const [label, postal] of Object.entries(US_STATES))
    add(label, { kind: 'state', name: label, iso2: 'US', postal });
  cache = { names, maxWords: MAX_WORDS_IN_NAME };
  return cache;
}

/**
 * The town a name means, or null when two of similar size share it or the
 * country named right after it rules every candidate out.
 */
function pickCity(entries, qualifiers) {
  const cities = entries.filter((entry) => entry.kind === 'city');
  if (!cities.length) return null;
  const pool = qualifiers.size
    ? cities.filter((c) => qualifiers.has(c.iso2))
    : cities;
  if (!pool.length) return null;
  const ranked = [...pool].sort((a, b) => b.population - a.population);
  if (ranked.length === 1) return ranked[0];
  return ranked[0].population >= ranked[1].population * DOMINANT_RATIO
    ? ranked[0]
    : null;
}

function mentionsIn(text) {
  const { names, maxWords } = load();
  const words = [...text.matchAll(/[\p{L}\p{N}’'.-]+/gu)];
  const found = [];
  for (let start = 0; start < words.length; start++) {
    for (
      let size = Math.min(maxWords, words.length - start);
      size >= 1;
      size--
    ) {
      const slice = words.slice(start, start + size).map((m) => m[0]);
      // A place name starts with a capital in every language covered here.
      if (!/^\p{Lu}/u.test(slice[0])) continue;
      const cleaned = slice.map((word) => word.replace(/[.'’-]+$/, ''));
      const entries = names.get(placeKey(cleaned));
      if (!entries) continue;
      found.push({
        entries,
        quote: cleaned.join(' '),
        index: words[start].index,
        end: words[start + size - 1].index + slice.at(-1).length,
        located: LOCATIVES.has(words[start - 1]?.[0].toLowerCase()),
        sentenceStart:
          start === 0 ||
          /[.!?:;\n]\s*$/.test(
            text.slice(words[start - 1].index, words[start].index),
          ),
      });
      start += size - 1;
      break;
    }
  }
  return found;
}

const regionOnly = (place, iso2, bounds) => ({
  lat: null,
  lon: null,
  precision: 'country',
  region_code: iso2,
  place,
  bounds,
  geolocation_status: 'unresolved',
});

/**
 * The most specific place a report's text supports.
 * @param {string} text
 * @returns {{location: object, evidence: string[]}}
 */
export function resolvePlace(text) {
  const mentions = mentionsIn(String(text ?? ''));
  const empty = { location: { precision: 'unresolved' }, evidence: [] };
  if (!mentions.length) return empty;
  const countries = mentions.flatMap((m) =>
    m.entries.filter((e) => e.kind === 'country'),
  );
  const states = mentions.flatMap((m) =>
    m.entries.filter((e) => e.kind === 'state'),
  );
  const qualifiersOf = (mention) =>
    new Set(
      mentions
        .filter(
          (other) =>
            other.index >= mention.end &&
            other.index - mention.end <= QUALIFIER_CHARS,
        )
        .flatMap((other) => other.entries)
        .filter((e) => e.kind !== 'city')
        .map((e) => e.iso2),
    );
  const towns = mentions
    .map((mention) => ({
      ...mention,
      // A word that is a country or a US state is not also a town here.
      city: mention.entries.some((e) => e.kind !== 'city')
        ? null
        : pickCity(mention.entries, qualifiersOf(mention)),
    }))
    .filter(
      ({ city, sentenceStart, located }) =>
        city &&
        (!sentenceStart ||
          located ||
          city.population >= SENTENCE_START_MIN_POPULATION),
    );
  const distinct = new Set(towns.map((m) => m.city.name));
  const chosen =
    distinct.size === 1
      ? towns[0]
      : towns.filter((m) => m.located).length === 1
        ? towns.find((m) => m.located)
        : null;
  if (chosen) {
    const { city } = chosen;
    return {
      location: {
        lat: city.lat,
        lon: city.lon,
        precision: 'city',
        region_code: city.iso2,
        place: city.name,
        geolocation_status: 'needs_verification',
      },
      evidence: [chosen.quote],
      place_id: `${city.iso2}:${city.name}`,
    };
  }
  if (states.length === 1 && new Set(countries.map((c) => c.iso2)).size <= 1) {
    const [state] = states;
    return {
      location: regionOnly(
        state.name,
        `US-${state.postal}`,
        usStateBounds(state.postal),
      ),
      evidence: [state.name],
      place_id: `US-${state.postal}`,
    };
  }
  // Towns in several countries, or several countries: too unclear to place.
  const countryCodes = new Set(countries.map((c) => c.iso2));
  if (countryCodes.size === 1 && !towns.length) {
    const [country] = countries;
    return {
      location: regionOnly(
        country.name,
        country.iso2,
        countryBounds(country.iso2),
      ),
      evidence: [country.name],
      place_id: country.iso2,
    };
  }
  return empty;
}

/**
 * Whether a place the model proposes is really in the text and in the
 * gazetteer: the deterministic check the model's answer has to pass.
 * @returns {?{location: object, evidence: string[]}}
 */
export function verifyPlace(text, placeName, quote) {
  const body = String(text ?? '');
  if (!placeName || !quote || !body.includes(quote)) return null;
  if (!quote.toLowerCase().includes(String(placeName).toLowerCase()))
    return null;
  const resolved = resolvePlace(quote);
  return resolved.evidence.length ? resolved : null;
}
