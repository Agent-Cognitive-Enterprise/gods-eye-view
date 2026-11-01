#!/usr/bin/env node
// Builds src/data/local_data/natural_earth/places.json, the offline gazetteer
// the Fast Intelligence gate uses to name a place in a report: Natural Earth
// 10m populated places and country names (public domain), reduced to names and
// a label point. Run by hand when the source changes; nothing fetches this at
// runtime.
//
//   node scripts/build-fast-gazetteer.mjs <populated_places.geojson> \
//     <admin_0_countries.geojson> <natural-earth-vector commit>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/data/local_data/natural_earth/places.json',
);
const MIN_POPULATION = 1_000;

// Common names Natural Earth leaves out, and everyday spellings of its own.
const ALIASES = Object.freeze({
  Kyiv: ['Kiev', 'Київ'],
  Kharkiv: ['Kharkov', 'Харків'],
  Odessa: ['Odesa', 'Одеса'],
  Lviv: ['Lvov', 'Львів'],
  Dnipro: ['Dnepr', 'Dnipropetrovsk', 'Дніпро'],
  Dnipropetrovsk: ['Dnipro', 'Dnepr', 'Дніпро'],
  Zaporizhzhia: ['Zaporozhye', 'Zaporizhia', 'Запоріжжя'],
  Zaporizhia: ['Zaporizhzhia', 'Zaporozhye', 'Запоріжжя'],
  Mykolayiv: ['Mykolaiv', 'Nikolaev', 'Миколаїв'],
  Mykolaiv: ['Mykolayiv', 'Nikolaev', 'Миколаїв'],
  'Tel Aviv-Yafo': ['Tel Aviv'],
  Gaza: ['Gaza City'],
  'Ho Chi Minh City': ['Saigon'],
  Mumbai: ['Bombay'],
  Yangon: ['Rangoon'],
  'Saint Petersburg': [
    'St. Petersburg',
    'Petersburg',
    'Санкт-Петербург',
    'Петербург',
  ],
});

// Everyday words that are also towns; a capital letter at the start of a
// sentence would otherwise place a report there.
const COMMON_WORDS = new Set(
  [
    'Bar',
    'Bath',
    'Best',
    'Bend',
    'Bay',
    'Battle',
    'Boston',
    'Buffalo',
    'Cork',
    'Deal',
    'Derby',
    'Eagle',
    'Early',
    'Fair',
    'Hope',
    'Hull',
    'Independence',
    'Liberty',
    'Lima',
    'Lincoln',
    'Long',
    'Male',
    'Man',
    'March',
    'Marathon',
    'Mobile',
    'Nice',
    'Normal',
    'Of',
    'Orange',
    'Paradise',
    'Peace',
    'Phoenix',
    'Reading',
    'Rugby',
    'Sale',
    'San',
    'Sandy',
    'Split',
    'Sydney Mines',
    'Tours',
    'Trail',
    'Troy',
    'Union',
    'Victoria',
    'Vernon',
    'Wells',
    'York',
  ].map((word) => word.toLowerCase()),
);

const round = (value) => Math.round(value * 1000) / 1000;
const clean = (value) => (typeof value === 'string' ? value.trim() : '');

function cityRow(p) {
  const name = clean(p.NAME_EN) || clean(p.NAME);
  if (name.length < 3 || COMMON_WORDS.has(name.toLowerCase())) return null;
  if (!/^[A-Z]{2}$/.test(p.ISO_A2 ?? '')) return null;
  const population = Number(p.POP_MAX) || 0;
  if (population < MIN_POPULATION) return null;
  const names = new Set([
    clean(p.NAME),
    clean(p.NAMEASCII),
    clean(p.NAME_RU),
    clean(p.NAME_UK),
    ...clean(p.NAMEALT)
      .split('|')
      .map((alt) => alt.trim()),
    // By English name: Florida's St. Petersburg must not inherit Russia's aliases.
    ...(ALIASES[name] ?? []),
  ]);
  names.delete(name);
  names.delete('');
  return [
    name,
    [...names].filter((alias) => alias.length >= 3),
    round(p.LATITUDE),
    round(p.LONGITUDE),
    p.ISO_A2,
    population,
    p.ADM0CAP ? 1 : 0,
  ];
}

function countryRow(p) {
  const iso2 = /^[A-Z]{2}$/.test(p.ISO_A2_EH ?? '') ? p.ISO_A2_EH : p.ISO_A2;
  if (!/^[A-Z]{2}$/.test(iso2 ?? '')) return null;
  return [
    iso2,
    clean(p.NAME_EN) || clean(p.ADMIN),
    clean(p.NAME_RU),
    clean(p.NAME_UK),
  ];
}

const [placesFile, countriesFile, commit] = process.argv.slice(2);
if (!placesFile || !countriesFile || !commit) {
  console.error(
    'usage: build-fast-gazetteer.mjs <places.geojson> <countries.geojson> <commit>',
  );
  process.exit(2);
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).features;
const cities = read(placesFile)
  .map((feature) => cityRow(feature.properties))
  .filter(Boolean)
  .sort((a, b) => b[5] - a[5] || (a[0] < b[0] ? -1 : 1));
const countries = read(countriesFile)
  .map((feature) => countryRow(feature.properties))
  .filter(Boolean)
  .sort((a, b) => (a[0] < b[0] ? -1 : 1));
fs.writeFileSync(
  OUT,
  JSON.stringify({
    meta: {
      source:
        'Natural Earth 10m populated places and admin 0 countries (public domain)',
      commit,
      columns: {
        cities: [
          'name',
          'aliases',
          'lat',
          'lon',
          'iso2',
          'population',
          'capital',
        ],
        countries: ['iso2', 'english', 'russian', 'ukrainian'],
      },
    },
    cities,
    countries,
  }),
);
console.log(`${cities.length} cities, ${countries.length} countries`);
