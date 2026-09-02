// Runtime capability detection for Brain's device-aware action system.
// Detection only observes APIs; permission prompts happen later from an explicit
// user gesture. A control should use this snapshot (or a fresh one) instead of
// assuming a desktop/mobile browser can perform an action.

const safe = callback => { try { return callback(); } catch { return undefined; } };
const getWindow = () => safe(() => typeof window === 'undefined' ? null : window) || null;
const getNavigator = () => safe(() => typeof navigator === 'undefined' ? null : navigator) || null;

export function isIOS(ua) {
  const n = getNavigator();
  const value = ua || (n && n.userAgent) || '';
  return /iphone|ipad|ipod/i.test(value) || (/macintosh/i.test(value) && !!(n && n.maxTouchPoints > 1));
}

export function isAndroid(ua) {
  const n = getNavigator();
  return /android/i.test(ua || (n && n.userAgent) || '');
}

export function isMobileUA(ua) {
  const n = getNavigator();
  return /mobi|android|iphone|ipad|ipod/i.test(ua || (n && n.userAgent) || '');
}

function supportsFileShare(n, w) {
  if (!n || typeof n.canShare !== 'function' || !w || typeof w.File !== 'function') return false;
  try {
    const file = new w.File(['Brain'], 'brain.txt', { type: 'text/plain' });
    return n.canShare({ files: [file] });
  } catch { return false; }
}

/** Return a side-effect-free snapshot; `env` makes this easy to unit-test. */
export function getCaps(env = {}) {
  const w = env.window || getWindow();
  const n = env.navigator || getNavigator();
  const d = env.document || (w && w.document) || null;
  const input = safe(() => d && d.createElement('input'));
  const ua = (n && n.userAgent) || '';
  const ios = isIOS(ua);
  // iPads in desktop-mode Safari report a Macintosh UA; isIOS covers that case.
  const mobile = isMobileUA(ua) || ios;
  const inputCapture = !!safe(() => input && ('capture' in input || input.capture !== undefined));
  const contactSelect = !!safe(() => n && n.contacts && typeof n.contacts.select === 'function');
  const online = n && typeof n.onLine === 'boolean' ? n.onLine : true;
  const serviceWorker = !!safe(() => n && n.serviceWorker);

  const caps = {
    platform: { online },
    notifications: {
      supported: !!(w && w.Notification),
      permission: safe(() => w && w.Notification ? w.Notification.permission || 'default' : 'unsupported') || 'unsupported',
      canRequest: !!safe(() => w && w.Notification && typeof w.Notification.requestPermission === 'function'),
      // Push API support is not a claim that Brain has a push server.
      pushApi: !!safe(() => w && w.PushManager)
    },
    sw: {
      supported: serviceWorker,
      controlled: !!safe(() => n && n.serviceWorker && n.serviceWorker.controller),
      ready: !!safe(() => n && n.serviceWorker && n.serviceWorker.ready)
    },
    share: {
      webShare: !!(n && typeof n.share === 'function'),
      shareFiles: supportsFileShare(n, w)
    },
    files: {
      picker: !!input,
      fileSystemAccess: !!safe(() => w && (typeof w.showOpenFilePicker === 'function' || typeof w.showSaveFilePicker === 'function')),
      savePicker: !!safe(() => w && typeof w.showSaveFilePicker === 'function'),
      // Desktop browsers may expose the HTML attribute but ignore it; only
      // advertise a camera-picker action on a mobile/iOS runtime.
      captureCamera: inputCapture && mobile
    },
    clipboard: {
      write: !!safe(() => n && n.clipboard && typeof n.clipboard.writeText === 'function'),
      legacyCopy: !!safe(() => d && typeof d.execCommand === 'function')
    },
    speech: {
      recognition: !!safe(() => w && (w.SpeechRecognition || w.webkitSpeechRecognition))
    },
    geolocation: {
      supported: !!safe(() => n && n.geolocation && typeof n.geolocation.getCurrentPosition === 'function')
    },
    contacts: { select: contactSelect }
  };
  return caps;
}
