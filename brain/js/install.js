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
              banner.setAttribute('role','alert');
              banner.style.cssText='position:fixed;bottom:16px;left:12px;right:12px;background:#0e131f;color:#fff;padding:10px 12px;border-radius:8px;z-index:9999;display:flex;gap:8px;align-items:center;justify-content:space-between;';
              const msg=document.createElement('span'); msg.textContent='Update available — new Brain version ready.';
              const btn=document.createElement('button'); btn.textContent='Reload'; btn.style.cssText='background:#3ecf8e;border:none;padding:6px 10px;border-radius:6px;cursor:pointer;color:#000;font-weight:600';
              btn.addEventListener('click', ()=> window.location.reload());
              const dismiss=document.createElement('button'); dismiss.textContent='Later'; dismiss.style.cssText='background:transparent;border:1px solid #fff;color:#fff;padding:6px 10px;border-radius:6px;cursor:pointer';
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
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'brain-ios-install-title');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(4,8,16,.72);display:flex;align-items:flex-end;justify-content:center;z-index:10000;padding:16px;';

  const panel = document.createElement('div');
  panel.style.cssText = 'background:#0e131f;color:#e9edf4;border:1px solid #26304a;border-radius:14px;padding:16px;max-width:420px;width:100%;line-height:1.5;';

  const title = document.createElement('h2');
  title.id = 'brain-ios-install-title';
  title.textContent = 'Add Brain to your Home Screen';
  title.style.cssText = 'margin:0 0 8px;font-size:17px;';

  const body = document.createElement('p');
  body.style.cssText = 'margin:0 0 14px;font-size:14px;color:#c8d0e0;';
  body.textContent = 'In Safari, tap the Share button, then choose “Add to Home Screen”. In Chrome on iOS the same option lives in the Share menu.';

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Got it';
  close.style.cssText = 'background:#3ecf8e;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;color:#000;font-weight:600;';

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
