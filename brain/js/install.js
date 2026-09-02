// PWA installation and service-worker registration. The install button remains
// hidden until the browser gives Brain a real action (beforeinstallprompt), with
// the one honest exception of iOS's documented Add-to-Home-Screen instructions.

export function isStandalone() {
  try {
    return !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true);
  } catch { return false; }
}

export function isIOS() {
  try {
    const ua = navigator.userAgent || '';
    return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  } catch { return false; }
}

export async function registerSw() {
  try {
    if (!navigator.serviceWorker) return null;
    return await navigator.serviceWorker.register('./sw.js', { scope: './' });
  } catch {
    // Offline core functionality still works without a service worker.
    return null;
  }
}

export function setupInstall(button, onChange) {
  if (!button) return;
  let deferredPrompt = null;
  const refresh = () => {
    const canGuideIos = isIOS() && !isStandalone();
    const actionable = !!deferredPrompt || canGuideIos;
    button.hidden = !actionable || isStandalone();
    button.setAttribute('aria-hidden', button.hidden ? 'true' : 'false');
    button.title = deferredPrompt ? 'Install Brain' : 'How to add Brain to your Home Screen';
    if (onChange) onChange({ actionable, deferredPrompt: !!deferredPrompt, iosGuide: canGuideIos });
  };
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredPrompt = event;
    refresh();
  });
  button.addEventListener('click', async () => {
    if (deferredPrompt) {
      try { await deferredPrompt.prompt(); await deferredPrompt.userChoice; } catch {}
      deferredPrompt = null;
      refresh();
      return;
    }
    if (isIOS()) window.alert('On iPhone or iPad, use your browser’s Share menu, then choose “Add to Home Screen”. In Safari this is Share → Add to Home Screen.');
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; refresh(); });
  refresh();
}

/** Accurate limitation copy; installation improves access but cannot create an alarm API. */
export function reminderCapability() {
  if (isStandalone()) return 'Brain can catch up and show reminders while the installed app receives time. iOS/Android may still suspend it, so background alarms are not guaranteed.';
  return 'Brain checks reminders while this page can run. Installing makes access easier, but web browsers cannot guarantee a closed-app alarm.';
}
