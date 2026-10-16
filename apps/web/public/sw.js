// LaborOps service worker:
//  - keeps the app shell (pages already visited, scripts, styles, icons) so the app opens with no signal,
//  - sends clock-ins/outs saved while offline as soon as there is a connection (Background Sync where supported),
//  - shows push notifications (plain and Declarative Web Push), keeps the app badge, and reports a tapped notification.
const SHELL = 'lo-shell-v2';
const OFFLINE = '/offline.html';
const PRECACHE = [OFFLINE, '/my-shifts', '/manifest.webmanifest', '/brand/icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { credentials: 'same-origin' })).catch(() => undefined)))),
  );
  self.skipWaiting();
});
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lo-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  ),
);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/platform')) return;
  // Build files never change under the same name: cache first.
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/brand/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
        return res;
      })),
    );
    return;
  }
  // Pages: network first (always fresh), the saved copy when offline, else the offline notice.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() =>
          caches.match(req, { ignoreSearch: true })
            .then((hit) => hit || caches.match('/my-shifts'))
            .then((hit) => hit || caches.match(OFFLINE))
            .then((r) => r || Response.error()),
        ),
    );
  }
});

// ---------- offline clock-in queue (same database as lib/punchQueue.ts) ----------
const DB = 'laborops';
const STORE = 'punches';
function openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'clientId' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
async function flushPunches() {
  const db = await openDb();
  const all = (await tx(db, 'readonly', (s) => s.getAll())) || [];
  all.sort((a, b) => a.savedAt - b.savedAt);
  for (const p of all) {
    let res;
    try {
      res = await fetch(p.kind === 'in' ? '/api/time/clock-in' : '/api/time/clock-out', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.body),
      });
    } catch {
      throw new Error('still offline'); // Background Sync tries again later
    }
    if (res.status === 401) throw new Error('signed out');
    if (res.ok) await tx(db, 'readwrite', (s) => s.delete(p.clientId));
    else {
      const j = await res.json().catch(() => ({}));
      await tx(db, 'readwrite', (s) => s.put({ ...p, error: j.error || `Error ${res.status}` }));
    }
  }
  const list = await self.clients.matchAll({ type: 'window' });
  list.forEach((c) => c.postMessage({ type: 'punches-flushed' }));
}
self.addEventListener('sync', (event) => {
  if (event.tag === 'lo-punches') event.waitUntil(flushPunches());
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'flush-punches') event.waitUntil(flushPunches().catch(() => undefined));
});

// ---------- push ----------
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: 'LaborOps', body: event.data ? event.data.text() : '' };
  }
  // Declarative Web Push messages carry everything under "notification".
  const n = d.notification || {};
  const title = d.title || n.title || 'LaborOps';
  const url = d.url || n.navigate || '/';
  const id = d.id || (n.data && n.data.id) || null;
  const badge = d.badge !== undefined ? Number(d.badge) : n.app_badge !== undefined ? Number(n.app_badge) : NaN;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: d.body || n.body || '',
        icon: '/brand/icon.png',
        badge: '/brand/icon.png',
        tag: d.tag || n.tag || 'laborops',
        data: { url, id },
      }),
      !isNaN(badge) && self.navigator.setAppBadge ? (badge > 0 ? self.navigator.setAppBadge(badge) : self.navigator.clearAppBadge()).catch(() => undefined) : undefined,
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/';
  // Tell the server it was opened: this also cancels a text waiting behind the push.
  const ack = data.id ? fetch(`/api/notifications/${data.id}/ack`, { method: 'POST', credentials: 'same-origin' }).catch(() => undefined) : Promise.resolve();
  event.waitUntil(
    Promise.all([
      ack,
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        for (const c of list) {
          if ('focus' in c) {
            c.navigate(url);
            return c.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
    ]),
  );
});
