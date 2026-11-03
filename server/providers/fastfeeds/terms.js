// Term lists to patterns. A trailing `*` matches any word ending, which is how
// the inflected Slavic forms are covered; `u?` means an optional letter.

const WORD = '[\\p{L}\\p{N}]';

const escapeTerm = (term) =>
  term
    .replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '*' : `\\${ch}`))
    // `\?` from a literal question mark in a pack stays literal; `u?` in our
    // own lists means an optional letter.
    .replace(/\\\?/g, '?')
    .replace(/\s+/g, '\\s+')
    .replace(/\*/g, '\\p{L}*');

/** One alternation of terms, on word boundaries in any script. */
export function compileTerms(terms) {
  if (!terms.length) return null;
  return new RegExp(
    `(?<!${WORD})(?:${terms.map(escapeTerm).join('|')})(?!${WORD})`,
    'iu',
  );
}
