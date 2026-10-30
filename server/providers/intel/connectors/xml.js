// Minimal, bounded reading of RSS/Atom feeds: the few tags connectors need,
// as plain text. Markup inside values is never interpreted.

const MAX_ITEMS = 2000;

// ASCII-only lower-casing keeps every index of the original text.
const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/**
 * Elements named `name` as `{attributes, inner}`, in document order, found
 * with plain index scans: linear in the text even when tags are unclosed
 * (a lazy regex rescans to the end from every unclosed open tag). Stops at
 * the first open tag without a closing tag.
 */
export function elements(text, name, max = MAX_ITEMS) {
  const source = String(text ?? '');
  const lower = asciiLower(source);
  const open = `<${asciiLower(name)}`;
  const close = `</${asciiLower(name)}>`;
  const out = [];
  let at = 0;
  while (out.length < max) {
    const start = lower.indexOf(open, at);
    if (start < 0) break;
    const next = lower[start + open.length];
    // `<item` must not match `<itemized`.
    if (next !== undefined && !/[\s>/]/.test(next)) {
      at = start + open.length;
      continue;
    }
    const headEnd = lower.indexOf('>', start);
    if (headEnd < 0) break;
    const attributes = source.slice(start + open.length, headEnd);
    if (attributes.endsWith('/')) {
      out.push({ attributes: attributes.slice(0, -1), inner: '' });
      at = headEnd + 1;
      continue;
    }
    const end = lower.indexOf(close, headEnd + 1);
    if (end < 0) break;
    out.push({ attributes, inner: source.slice(headEnd + 1, end) });
    at = end + close.length;
  }
  return out;
}

/** Top-level repeated blocks (`item`, `entry`) of a feed. */
export function blocks(xml, tag, max = MAX_ITEMS) {
  return elements(xml, tag, max).map((element) => element.inner);
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
  const [first] = elements(xml, name, 1);
  if (!first) return null;
  return decode(first.inner).trim();
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
