// Offline shell: the app loads without a connection — the page and every built file it needs are cached on install
// and again whenever a newer app is loaded. Data is kept by the app itself (IndexedDB); the only /api answers kept
// here are page files (pictures, attachments), so they show offline too. Signing out deletes that cache.
const CACHE = 'inkwell-shell-v3';
const FILES = 'inkwell-files';
// What another app shared with Inkwell (the share sheet on a phone), until the app has taken it.
const SHARE = 'inkwell-share';
const STATIC = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

// The page and the files it names (scripts, styles: their names carry a content hash).
async function cacheShell(res) {
  const c = await caches.open(CACHE);
  const html = await res.clone().text();
  const urls = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
  await Promise.all([...urls, ...STATIC].map((u) => c.match(u).then((hit) => hit || c.add(u)).catch(() => {})));
  await c.put('/', res);
}

self.addEventListener('install', (e) => {
  e.waitUntil(fetch('/', { cache: 'no-store' }).then((r) => (r.ok ? cacheShell(r) : null)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![CACHE, SHARE, FILES].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const c = await caches.open(SHARE);
    for (const k of await c.keys()) await c.delete(k);
    const files = form.getAll('files').filter((f) => f && typeof f !== 'string' && f.size);
    await Promise.all(files.map((f, i) => c.put(`/shared/${i}`, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || `file-${i + 1}`) } }))));
    const meta = { title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', files: files.length, at: Date.now() };
    await c.put('/shared/meta', new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  } catch { /* the share page then says nothing arrived */ }
  return Response.redirect('/#/share', 303);
}

// The server is down when it does not answer, or the proxy in front of it answers for it.
const down = (r) => r.status >= 502 && r.status <= 504;

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  if (e.request.method === 'POST' && url.pathname === '/share-target') { e.respondWith(receiveShare(e.request)); return; }
  if (e.request.method !== 'GET') return;
  // Page files: from the server while it answers (access is checked there), the kept copy without it.
  if (/^\/api\/assets\/[\w-]+/.test(url.pathname) && !url.searchParams.has('download')) {
    e.respondWith(fetch(e.request).then((r) => {
      if (down(r)) throw new Error('down');
      if (r.ok && r.status === 200) { const copy = r.clone(); caches.open(FILES).then((c) => c.put(e.request, copy)).catch(() => {}); }
      return r;
    }).catch(() => caches.open(FILES).then((c) => c.match(e.request)).then((hit) => hit || Response.error())));
    return;
  }
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/assets/') || STATIC.includes(url.pathname)) {
    // Built files have the content hash in their name: never stale.
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => {
      if (down(r)) throw new Error('down');
      if (r.ok && url.pathname === '/') e.waitUntil(cacheShell(r.clone()).catch(() => {}));
      return r;
    }).catch(async () => (await caches.match('/')) || Response.error()));
  }
});
