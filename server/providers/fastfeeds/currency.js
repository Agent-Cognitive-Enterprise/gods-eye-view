// Is this report about something happening now? Newsrooms mention disasters all
// day in stories that are not reports of one: what it cost, who said what, what
// it all means, what happened last year. Topic words alone cannot tell those from
// a first report, and measured on real news accounts they were a third of what
// the gate passed.
//
// Lists of bad phrases did not hold up: tuned to 88 % on one period they scored
// 66 % on the next, because a new week brings new phrases. So the main test is
// positive. The opening of a post must show the event happening, in the terms
// that kind of event happens in: a wildfire burns, an outbreak reports cases. The
// frames below remain as a second, cheaper filter. See docs/FAST_FEEDS_EVALUATION.md.

import { compileTerms } from './terms.js';

/** Never a first report, whatever else the post says. */
const HARD_FRAMES = Object.freeze({
  retrospective: compileTerms([
    'anniversary',
    'years ago',
    'year ago',
    'decade ago',
    'years after',
    'year after',
    'months after',
    'a year on',
    'one year on',
    'last year',
    'looks back',
    'looking back',
    'still reeling',
    'emerging from',
    'recovering from',
    'commemorat*',
    'memorial service',
    'wildfire season',
    'perfect fuel',
    'годовщин*',
    'лет назад',
    'річниц*',
    'років тому',
  ]),
  legal: compileTerms([
    'on trial',
    'stands trial',
    'sues',
    'court to hear',
    'in custody',
    'custody of',
    'charged',
    'sentenced',
    'sentence',
    'pleaded',
    'pleads',
    'guilty',
    'convicted',
    'lawsuit',
    'in court',
    'court hearing',
    'legal fees',
    'jailed',
    'indicted',
    'inquest',
    'coroner',
    'pardoned',
    'appeals court',
    'суд приговорил',
  ]),
  business: compileTerms([
    'insured losses',
    'hedge fund*',
    'investors',
    'shareholder*',
    'stock market',
    'prediction market',
    'earnings',
    'market cap',
    'retailers',
    'air purifiers',
    'surge in demand',
    'brokers',
    'marketplace',
    'traders',
    'CEO',
    'markets',
    'export project',
    'oil giant',
  ]),
  sense: compileTerms([
    'Eurofighter',
    'RAF Typhoon',
    'Typhoon jet*',
    'flooding into',
    'like an explosion',
    'Top 10 Shootout',
    'penalty shootout',
    'The Avalanches',
    'tsunami of',
    'stadium ban',
    'match abandonment',
    'shipwreck revealed',
    'oldest known',
    'years of debate',
    'busy week',
    'message of support',
  ]),
  negative: compileTerms(['no new cases', 'no new Ebola cases']),
});

/** Usually not a report; a stated toll or reading says otherwise. */
const SOFT_FRAMES = Object.freeze({
  analysis: compileTerms([
    'analysis',
    'explainer',
    'opinion',
    'commentary',
    'human cost',
    'psychological toll',
    'experts told',
    'experts say',
    'could backfire',
    'highlight',
    'highlights',
    'exposes',
    'raises alarm',
    'test preparedness',
    'in the jungles of',
    'scientists say',
    'interview',
    'podcast',
    'hear more',
    'weighs in',
    'what to know',
    'what we know',
    'explained',
    'climate change',
    'taking a toll',
    'need to know',
    'families wait',
    'mourn',
    'hero',
    'cope with',
    'game over',
    'demands new future',
    'has shaped',
    'have shaped',
    'debt squeeze',
  ]),
  reaction: compileTerms([
    'denounce*',
    'condemn*',
    'vows',
    'vow',
    'pledge*',
    'promises',
    'calls for',
    'call on',
    'calls on',
    'rules out',
    'acknowledges',
    'unacceptable',
    'blames',
    'denies',
    'deny',
    'trolls',
    'delegation',
    'nearing agreement',
    'UN experts',
    'to send additional',
    'to boost',
    'roll out',
    'rolls out',
    'rolling out',
    'orders more',
    'has identified',
    'preventive notices',
    'warn citizens',
    'urges calm',
    'briefing',
    'says mass protests',
    'not told',
    'remains isolated',
    'responds',
    'matches',
    'linked to',
    'will not resign',
    'orders school inspections',
    'give update',
    'takes over investigation',
    'have banned',
    'tightens',
    'ease protests',
    'to meet',
    'accuse',
    'press freedom',
    'protests will continue',
  ]),
  forecast: compileTerms([
    'considering',
    'may expand',
    'could reach',
    'risk of',
    'warns of',
    'warn of',
    'potential',
    'bracing',
    'braces',
    'thwarted',
    'plot',
    'threat of',
    'ahead of',
    'in anticipation',
    'protests expected',
    'further protests',
    'more protests planned',
    'to deploy',
  ]),
});

const COUNT =
  '(?:\\d[\\d,.]*|two|three|four|five|six|seven|eight|nine|ten|dozens?|scores|hundreds|thousands)';
