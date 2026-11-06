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
