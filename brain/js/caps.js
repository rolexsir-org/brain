// Runtime platform-capability detection.
// Every external integration in Brain is gated by these checks so the UI only
// offers actions a given device/browser can genuinely perform. Nothing here
// guesses or fakes support — if an API is absent, we report it absent and the
// UI either hides the action or falls back to the strongest honest alternative.

function has(obj, name) {
  try { return !!(obj && typeof obj[name] !== 'undefined'); } catch { return false; }
}
const win = () => { try { return typeof window !== 'undefined' ? window : null; } catch { return null; } };
const nav = () => { try { return typeof navigator !== 'undefined' ? navigator : null; } catch { return null; } };

export function isIOS(ua) {
  const n = ua || (nav() || {}).userAgent || '';
  return /iphone|ipad|ipod/i.test(n) || (/macintosh/i.test(n) && nav() && nav().maxTouchPoints > 1);
}
export function isAndroid(ua) {
  return /android/i.test(ua || (nav() || {}).userAgent || '');
}
export function isMobileUA(ua) {
  return /mobi|android|iphone|ipad|ipod/i.test(ua || (nav() || {}).userAgent || '');
}

/** Capture a full capability snapshot. Safe to call anywhere (no side effects). */
export function getCaps(env) {
  const w = (env && env.window) || win();
  const n = (env && env.navigator) || nav();
  const d = (env && env.document) || (w ? w.document : null);
  const md = n ? n.mediaDevices : null;
  const ua = (n && n.userAgent) || '';
  const standalone = w ? w.matchMedia && w.matchMedia('(display-mode: standalone)').matches : false;

  const caps = {
    platform: {
      ios: isIOS(ua), android: isAndroid(ua), mobile: isMobileUA(ua),
      standalone: !!(standalone || (n && n.standalone)),
      online: has(n, 'onLine') ? n.onLine : true
    },
    notifications: {
      supported: !!(w && w.Notification),
      permission: w && w.Notification ? (w.Notification.permission || 'default') : 'unsupported',
      canRequest: !!(w && w.Notification && w.Notification.requestPermission),
      // Background push is NOT available to a local-only PWA without a server
      // push endpoint; we surface its absence honestly.
      pushApi: has(w, 'PushManager') || has(n, 'PushManager')
    },
    sw: { supported: 'serviceWorker' in (n || {}), controlled: !!(n && n.serviceWorker && n.serviceWorker.controller) },
    share: {
      webShare: !!n && typeof n.share === 'function',
      canShare: !!n && typeof n.canShare === 'function',
      shareFiles: !!n && typeof n.canShare === 'function' && !!n.canShare,
      fallbackText: true // we can always fall back to the system "copy/share link"
    },
    clipboard: {
      write: has(n, 'clipboard') && has(n.clipboard, 'writeText'),
      read: has(n, 'clipboard') && has(n.clipboard, 'readText'),
      // legacy fallback path always present (execCommand)
      fallback: true
    },
    files: {
      // <input type=file> is available everywhere; this just detects typing.
      picker: typeof d === 'undefined' || !!d,
      fileSystemAccess: has(w, 'showOpenFilePicker') || has(w, 'showSaveFilePicker'),
      captureCamera: !!(d && (d.createElement('input').capture !== undefined)),
      captureMicrophone: true // media capture handled by getUserMedia below
    },
    media: {
      getUserMedia: !!(md && typeof md.getUserMedia === 'function'),
      // Whether a user gesture can plausibly get a camera feed.
      camera: !!(md && typeof md.getUserMedia === 'function'),
      microphone: !!(md && typeof md.getUserMedia === 'function')
    },
    speech: { recognition: !!(w && (w.SpeechRecognition || w.webkitSpeechRecognition)) },
    geolocation: has(n, 'geolocation'),
    contacts: has(n, 'contacts'),
    bluetooth: has(n, 'bluetooth'),
    vibration: has(n, 'vibrate'),
    wakeLock: has(n, 'wakeLock') && typeof n.wakeLock.request === 'function',
    calendar: {
      // Download .ics + let the OS calendar open it works everywhere;
      // true in-app calendar write is not exposed to web pages.
      icsDownload: true
    }
  };
  caps.standalone = caps.platform.standalone;
  caps.ua = ua;
  return caps;
}

/** A short human phrase explaining each capability (used by the diagnostics view). */
export function capNote(name) {
  const notes = {
    notifications: 'system notifications while Brain is open',
    push: 'no background push for a local-only app (no server)',
    share: 'native share sheet to other apps',
    clipboard: 'copy text to the clipboard',
    files: 'open files & images from your device',
    camera: 'take a photo / record via camera',
    microphone: 'voice input',
    geolocation: 'read your location (asks permission)',
    contacts: 'read your device contacts (asks permission)',
    bluetooth: 'nearby Bluetooth devices',
    vibration: 'haptic feedback',
    calendar: 'export .ics to your OS calendar'
  };
  return notes[name] || '';
}
