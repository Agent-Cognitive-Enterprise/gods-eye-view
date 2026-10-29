// World Bank consumer-price inflation (annual %, FP.CPI.TOTL.ZG; CC BY 4.0).
// Annual data, polled daily: a country's latest year is flagged as economic
// stress when inflation is very high (>= 50 %) or high and at least double its
// own five-year median (>= 20 % and >= 2x). These are product thresholds, not
// an economic model. Aggregates (regions, income groups) are skipped, and so
// is a country whose latest figure is more than MAX_LAG_YEARS old.

import { countryBounds, countryPoint, iso2Of } from '../geography.js';

export const WORLD_BANK_CPI_URL =
  'https://api.worldbank.org/v2/country/all/indicator/FP.CPI.TOTL.ZG?format=json&per_page=3000&date=';
const VERY_HIGH = 50;
const HIGH = 20;
const MAX_LAG_YEARS = 2;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Rows of one indicator page to flagged raw observations (pure). */
export function worldBankRowsToRecords(
  rows,
  { lastUpdated, now = Date.now() } = {},
) {
  const oldestYear = new Date(now).getUTCFullYear() - MAX_LAG_YEARS;
  const byCountry = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const iso2 = iso2Of(row?.countryiso3code);
    const year = Number(row?.date);
    if (!iso2 || !Number.isInteger(year) || !Number.isFinite(row.value))
      continue;
    if (!byCountry.has(iso2))
      byCountry.set(iso2, { name: row.country?.value, years: [] });
    byCountry
      .get(iso2)
      .years.push({ year, value: row.value, iso3: row.countryiso3code });
  }
  const records = [];
  for (const [iso2, { name, years }] of byCountry) {
    years.sort((a, b) => b.year - a.year);
    const [latest, ...earlier] = years;
    if (latest.year < oldestYear) continue;
    const baseline = earlier.slice(0, 5).map((y) => y.value);
    const typical = baseline.length >= 3 ? median(baseline) : null;
    const flagged =
      latest.value >= VERY_HIGH ||
      (latest.value >= HIGH &&
        typical !== null &&
        latest.value >= 2 * Math.max(typical, 1));
    if (!flagged) continue;
    const point = countryPoint(iso2);
    const value = Math.round(latest.value * 10) / 10;
    records.push({
      provider: 'worldbank',
      source_item_id: `cpi-${latest.iso3}-${latest.year}-${value}`,
      event_key: `cpi-${latest.iso3}-${latest.year}`,
      publisher: 'World Bank',
      source_type: 'primary_official',
      url: `https://data.worldbank.org/indicator/FP.CPI.TOTL.ZG?locations=${iso2}`,
      license: 'CC BY 4.0 (World Bank)',
      attribution: 'World Bank, World Development Indicators (FP.CPI.TOTL.ZG)',
      language: 'en',
      category: 'economic_stress',
      subtype: 'high_inflation',
      title: `Consumer price inflation ${value}% in ${name} (${latest.year})`,
      summary: [
        `Annual consumer price inflation ${value}% in ${latest.year}`,
        typical === null
          ? null
          : `median of the previous ${baseline.length} years ${Math.round(typical * 10) / 10}%`,
        'annual statistic, not a real-time signal',
      ]
        .filter(Boolean)
        .join('; '),
      published_at: lastUpdated,
      location: {
        lat: point?.lat ?? null,
        lon: point?.lon ?? null,
        precision: 'country',
        geolocation_status: point ? 'approximate' : undefined,
        region_code: iso2,
        place: name,
        bounds: countryBounds(iso2) ?? undefined,
      },
      metrics: {
        inflation_pct: value,
        inflation_baseline_pct:
          typical === null ? undefined : Math.round(typical * 10) / 10,
        severity_hint: value >= 100 ? 70 : value >= VERY_HIGH ? 60 : 50,
      },
    });
  }
  return records;
}

export function worldBankConnector({ baseUrl = WORLD_BANK_CPI_URL } = {}) {
  return {
    id: 'worldbank-inflation',
    provider: 'worldbank',
    url: baseUrl,
    intervalMs: 24 * 3600_000,
    // The indicator is revised a few times a year.
    staleAfterMs: 400 * 24 * 3600_000,
    license: 'CC BY 4.0 (World Bank)',
    attribution: 'World Bank',
    async poll({ fetchJson, now }) {
      const year = new Date(now()).getUTCFullYear();
      const url = `${baseUrl}${year - 8}:${year}`;
      const { body, notModified } = await fetchJson(url, {
        maxBytes: 6 * 1024 * 1024,
        timeoutMs: 60_000,
      });
      if (notModified) return { records: [], notModified: true };
      if (!Array.isArray(body) || !Array.isArray(body[1]))
        throw new Error('malformed World Bank JSON');
      const lastUpdated = Date.parse(body[0]?.lastupdated ?? '') || null;
      const records = worldBankRowsToRecords(body[1], {
        lastUpdated,
        now: now(),
      });
      return { records, latestObservationAt: lastUpdated ?? 0 };
    },
  };
}
