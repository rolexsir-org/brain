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

export async function registerSw(onUpdate) {
  try {
    if (!navigator.serviceWorker) return null;
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (reg) {
      reg.addEventListener('updatefound', ()=>{
        const inst = reg.installing;
        if (inst) inst.addEventListener('statechange', ()=>{
          if (inst.state==='installed' && navigator.serviceWorker.controller) {
            if (typeof onUpdate==='function') onUpdate(reg);
            else {
              const banner=document.createElement('div');
              banner.className='sw-update';
              banner.setAttribute('role','alert');
              const msg=document.createElement('span'); msg.textContent='Update available — new Brain version ready.';
              const btn=document.createElement('button'); btn.className='sw-reload'; btn.textContent='Reload';
              btn.addEventListener('click', ()=> window.location.reload());
              const dismiss=document.createElement('button'); dismiss.className='sw-later'; dismiss.textContent='Later';
              dismiss.addEventListener('click', ()=> banner.remove());
              banner.append(msg, btn, dismiss);
              document.body.append(banner);
            }
          }
        });
      });
      // If controller changes (new SW activated)
      navigator.serviceWorker.addEventListener('controllerchange', ()=>{
        // do not auto-reload; user confirms via banner
      });
    }
    return reg;
  } catch {
    return null;
  }
}

/**
 * In-page iOS instructions. A blocking window.alert() loses focus context and
 * is not announced consistently by screen readers, so use a real dialog with
 * Escape/backdrop dismissal and focus restoration.
 */
function showIosHelp(trigger) {
  const existing = document.getElementById('brain-ios-install-help');
  if (existing) { existing.querySelector('button')?.focus(); return; }
  const overlay = document.createElement('div');
  overlay.id = 'brain-ios-install-help';
  overlay.className = 'ios-help';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'brain-ios-install-title');

  const panel = document.createElement('div');
  panel.className = 'ios-help-panel';

  const title = document.createElement('h2');
  title.id = 'brain-ios-install-title';
  title.textContent = 'Add Brain to your Home Screen';

  const body = document.createElement('p');
  body.textContent = 'In Safari, tap the Share button, then choose “Add to Home Screen”. In Chrome on iOS the same option lives in the Share menu.';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Got it';

  const dismiss = () => {
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    try { if (trigger && typeof trigger.focus === 'function') trigger.focus(); } catch {}
  };
  const onKeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); return; }
    if (event.key !== 'Tab') return;
    // Only one focusable control exists; keep focus inside the dialog.
    event.preventDefault();
    close.focus();
  };

  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
  document.addEventListener('keydown', onKeydown, true);
  panel.append(title, body, close);
  overlay.append(panel);
  document.body.append(overlay);
  close.focus();
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
    if (isIOS()) showIosHelp(button);
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; refresh(); });
  refresh();
}

/** Accurate limitation copy; installation improves access but cannot create an alarm API. */
export function reminderCapability() {
  if (isStandalone()) return 'Brain can catch up and show reminders while the installed app receives time. iOS/Android may still suspend it, so background alarms are not guaranteed.';
  return 'Brain checks reminders while this page can run. Installing makes access easier, but web browsers cannot guarantee a closed-app alarm.';
}
