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
      await el.requestFullscreen({ navigationUI: 'hide' });
      const off = () => { if (document.fullscreenElement !== el) { document.removeEventListener('fullscreenchange', off); onChange?.(false); } };
      document.addEventListener('fullscreenchange', off);
      onChange?.(true);
      return;
    } catch { /* fall back below */ }
  }
  el.classList.add('fs-fallback');
  const esc = (e) => { if (e.key === 'Escape') { el.classList.remove('fs-fallback'); document.removeEventListener('keydown', esc); onChange?.(false); } };
  document.addEventListener('keydown', esc);
  onChange?.(true);
}
