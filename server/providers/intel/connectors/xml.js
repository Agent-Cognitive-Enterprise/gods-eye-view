// Minimal, bounded reading of RSS/Atom feeds: the few tags connectors need,
// as plain text. Markup inside values is never interpreted.

const MAX_ITEMS = 2000;

/** Top-level repeated blocks (`item`, `entry`) of a feed. */
export function blocks(xml, tag, max = MAX_ITEMS) {
  const out = [];
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let match;
  while ((match = pattern.exec(xml)) && out.length < max) out.push(match[1]);
  return out;
}

const decode = (text) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** Text of the first `<tag>` (namespace prefix included in `tag`), or null. */
export function tag(xml, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `<${escaped}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${escaped}>)`,
    'i',
  ).exec(xml);
  if (!match) return null;
  return decode(match[1] ?? '').trim();
}

/** An attribute of the first `<tag>`, or null. */
export function attr(xml, name, attribute) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const element = new RegExp(`<${escaped}\\b([^>]*)>`, 'i').exec(xml);
  if (!element) return null;
  const value = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, 'i').exec(
    element[1],
  );
  return value ? decode(value[1]) : null;
}

/** Markup to plain text. */
export function text(markup) {
  return String(markup ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
