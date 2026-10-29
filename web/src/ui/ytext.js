import { useEffect, useState, useCallback } from 'react';

/** Applies a new string to a Y.Text as one minimal edit (common prefix/suffix kept), so co-editors don't clash. */
export function applyText(ytext, next) {
  const cur = ytext.toString();
  if (cur === next) return;
  let a = 0;
  while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
  let b = 0;
  while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
  ytext.doc.transact(() => {
    if (cur.length - a - b > 0) ytext.delete(a, cur.length - a - b);
    if (next.length - a - b > 0) ytext.insert(a, next.slice(a, next.length - b));
  });
}

export function useYText(ytext) {
  const [value, setValue] = useState(() => ytext?.toString() || '');
  useEffect(() => {
    if (!ytext) return undefined;
    const on = () => setValue(ytext.toString());
    on();
    ytext.observe(on);
    return () => ytext.unobserve(on);
  }, [ytext]);
  const set = useCallback((v) => { if (ytext) applyText(ytext, v); }, [ytext]);
  return [value, set];
}

/** Re-render on any change of a Y type (map/array). */
export function useYObserve(ytype) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!ytype) return undefined;
    const on = () => setN((n) => n + 1);
    ytype.observe(on);
    return () => ytype.unobserve(on);
  }, [ytype]);
}
