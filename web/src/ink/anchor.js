// Ink that sticks to text (pen layer over a typed page). blocks: the page's top-level blocks in order, each
// { top, sig } — top in logical canvas units, sig the start of its text. Pure functions, tested in server/test.

/** Anchor for a stroke whose highest point is minY: the block it starts in (or the nearest block with text). */
export function pickAnchor(blocks, minY) {
  if (!blocks.length) return null;
  let idx = 0;
  for (let i = 0; i < blocks.length; i++) if (blocks[i].top <= minY + 4) idx = i;
  for (let d = 0; d < blocks.length; d++) {
    if (idx - d >= 0 && blocks[idx - d].sig) return { sig: blocks[idx - d].sig, i: idx - d, y0: Math.round(blocks[idx - d].top * 10) / 10 };
    if (idx + d < blocks.length && blocks[idx + d].sig) return { sig: blocks[idx + d].sig, i: idx + d, y0: Math.round(blocks[idx + d].top * 10) / 10 };
  }
  return null;
}

/** How far the anchored block moved since the stroke was drawn (0 when the block is gone or was rewritten). */
export function anchorShift(blocks, anchor) {
  if (!anchor?.sig) return 0;
  // Several blocks with the same text: the one closest to where the ink was drawn.
  let best = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].sig === anchor.sig && (best < 0 || Math.abs(blocks[i].top - anchor.y0) < Math.abs(blocks[best].top - anchor.y0))) best = i;
  }
  return best < 0 ? 0 : blocks[best].top - anchor.y0;
}
