/* Brigvanti service worker.
   Pages and app files: network first, so a deploy shows up on the next online open.
   The cached copy is used only when the network fails or takes longer than NET_TIMEOUT.
   Firebase SDK files are versioned in their URL, so they are served cache first.
   The coach, Netlify functions, Firestore, Auth and Analytics are never cached. */
const VERSION = 'brigvanti-v1';
const NET_TIMEOUT = 4000;
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/content/brigvanti-content.js',
  '/content/brigvanti-content.nl.js',
  '/content/brigvanti-strings.nl.js',
  '/Icons/app-icon-192.png',
  '/Icons/apple-touch-icon.png',
  '/Icons/favicon-32.png',
  '/Icons/favicon-32-dark.png'
];
const FIREBASE = [
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js',
  'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    /* One missing file must not block the install, so each file is added on its own. */
    await Promise.all([
      ...SHELL.map(u => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})),
      ...FIREBASE.map(u => cache.add(new Request(u, { mode: 'cors' })).catch(() => {}))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k.startsWith('brigvanti-') && k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

/* Race the network against a timer. A late network answer still refreshes the cache. */
async function networkFirst(request, cacheKey) {
  const cache = await caches.open(VERSION);
  const net = fetch(request).then(res => {
    if (res && res.ok && res.type === 'basic') cache.put(cacheKey, res.clone());
    return res;
  });
  net.catch(() => {});
  try {
    return await Promise.race([net, timeout(NET_TIMEOUT)]);
  } catch (e) {
    const hit = await cache.match(cacheKey) || (request.mode === 'navigate' ? await cache.match('/') : null);
    if (hit) return hit;
    return net;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  const res = await fetch(request);
  if (res && res.ok) cache.put(request.url, res.clone());
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/') || url.pathname.startsWith('/__/')) return;
    if (url.pathname === '/sw.js') return;
    if (req.mode === 'navigate') {
      const key = url.pathname === '/index.html' ? '/' : url.pathname;
      event.respondWith(networkFirst(req, key));
      return;
    }
    event.respondWith(networkFirst(req, url.pathname));
    return;
  }

  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    event.respondWith(cacheFirst(req));
  }
});
