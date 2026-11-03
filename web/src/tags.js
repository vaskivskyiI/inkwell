// Tags that mean the same thing are one tag: "IJSplus", "IJS plus", "ijs-plus" and "ijs_plus" are all "ijsplus" —
// case, spaces, hyphens, accents and a plural "s" do not count, and a one-letter slip in a longer tag is the same tag.
// Keep in step with server/src/util/tags.js.
export const tagKey = (t) => String(t || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').replace(/(?<=..)s$/, '');

/** A tag as it is written when typed or suggested: lowercase, spaces become hyphens. */
export const cleanTag = (t) => String(t || '').toLowerCase().replace(/^#/, '').trim().replace(/\s+/g, '-').slice(0, 40);

function near(a, b) {
  if (Math.min(a.length, b.length) < 6 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

/** The existing tag (known: most used first) that `tag` means, or the tag itself, cleaned. */
export function matchTag(tag, known) {
  const t = cleanTag(tag);
  const k = tagKey(t);
  if (!k) return '';
  return known.find((x) => tagKey(x) === k) || known.find((x) => near(tagKey(x), k)) || t;
}