const CASUALTY =
  '(?:killed|dead|dies|died|injured|wounded|missing|hurt|displaced|evacuated|arrested|detained)';
const STATED_TOLL = new RegExp(
  `\\b${COUNT}\\b[^.\\n]{0,40}\\b${CASUALTY}\\b|\\b(?:kills?|killed|injures?|injured|wounds?|wounded)\\b[^.\\n]{0,20}\\b${COUNT}\\b|\\b${COUNT}\\s+(?:killed|dead)\\b|death toll|magnitude[ -]\\d`,
  'i',
);

const MONTHS = Object.freeze([
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
]);
const MONTH_WORD =
  '(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const DAY_OF_MONTH = new RegExp(`\\b${MONTH_WORD}\\.?\\s+(\\d{1,2})\\b`, 'g');
const IN_MONTH = new RegExp(`\\bin ${MONTH_WORD}\\b(?!\\.?\\s+\\d)`, 'g');
const YEAR = /(?<![\d-])(19\d\d|20\d\d)(?![\d-])/g;
const STALE_AFTER_MS = 3 * 24 * 3600_000;

const monthIndex = (word) => MONTHS.indexOf(word.slice(0, 3).toLowerCase());

/** The text dates itself to before the post: an old story, however it reads. */
export function datedInThePast(text, publishedAt) {
  const published = new Date(publishedAt);
  if (!Number.isFinite(published.getTime())) return false;
  const year = published.getUTCFullYear();
  for (const [, stated] of text.matchAll(YEAR))
    if (Number(stated) < year) return true;
  for (const [, month, day] of text.matchAll(DAY_OF_MONTH)) {
    const index = monthIndex(month);
    // December read in January means last year.
    const stated = Date.UTC(
      index > published.getUTCMonth() + 1 ? year - 1 : year,
      index,
      Number(day),
    );
    if (published - stated > STALE_AFTER_MS) return true;
  }
  for (const [, month] of text.matchAll(IN_MONTH)) {
    const back = (published.getUTCMonth() - monthIndex(month) + 12) % 12;
    if (back >= 2 && back <= 10) return true;
  }
  return false;
}

// How much of a post counts as its opening: headlines and ledes state the event.
const OPENING_CHARS = 220;

const shape = (source) => new RegExp(source, 'iu');
const HARM =
  'kill(?:s|ed|ing)?|dead|deaths?|die[sd]?|injur(?:es?|ed)|wound(?:s|ed)|missing|casualties|hurt|rescued?|rescuers';
const DAMAGE = `${HARM}|destroy(?:s|ed)?|damag(?:es?|ed)|evacuat\\w+|cuts? power|without power|displac\\w+`;

/**
 * What each kind of event is seen to do. Topics not listed (operator language
 * packs, and every Cyrillic post, whose rules carry their own sense of the event)
 * are not held to a shape.
 */
