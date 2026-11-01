// Photos between devices: a phone takes the picture, the device that shows the page puts it at its cursor. The
// server offers each uploaded photo as a drop; the tab showing the page claims it (this tab at once, a tab in front
// soon, others a little later), else the server adds it at the end of the page.
import { useEffect } from 'react';
import { get, post, upload } from './api.js';
import { onEvent } from './data.js';
import { toast, toastError } from './store.js';

/** This browser tab, so it can tell its own requests from those of the user's other devices. */
export const TAB = Math.random().toString(36).slice(2, 10);
export const touchDevice = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export const naturalSize = (file) => new Promise((res) => {
  const url = URL.createObjectURL(file);
  const i = new window.Image();
  i.onload = () => { res({ w: i.naturalWidth, h: i.naturalHeight }); URL.revokeObjectURL(url); };
  i.onerror = () => { res({ w: 4, h: 3 }); URL.revokeObjectURL(url); };
  i.src = url;
});

/** Opens the camera (phones) or a file picker; resolves with the picture or null. Must run in a click handler. */
export function pickPhoto({ camera = true } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.setAttribute('capture', 'environment');
    input.style.display = 'none';
    input.onchange = () => { resolve(input.files[0] || null); input.remove(); };
    input.oncancel = () => { resolve(null); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

/** Uploads a picture for a page and lets the device showing it place it. */
export async function sendPhoto(file, note, { wait = true } = {}) {
  if (!file) return null;
  const busy = toast('Sending the photo…', { duration: 60000 });
  try {
    const size = await naturalSize(file);
    const a = await upload(file, { noteId: note.id });
    const r = await post(`/api/notes/${note.id}/drop`, { assetId: a.id, w: size.w, h: size.h, from: TAB, wait });
    busy?.dismiss?.();
    toast(r.placed === 'device' ? `Photo added to “${note.title || 'Untitled'}”` : `Photo added at the end of “${note.title || 'Untitled'}”`);
    return r;
  } catch (e) { busy?.dismiss?.(); toastError(e); return null; }
}

/** Takes a photo and sends it to a page. */
export const photoTo = async (note, opts) => sendPhoto(await pickPhoto(opts), note);

/** The page another device of this user is working on, if any. */
export const captureTarget = () => get('/api/capture/target').then((r) => r.target).catch(() => null);

/** Asks the user's phone (any touch device with Inkwell open) to take a photo for this page. */
export const requestPhoto = (note) => post(`/api/notes/${note.id}/capture-request`, { from: TAB })
  .then(() => toast('Open Inkwell on your phone: it offers the camera for this page', { duration: 6000 })).catch(toastError);

/** Tells the server which page this device works on, while it is in front. */
export function useActivePage(noteId, enabled) {
  useEffect(() => {
    if (!enabled) return undefined;
    const report = () => { if (document.visibilityState === 'visible') post('/api/me/active', { noteId }).catch(() => {}); };
    report();
    const t = setInterval(report, 5 * 60000);
    window.addEventListener('focus', report);
    document.addEventListener('visibilitychange', report);
    return () => { clearInterval(t); window.removeEventListener('focus', report); document.removeEventListener('visibilitychange', report); };
  }, [noteId, enabled]);
}

/** Claims photos dropped on this page and hands them to `place(url, size)`. */
export function useDrops(noteId, place, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    return onEvent((m) => {
      if (m.type !== 'note:drop' || m.noteId !== noteId) return;
      const delay = m.from === TAB ? 0 : document.hasFocus() ? 100 : 800;
      setTimeout(async () => {
        try {
          const { ok } = await post(`/api/drops/${m.dropId}/claim`);
          if (!ok) return;
          place(m.asset.url, m.size, m.asset.name);
          if (m.from !== TAB) toast('A photo arrived from your other device');
        } catch { /* the server places it */ }
      }, delay);
    });
  }, [noteId, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
}
