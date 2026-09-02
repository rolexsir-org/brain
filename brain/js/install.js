// PWA installability detection + registration. Shows the install affordance
// only when it can actually do something, and never claims background push.

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}
export function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

export async function registerSw() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('sw.js'); } catch (e) { /* sw unavailable; app still works */ }
}

export function setupInstall(btn, onChange) {
  let deferredPrompt = null;
  const ready = () => { btn.hidden = isStandalone(); if (onChange) onChange(); };
  if (isStandalone()) { ready(); }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    ready();
  });
  btn.addEventListener('click', async () => {
    if (deferredPrompt) { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; ready(); return; }
    if (isIOS()) {
      alert('Tap Share → “Add to Home Screen” to install Brain.');
    }
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; ready(); });
  ready();
}

/** Human explanation of reminder capabilities for the UI. */
export function reminderCapability() {
  if (isStandalone()) return 'Running as an installed app, reminders fire while Brain is open or in the background.';
  return 'Reminders fire while this tab is open. Install Brain for more reliable background reminders.';
}