const EVENT_SHAPES = Object.freeze({
  earthquake: shape(
    `magnitude|strikes?|struck|hits?|shak\\w+|rattles?|reported|felt|aftershocks?|${HARM}`,
  ),
  tsunami: shape('warning|alert|waves? (?:hit|reach)|evacuat\\w+|advisory'),
  flood: shape(
    `warning|swept|sweeps?|submerg\\w+|inundat\\w+|rising|closed|floodwaters|hits?|rescue\\w*|${DAMAGE}`,
  ),
  storm: shape(
    `landfall|hits?|lash(?:es|ed)?|batter\\w*|pound\\w*|strengthen\\w*|intensif\\w+|weaken\\w*|approach\\w*|nears?|stalls?|sweeps?|looms?|warning|moves? toward|category \\d|${DAMAGE}`,
  ),
  wildfire: shape(
    `burn\\w*|spread\\w*|rag(?:es?|ing)|scorch\\w*|charred|ablaze|sweep\\w*|fight\\w*|contain\\w*|${DAMAGE}`,
  ),
  volcano: shape('erupt\\w+|ash|lava|evacuat\\w+|alert'),
  landslide: shape(`buri(?:es|ed)|triggered|sweeps?|${DAMAGE}`),
  explosion: shape(
    `heard|rock\\w*|shak\\w+|hit\\w*|reported|fire|at |near |in |${DAMAGE}`,
  ),
  bombing: shape(`hits?|${DAMAGE}`),
  airstrike: shape(
    `hits?|strikes?|struck|target\\w*|launch\\w*|attack\\w*|slam\\w*|sets? |fire|explosions|${DAMAGE}`,
  ),
  gunfire: shape(`open(?:ed|s)? fire|attack\\w*|shot|${HARM}`),
  air_raid: shape('sound\\w*|declared|issued|sirens?|alert'),
  mobilisation: shape('order\\w*|announc\\w+|declar\\w+|cross\\w*|moved?'),
  protest: shape(
    'march\\w*|rall(?:y|ies|ied)|clash\\w*|gather\\w*|took to|detain\\w*|arrest\\w*|tear gas|demand\\w*|storm\\w*|camp\\w*|force\\w*|sweep\\w*|intercepted',
  ),
  clashes: shape(
    'clash\\w*|march\\w*|rall(?:y|ies|ied)|erupt\\w*|sweep\\w*|spread\\w*|arrest\\w*|detain\\w*|tear gas|storm\\w*|fresh protests|protests in|hit\\w*|rock\\w*|escalat\\w*|continue',
  ),
  riot: shape(
    'fired|fire|clash\\w*|loot\\w*|burn\\w*|arrest\\w*|deployed|hurled|smash\\w*|erupt\\w*|spread\\w*|set |attacked',
  ),
  strike: shape(
    'walk\\w*|began|begins?|strike at|workers strike|strike for|halt\\w*|shut\\w*',
  ),
  curfew: shape(
    'impos\\w+|declar\\w+|enforc\\w+|announc\\w+|fresh curfews|under',
  ),
  power_outage: shape(
    `left|leaves|hit\\w*|reported|occurred|across|cuts?|emergency|mass|without|${HARM}`,
  ),
  communications_outage: shape('reported|hit\\w*|cut\\w*|across|down'),
  transport_disruption: shape(
    `closed|closure|shut\\w*|derail\\w*|collaps\\w+|${HARM}`,
  ),
  structural_collapse: shape(`collaps\\w+|buried|trapped|${HARM}`),
  transport_accident: shape(
    `crash(?:es|ed)? (?:near|in|at|on|into)|collid\\w+|collision|derail\\w*|capsiz\\w+|s[ai]nks?|${HARM}`,
  ),
  evacuation_order: shape(
    'order\\w*|evacuated|evacuating|fled|flee\\w*|thousands|residents',
  ),
  bank_stress: shape(
    'limit\\w*|queue\\w*|run on|froze\\w*|halt\\w*|restrict\\w*',
  ),
  shortage: shape(
    'queue\\w*|faces?|ran out|run out|ration\\w*|hit\\w*|spread\\w*',
  ),
  outbreak: shape(`cases?|confirm\\w*|infect\\w*|${HARM}`),
  mass_casualty: shape(HARM),
  fire: shape(
    `burn\\w*|broke out|contain\\w*|caus\\w+|ablaze|battl\\w+|spread\\w*|${DAMAGE}`,
  ),
});

// Opens with what is around the event, or with who is talking about it.
const BACKGROUND_OPENING =
  /^(?:["“‘]|while|as|after|despite|since|though|although|amid|following|why|how|what|who|are|is|can|will|should)\b/i;
const ACTOR_SPEAKS =
  /^(?:\S+\s+){0,5}(?:says?|said|urges?|wants?|asks?|calls?|claims?|insists?|accuses?|recommends?|disputes?|disputed)\b/i;
const POLITICS_OR_SPORT = compileTerms([
  'election*',
  'polls',
  'ballot',
  'voters',
  'midterm*',
  'parliament*',
  'goal',
  'assists',
  'season',
  'playoff*',
  'quarterfinal*',
  'Colorado Avalanche',
]);

/**
 * Whether the opening of a post shows an event of this kind happening.
 * @returns {?string} Why not, or null when it does (or cannot be judged).
 */
export function lacksIncident(text, subtype) {
  // The shapes are English; other scripts keep the rules' own sense of the event.
  if (/\p{Script=Cyrillic}/u.test(text)) return null;
  const opening = text
    .replace(/^[^\p{L}\p{N}"“‘]+/u, '')
    .slice(0, OPENING_CHARS);
  if (BACKGROUND_OPENING.test(opening)) return 'background';
  const toll = STATED_TOLL.test(opening);
  if (!toll && ACTOR_SPEAKS.test(opening)) return 'reaction';
  if (!toll && POLITICS_OR_SPORT.test(opening)) return 'off_topic';
  const shaped = EVENT_SHAPES[subtype];
  if (shaped && !shaped.test(opening) && !toll) return 'no_incident';
  return null;
}

/**
 * Why this is not a current report, or null if nothing says it is not.
 * @param {string} text
 * @param {{publishedAt?: number|string}} [options]
 * @returns {?string} retrospective, legal, business, sense, negative, analysis,
 *   reaction or forecast.
 */
export function notCurrent(text, { publishedAt } = {}) {
  if (publishedAt !== undefined && datedInThePast(text, publishedAt))
    return 'retrospective';
  for (const [frame, pattern] of Object.entries(HARD_FRAMES))
    if (pattern.test(text)) return frame;
  if (STATED_TOLL.test(text)) return null;
  if (/^(?:why|how|what|who|are|is|can|should)\b[^.!]*\?/i.test(text.trim()))
    return 'analysis';
  for (const [frame, pattern] of Object.entries(SOFT_FRAMES))
    if (pattern.test(text)) return frame;
  return null;
}
