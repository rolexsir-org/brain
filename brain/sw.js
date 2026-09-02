// Brain's offline app shell and notification-interaction worker.
// A service worker can display a notification after Brain has already scheduled
// it while running; it cannot wake itself at an arbitrary future time. There is
// intentionally no fake background scheduler or push subscription here.

const VERSION = 'brain-v2.1.2';
const CACHE = VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/caps.js', './js/install.js', './js/notify.js',
  './js/actions/external.js', './js/actions/system.js',
  './js/util/util.js', './js/util/date.js', './js/util/constants.js',
  './js/store/db.js', './js/store/store.js', './js/store/validate.js', './js/store/migrate.js',
  './js/engine/intent.js', './js/engine/actions.js', './js/engine/context.js', './js/engine/search.js',
  './js/ui/cards.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Never erase an unrelated app's cache when Brain is deployed beneath a
    // shared origin.
    await Promise.all(keys.filter(key => key.startsWith('brain-') && key !== CACHE).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || !request.url.startsWith(self.location.origin)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (request.mode === 'navigate') {
      try {
        const response = await fetch(request);
        if (response && response.ok) cache.put(request, response.clone()).catch(() => {});
        return response;
      } catch {
        return (await cache.match(request)) || (await cache.match('./index.html')) || new Response('Brain is offline. Open it once while online to install the app shell.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response && response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
      return response;
    } catch {
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});

self.addEventListener('notificationclick', event => {
  const reminderId = event.notification && event.notification.data && event.notification.data.reminderId;
  const action = event.action || 'open';
  if (event.notification) event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer the window the user is already using; a stale background client
    // should not steal a notification action from the visible Brain tab.
    const target = windows.find(client => client.focused)
      || windows.find(client => client.visibilityState === 'visible')
      || windows[0];
    if (target) {
      if (reminderId) {
        target.postMessage(action === 'open'
          ? { type: 'brain:reminder-open', reminderId }
          : { type: 'brain:reminder-action', action, reminderId });
      }
      await target.focus();
      return;
    }
    const url = new URL('./', self.registration.scope);
    // Carry a plain notification open too, so a newly opened Brain can show
    // the relevant local card instead of dropping the notification context.
    if (reminderId) {
      url.searchParams.set('brainReminderId', reminderId);
      if (action !== 'open') url.searchParams.set('brainReminderAction', action);
    }
    await self.clients.openWindow(url.href);
  })());
});
