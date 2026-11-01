// Inkwell as an installed app. Chrome, Edge and Android hand over their install prompt; Safari on iPhone and iPad
// installs from the share sheet ("Add to Home Screen"). Once installed, other apps can share photos, files, text and
// links to it (manifest share_target): the service worker keeps them until the share page takes them.
import { store, toast } from './store.js';

let deferred = null;

export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
export const iosDevice = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function initPwa() {
  // Needs https (or localhost).
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; store.set({ canInstall: true }); });
  window.addEventListener('appinstalled', () => { deferred = null; store.set({ canInstall: false }); toast('Inkwell is installed as an app'); });
}

/** Shows the browser's install dialog; true when the person accepted. */
export async function installApp() {
  if (!deferred) return false;
  deferred.prompt();
  const { outcome } = await deferred.userChoice;
  deferred = null;
  store.set({ canInstall: false });
  return outcome === 'accepted';
}

const SHARE = 'inkwell-share';

/** What another app shared with Inkwell: { title, text, url, files: File[] }, or null. */
export async function takeShared() {
  if (typeof caches === 'undefined') return null;
  const c = await caches.open(SHARE);
  const meta = await c.match('/shared/meta');
  if (!meta) return null;
  const m = await meta.json();
  const files = [];
  for (let i = 0; i < m.files; i++) {
    const r = await c.match(`/shared/${i}`);
    if (r) files.push(new File([await r.blob()], decodeURIComponent(r.headers.get('x-name') || `file-${i + 1}`), { type: r.headers.get('content-type') || '' }));
  }
  return { title: m.title, text: m.text, url: m.url, files };
}

export async function clearShared() {
  if (typeof caches !== 'undefined') await caches.delete(SHARE);
}
