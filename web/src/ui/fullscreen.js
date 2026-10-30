// Full screen for an element (a canvas, a page). Browsers without the Fullscreen API for ordinary elements
// (iPhone Safari) get a CSS fallback: the element is fixed over the whole window.
export function isFullscreen(el) {
  return !!el && (document.fullscreenElement === el || el.classList.contains('fs-fallback'));
}

export async function toggleFullscreen(el, onChange) {
  if (!el) return;
  if (isFullscreen(el)) {
    if (document.fullscreenElement === el) await document.exitFullscreen().catch(() => {});
    el.classList.remove('fs-fallback');
    onChange?.(false);
    return;
  }
  if (el.requestFullscreen) {
    try {
      // Embedded browsers may neither enter full screen nor report failure: do not wait for them for long.
      await Promise.race([el.requestFullscreen({ navigationUI: 'hide' }), new Promise((r) => { setTimeout(r, 600); })]);
      if (document.fullscreenElement === el) {
        const off = () => { if (document.fullscreenElement !== el) { document.removeEventListener('fullscreenchange', off); onChange?.(false); } };
        document.addEventListener('fullscreenchange', off);
        onChange?.(true);
        return;
      }
    } catch { /* fall back below */ }
  }
  el.classList.add('fs-fallback');
  const esc = (e) => { if (e.key === 'Escape') { el.classList.remove('fs-fallback'); document.removeEventListener('keydown', esc); onChange?.(false); } };
  document.addEventListener('keydown', esc);
  onChange?.(true);
}

/**
 * Full screen for a canvas: the page's header stays on top, everything else but the canvas goes away.
 * Data attributes, not classes: React rewrites class names of these elements when it re-renders.
 */
export function toggleCanvasFullscreen(canvas, onChange) {
  const view = canvas?.closest('.note-view');
  if (!view) return;
  const off = () => { delete view.dataset.canvasFull; delete canvas.dataset.canvasTarget; };
  const wasOn = isFullscreen(view);
  if (wasOn) off();
  else { view.dataset.canvasFull = '1'; canvas.dataset.canvasTarget = '1'; }
  toggleFullscreen(view, (on) => { if (!on) off(); onChange?.(on); });
}

/** The canvas a page really is: a journal's paper, or its only drawing. Null when it has more content. */
export function pageCanvas(view) {
  const journal = view.querySelector('.journal');
  if (journal) return journal;
  const pm = view.querySelector('.ProseMirror');
  const full = [...(pm?.children || [])].filter((c) => c.textContent.trim() || c.querySelector('img, canvas, audio, table, hr'));
  return full.length === 1 ? full[0].querySelector('.ink-block') : null;
}
