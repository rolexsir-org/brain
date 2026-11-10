// Brain's offline app shell and notification-interaction worker.
// A service worker can display a notification after Brain has already scheduled
// it while running; it cannot wake itself at an arbitrary future time. There is
// intentionally no fake background scheduler or push subscription here.

const VERSION = 'brain-v2.4.0'; // bump on each release; old brain-* caches auto-cleaned
const CACHE = VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/app.css',
  './js/app.js', './js/caps.js', './js/install.js', './js/notify.js',
  './js/actions/external.js', './js/actions/system.js',
  './js/util/util.js', './js/util/date.js', './js/util/constants.js',
  './js/store/db.js', './js/store/store.js', './js/store/validate.js', './js/store/migrate.js',
  './js/engine/intent.js', './js/engine/actions.js', './js/engine/context.js', './js/engine/search.js',
  './js/ui/cards.js', './js/ui/commandCentre.js', './js/ui/automationCentre.js', './js/ui/diagnostics.js',
  './js/util/crypto.js', './js/instagram/config.js', './js/instagram/auth.js', './js/instagram/api.js', './js/instagram/media.js', './js/instagram/publish.js', './js/instagram/ui.js', './js/instagram/stateMachine.js', './js/instagram/automation.js', './js/instagram/queue.js', './js/instagram/coverPicker.js', './js/instagram/insights.js', './js/instagram/mediaTransfer.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];

const NAVIGATION_TIMEOUT_MS = 8000;

/** Resolve with the network response, or reject once the budget is spent. */
async function fetchWithTimeout(request, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(request, controller ? { signal: controller.signal } : undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Cache each asset independently: one missing file must not leave Brain
    // without any offline shell at all.
    const results = await Promise.allSettled(ASSETS.map(asset => cache.add(asset)));
    const failed = results.filter(result => result.status === 'rejected').length;
    if (failed) console.warn(`Brain service worker: ${failed} of ${ASSETS.length} assets failed to precache`);
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
        const response = await fetchWithTimeout(request, NAVIGATION_TIMEOUT_MS);
        // Cache the single app shell URL rather than every query string a
        // launch URL might carry (reminder ids, OAuth params), which would grow
        // CacheStorage without bound.
        if (response && response.ok) cache.put(new Request('./index.html'), response.clone()).catch(() => {});
        return response;
      } catch {
        return (await cache.match(request, { ignoreSearch: true }))
          || (await cache.match('./index.html'))
          || new Response('Brain is offline. Open it once while online to install the app shell.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    }
    const cached = await cache.match(request);
    if (cached) {
      // Serve immediately, then refresh in the background so a hotfix reaches
      // installed clients without waiting for the next cache version. A rejected
      // refresh is expected offline and must stay harmless.
      fetch(request)
        .then(response => {
          if (response && response.ok && response.type === 'basic') cache.put(request, response.clone()).catch(() => {});
        })
        .catch(() => {});
      return cached;
    }
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
