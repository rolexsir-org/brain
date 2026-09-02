// Legitimate browser/device integrations used by Brain.
//
// These functions only hand off after an explicit user gesture. They never claim
// that a browser sent a message, posted to a social network, added a calendar
// item, or scheduled background work when the browser merely opened a chooser.
// Builders at the top are side-effect free and are deliberately kept separate
// from the guarded launchers below.

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_STORED_IMAGE_BYTES = 4_750_000;
const RASTER_IMAGE_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'image/heic', 'image/heif', 'image/bmp'
]);

// ---------- Pure URI / file builders ----------

/** Convert a human phone number to a conservative dial string. */
export function toDialable(raw) {
  if (raw == null) return '';
  let value = String(raw).trim().replace(/^tel:/i, '');
  const hasPlus = value.startsWith('+');
  value = value.replace(/\D/g, '');
  return value ? (hasPlus ? '+' : '') + value : '';
}

export function phoneDigits(raw) { return toDialable(raw).replace(/\D/g, ''); }

export function isValidPhone(raw) {
  const digits = phoneDigits(raw);
  return digits.length >= 7 && digits.length <= 15;
}

export function telUri(raw) {
  const number = toDialable(raw);
  return isValidPhone(number) ? `tel:${number}` : null;
}

/**
 * Build an SMS URI. iOS uses `&body=` after a recipient while Android and most
 * other handlers use `?body=`. Supplying {ios:true} chooses the documented iOS
 * form; launchSms detects it at runtime.
 */
export function smsUri(raw, body = '', { ios = false } = {}) {
  const number = toDialable(raw);
  if (!isValidPhone(number)) return null;
  if (!body) return `sms:${number}`;
  return `sms:${number}${ios ? '&' : '?'}body=${encodeURIComponent(String(body))}`;
}

export function mailtoUri(email, { subject = '', body = '' } = {}) {
  const value = String(email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null;
  const query = [];
  if (subject) query.push(`subject=${encodeURIComponent(String(subject))}`);
  if (body) query.push(`body=${encodeURIComponent(String(body))}`);
  // Keep the @ readable while escaping URI delimiters that could otherwise
  // reinterpret part of an unusual-but-valid local address as a query string.
  const recipient = encodeURIComponent(value).replace(/%40/ig, '@');
  return `mailto:${recipient}${query.length ? `?${query.join('&')}` : ''}`;
}

/** Normalize a number for WhatsApp only when its country code is known. */
export function whatsappNumber(raw, countryCode = '') {
  const number = toDialable(raw);
  if (!isValidPhone(number)) return null;
  if (number.startsWith('+')) return phoneDigits(number);
  const cc = String(countryCode || '').replace(/\D/g, '');
  if (!cc || cc.length > 3) return null;
  const digits = phoneDigits(number);
  // A user may have saved the country code without the plus already.
  return digits.startsWith(cc) ? digits : cc + digits;
}

/** Official wa.me conversation URL. WhatsApp itself still asks the user to send. */
export function waChatLink(phone, text = '', options = {}) {
  if (text && typeof text === 'object') { options = text; text = ''; }
  const number = whatsappNumber(phone, options.countryCode || '');
  if (!number) return null;
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(String(text))}` : ''}`;
}

/** Official WhatsApp web/share route. It cannot target an arbitrary contact. */
export function waShareLink(text = '') {
  return `https://wa.me/?text=${encodeURIComponent(String(text || ''))}`;
}

/** A standards-safe https URL, or null. */
export function openLinkUri(url) {
  try {
    const parsed = new URL(String(url || ''));
    return /^https?:$/.test(parsed.protocol) ? parsed.href : null;
  } catch { return null; }
}

/** Build either a Maps search link or an external directions link. */
export function mapsUri(queryOrCoords, { directions = false, origin = '' } = {}) {
  const query = String(queryOrCoords || '').trim();
  if (!query) return null;
  if (directions) {
    const params = new URLSearchParams({ api: '1', destination: query });
    if (origin) params.set('origin', String(origin));
    return `https://www.google.com/maps/dir/?${params.toString()}`;
  }
  // An HTTPS Maps URL works in a desktop browser as well as an installed maps
  // app. A geo: URI has no dependable desktop fallback, so do not expose it.
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function instagramProfileUri(handle) {
  const clean = String(handle || '').trim().replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  return clean ? `https://www.instagram.com/${clean}/` : null;
}

export const instagramHome = 'https://www.instagram.com/';

function asDate(value, fallback = null) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value.getTime());
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

function icsDate(value) {
  const d = asDate(value, new Date());
  const two = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
}

function icsDateTime(value) {
  const d = asDate(value, new Date());
  const two = n => String(n).padStart(2, '0');
  // Deliberately a floating local time: Brain does not invent a timezone.
  return `${icsDate(d)}T${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}
function icsUtcDateTime(value) {
  const d = asDate(value, new Date());
  const two = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
}

// RFC 5545 lines should be folded at 75 octets. Use a conservative 74-byte
// boundary so the continuation-space also fits; fall back to code-unit length
// only in very old runtimes without TextEncoder.
function foldIcsLine(line) {
  const bytesFor = char => {
    try { return typeof TextEncoder === 'function' ? new TextEncoder().encode(char).length : char.length; } catch { return char.length; }
  };
  const limit = 74;
  const out = [];
  let part = '';
  let bytes = 0;
  for (const char of String(line)) {
    const size = bytesFor(char);
    if (part && bytes + size > limit) {
      out.push(part);
      part = ` ${char}`;
      bytes = 1 + size;
    } else {
      part += char;
      bytes += size;
    }
  }
  out.push(part);
  return out.join('\r\n');
}

/** Build an interoperable local-time .ics event. DTEND is exclusive for all-day events. */
export function buildIcs({ title = 'Event', start, end, allDay = false, location = '', description = '' } = {}) {
  const started = asDate(start, new Date());
  let ended = asDate(end, null);
  if (!ended || ended <= started) ended = new Date(started.getTime() + (allDay ? 86400000 : 3600000));
  const uid = `${started.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}@brain.local`;
  const stamp = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Brain//Local-only PWA//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${icsUtcDateTime(stamp)}`,
    `SUMMARY:${icsEscape(title)}`,
    allDay ? `DTSTART;VALUE=DATE:${icsDate(started)}` : `DTSTART:${icsDateTime(started)}`,
    allDay ? `DTEND;VALUE=DATE:${icsDate(ended)}` : `DTEND:${icsDateTime(ended)}`
  ];
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return `${lines.map(foldIcsLine).join('\r\n')}\r\n`;
}

// ---------- Runtime helpers ----------

function getDocument() { try { return typeof document !== 'undefined' ? document : null; } catch { return null; } }
function getNavigator() { try { return typeof navigator !== 'undefined' ? navigator : null; } catch { return null; } }
function getLocation() { try { return typeof location !== 'undefined' ? location : null; } catch { return null; } }
function getWindow() { try { return typeof window !== 'undefined' ? window : null; } catch { return null; } }

function isIosRuntime() {
  const n = getNavigator();
  const ua = (n && n.userAgent) || '';
  return /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && n && n.maxTouchPoints > 1);
}

function fileArray(files) {
  if (!files) return [];
  const list = Array.isArray(files) ? files : [files];
  return list.filter(file => file && typeof file === 'object' && typeof file.name === 'string');
}

/**
 * Open an external https URL. Normal actions use a new, protected tab from the
 * tap gesture. An async permission result (such as current location) can opt
 * into same-tab navigation because browsers may no longer allow a new popup
 * after the permission callback resolves.
 */
export function openUrl(url, { sameTab = false } = {}) {
  const href = openLinkUri(url);
  const doc = getDocument();
  if (!href || !doc || !doc.body) return { ok: false, message: 'That link is not available here.' };
  try {
    if (sameTab) {
      const loc = getLocation();
      if (!loc) return { ok: false, message: 'That link is not available here.' };
      loc.href = href;
      return { ok: true, message: 'Opening…' };
    }
    const anchor = doc.createElement('a');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.style.display = 'none';
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return { ok: true, message: 'Opening…' };
  } catch {
    return { ok: false, message: 'Your browser blocked that link.' };
  }
}

export function launchCall(raw) {
  const href = telUri(raw);
  const loc = getLocation();
  if (!href || !loc) return { ok: false, message: 'No usable phone number.' };
  try {
    loc.href = href;
    return { ok: true, message: 'Opening the dialer…' };
  } catch { return { ok: false, message: 'This browser could not open the dialer.' }; }
}

export function launchSms(raw, body = '') {
  const href = smsUri(raw, body, { ios: isIosRuntime() });
  const loc = getLocation();
  if (!href || !loc) return { ok: false, message: 'No usable phone number for a text.' };
  try {
    loc.href = href;
    return { ok: true, message: 'Opening your messages composer…' };
  } catch { return { ok: false, message: 'This browser could not open Messages.' }; }
}

export function launchEmail(email, options = {}) {
  const href = mailtoUri(email, options);
  const loc = getLocation();
  if (!href || !loc) return { ok: false, message: 'No usable email address.' };
  try {
    loc.href = href;
    return { ok: true, message: 'Opening your mail composer…' };
  } catch { return { ok: false, message: 'This browser could not open a mail composer.' }; }
}

/** Open WhatsApp’s official route; this does not send or automate a message. */
export function launchWhatsApp(phone, text = '', options = {}) {
  const direct = waChatLink(phone, text, options);
  const result = openUrl(direct || waShareLink(text));
  if (!result.ok) return result;
  return {
    ok: true,
    message: direct
      ? 'Opening WhatsApp — review and send the message there.'
      : 'Opening WhatsApp’s share page — choose a recipient there.'
  };
}

export function launchMaps(query, { directions = false, origin = '', sameTab = false } = {}) {
  const href = mapsUri(query, { directions, origin });
  if (!href) return { ok: false, message: 'No usable location.' };
  const result = openUrl(href, { sameTab });
  return result.ok ? { ok: true, message: directions ? 'Opening directions…' : 'Opening Maps…' } : result;
}

/** Request the foreground location only after an explicit user action. */
export function getCurrentLocation({ timeout = 10_000, maximumAge = 60_000 } = {}) {
  const n = getNavigator();
  if (!n || !n.geolocation) return Promise.resolve({ ok: false, message: 'Location is not available in this browser.' });
  return new Promise(resolve => {
    n.geolocation.getCurrentPosition(
      pos => resolve({ ok: true, latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      err => {
        const message = err && err.code === 1 ? 'Location permission was denied.'
          : err && err.code === 3 ? 'Location timed out. Try again outdoors.'
            : 'Could not get your location.';
        resolve({ ok: false, message });
      },
      { enableHighAccuracy: false, timeout, maximumAge }
    );
  });
}

/** Copy with a legacy fallback. A denied permission is reported rather than hidden. */
export async function launchCopy(text) {
  const value = String(text ?? '');
  const n = getNavigator();
  const doc = getDocument();
  try {
    if (n && n.clipboard && typeof n.clipboard.writeText === 'function') {
      await n.clipboard.writeText(value);
      return { ok: true, message: 'Copied to clipboard.' };
    }
  } catch { /* try the documented legacy path below */ }
  try {
    if (doc && doc.body && typeof doc.execCommand === 'function') {
      const textarea = doc.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.setAttribute('aria-label', 'Text to copy');
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      doc.body.appendChild(textarea);
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      const copied = doc.execCommand('copy');
      textarea.remove();
      if (copied) return { ok: true, message: 'Copied to clipboard.' };
    }
  } catch { /* report below */ }
  return { ok: false, message: 'Clipboard permission was denied — select and copy it manually.' };
}

function canShareFiles(n, files) {
  try { return !!(n && typeof n.canShare === 'function' && n.canShare({ files })); } catch { return false; }
}

/** Save a Blob with File System Access when available, otherwise download it. */
export async function saveBlob(blob, filename, { types = [] } = {}) {
  const w = getWindow();
  const doc = getDocument();
  try {
    if (w && typeof w.showSaveFilePicker === 'function') {
      const handle = await w.showSaveFilePicker({
        suggestedName: filename,
        types: types.length ? types : undefined
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return { ok: true, method: 'picker', message: 'File saved.' };
    }
  } catch (error) {
    if (error && error.name === 'AbortError') return { ok: false, cancelled: true, message: 'Save cancelled.' };
    // A download remains a legitimate fallback when the optional picker fails.
  }
  if (!doc || !doc.body || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { ok: false, message: 'This browser cannot save files.' };
  }
  try {
    const url = URL.createObjectURL(blob);
    const anchor = doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 15_000);
    return { ok: true, method: 'download', message: 'File downloaded.' };
  } catch {
    return { ok: false, message: 'This browser could not save that file.' };
  }
}

export async function downloadFile(file) {
  if (!file || typeof file !== 'object') return { ok: false, message: 'No file to save.' };
  if (typeof Blob !== 'function') return { ok: false, message: 'This browser cannot prepare a file for download.' };
  const blob = file instanceof Blob ? file : new Blob([file], { type: file.type || 'application/octet-stream' });
  return saveBlob(blob, file.name || 'brain-file');
}

/**
 * Open the native share sheet. When a browser cannot share a requested file we
 * preserve the file by downloading it; when only text is present we copy it.
 */
export async function launchShare({ text = '', title = '', url = '', files = null } = {}) {
  const n = getNavigator();
  const safeUrl = url ? openLinkUri(url) : '';
  const list = fileArray(files);
  const base = { title: String(title || ''), text: String(text || '') };
  if (safeUrl) base.url = safeUrl;

  if (n && typeof n.share === 'function') {
    if (list.length && canShareFiles(n, list)) {
      try {
        await n.share({ ...base, files: list });
        return { ok: true, message: 'Shared.' };
      } catch (error) {
        if (error && error.name === 'AbortError') return { ok: false, cancelled: true, message: 'Share cancelled.' };
        // Do not silently strip the image and say it was shared.
      }
    } else if (!list.length) {
      try {
        await n.share(base);
        return { ok: true, message: 'Shared.' };
      } catch (error) {
        if (error && error.name === 'AbortError') return { ok: false, cancelled: true, message: 'Share cancelled.' };
      }
    }
  }

  if (list.length) {
    const saved = await Promise.all(list.map(downloadFile));
    const allSaved = saved.every(item => item.ok);
    if (text || safeUrl) await launchCopy(text || safeUrl);
    return {
      ok: false,
      message: allSaved
        ? 'This browser cannot share that file — a copy was downloaded instead.'
        : 'This browser cannot share that file. Try saving it first.'
    };
  }
  if (text || safeUrl) {
    const copied = await launchCopy(text || safeUrl);
    return {
      ok: false,
      message: copied.ok ? 'Native sharing is unavailable — the text was copied so you can paste it.' : 'Sharing is not available on this device.'
    };
  }
  return { ok: false, message: 'There is nothing to share.' };
}

/** Download a real .ics file; an external calendar still needs user confirmation. */
export async function launchCalendar(ics, filename = 'brain-event.ics') {
  if (!String(ics || '').includes('BEGIN:VCALENDAR')) return { ok: false, message: 'Could not create that calendar event.' };
  if (typeof Blob !== 'function') return { ok: false, message: 'This browser cannot prepare a calendar file.' };
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const result = await saveBlob(blob, filename, {
    types: [{ description: 'Calendar event', accept: { 'text/calendar': ['.ics'] } }]
  });
  if (!result.ok) return result;
  return { ok: true, message: 'Calendar file saved — open it and confirm the event in your calendar.' };
}

// ---------- Device pickers ----------

function imageTypeAllowed(file) {
  const type = String(file && file.type || '').toLowerCase();
  // SVG is intentionally excluded: Brain stores raster photos, not executable-ish documents.
  return RASTER_IMAGE_TYPES.has(type);
}
function jpegFileName(value) {
  const name = String(value || 'photo').trim().replace(/[\\/:*?"<>|]+/g, '-');
  const base = name.replace(/\.[a-z0-9]{1,10}$/i, '').trim() || 'photo';
  return `${base}.jpg`;
}

/**
 * Open the native photo picker (or camera when capture is requested). The image
 * is decoded, safely downscaled, converted to a durable data URL, and every
 * temporary object URL is revoked. A cancellation is a normal result.
 */
export function pickImage({
  capture = false,
  captureMode = 'environment',
  maxDim = 1600,
  quality = 0.82,
  maxBytes = MAX_IMAGE_BYTES,
  maxStoredBytes = MAX_STORED_IMAGE_BYTES
} = {}) {
  const doc = getDocument();
  const w = getWindow();
  return new Promise(resolve => {
    if (!doc || !doc.body || !w) {
      resolve({ error: 'Photo picking is not available in this context.' });
      return;
    }
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic,image/heif,image/bmp';
    if (capture && 'capture' in input) input.setAttribute('capture', captureMode === 'user' ? 'user' : 'environment');
    input.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0';
    input.setAttribute('aria-hidden', 'true');
    doc.body.appendChild(input);

    let settled = false;
    let focusTimer = null;
    let watchingFocus = false;
    const cancelIfEmpty = () => {
      focusTimer = setTimeout(() => {
        if (!settled && !(input.files && input.files.length)) finish({ cancelled: true });
      }, 350);
    };
    const finish = value => {
      if (settled) return;
      settled = true;
      if (focusTimer) clearTimeout(focusTimer);
      if (watchingFocus) w.removeEventListener('focus', cancelIfEmpty);
      input.onchange = null;
      input.oncancel = null;
      try { input.remove(); } catch {}
      resolve(value);
    };
    const watchForCancel = () => {
      if (settled) return;
      watchingFocus = true;
      w.addEventListener('focus', cancelIfEmpty, { once: true });
    };

    input.addEventListener('cancel', () => finish({ cancelled: true }), { once: true });
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) { finish({ cancelled: true }); return; }
      if (!imageTypeAllowed(file)) {
        finish({ error: 'Choose a supported photo (JPEG, PNG, WebP, GIF, AVIF, HEIC, or BMP).' });
        return;
      }
      if (!Number.isFinite(file.size) || file.size <= 0) {
        finish({ error: 'That image file is empty or unreadable.' });
        return;
      }
      if (file.size > maxBytes) {
        finish({ error: `That image is too large (over ${Math.round(maxBytes / 1048576)} MB).` });
        return;
      }
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
        finish({ error: 'This browser cannot read image files.' });
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      const ImageCtor = w.Image || globalThis.Image;
      if (!ImageCtor) {
        try { URL.revokeObjectURL(objectUrl); } catch {}
        finish({ error: 'This browser cannot decode image files.' });
        return;
      }
      const image = new ImageCtor();
      image.onload = () => {
        try {
          const sourceWidth = Number(image.naturalWidth || image.width);
          const sourceHeight = Number(image.naturalHeight || image.height);
          if (!sourceWidth || !sourceHeight) throw new Error('invalid dimensions');
          const scale = Math.min(1, Math.max(1, maxDim) / Math.max(sourceWidth, sourceHeight));
          const width = Math.max(1, Math.round(sourceWidth * scale));
          const height = Math.max(1, Math.round(sourceHeight * scale));
          const canvas = doc.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext && canvas.getContext('2d');
          if (!context) throw new Error('canvas unavailable');
          context.drawImage(image, 0, 0, width, height);
          const dataUrl = canvas.toDataURL('image/jpeg', Math.min(0.95, Math.max(0.4, quality)));
          if (!/^data:image\/jpeg;base64,/.test(dataUrl) || dataUrl.length < 100) throw new Error('encode failed');
          if (dataUrl.length > maxStoredBytes) throw new Error('stored image too large');
          try { URL.revokeObjectURL(objectUrl); } catch {}
          finish({
            file,
            dataUrl,
            width,
            height,
            name: jpegFileName(file.name),
            mime: 'image/jpeg',
            size: dataUrl.length
          });
        } catch (error) {
          try { URL.revokeObjectURL(objectUrl); } catch {}
          finish({ error: error && error.message === 'stored image too large'
            ? 'That photo is still too large after compression. Choose a smaller image.'
            : 'That image could not be read. Try another supported photo.' });
        }
      };
      image.onerror = () => {
        try { URL.revokeObjectURL(objectUrl); } catch {}
        finish({ error: 'That image is unsupported or corrupt.' });
      };
      image.src = objectUrl;
    };

    // Chromium and Safari do not consistently emit `cancel`; focus returning
    // after the native picker closes is the strongest non-invasive fallback.
    setTimeout(watchForCancel, 0);
    try { input.click(); } catch { finish({ error: 'Could not open the photo picker.' }); }
  });
}

/** Use the Contacts Picker API only where the browser explicitly exposes it. */
export async function pickDeviceContacts({ multiple = true } = {}) {
  const n = getNavigator();
  if (!n || !n.contacts || typeof n.contacts.select !== 'function') {
    return { ok: false, unsupported: true, message: 'This browser does not expose device contacts. You can still save contact details in Brain.' };
  }
  try {
    const selected = await n.contacts.select(['name', 'tel', 'email'], { multiple });
    const contacts = (selected || []).map(contact => ({
      name: Array.isArray(contact.name) ? contact.name[0] : contact.name || '',
      phone: Array.isArray(contact.tel) ? contact.tel[0] : contact.tel || '',
      email: Array.isArray(contact.email) ? contact.email[0] : contact.email || ''
    })).filter(contact => contact.name || contact.phone || contact.email);
    return { ok: true, contacts };
  } catch (error) {
    if (error && error.name === 'AbortError') return { ok: false, cancelled: true, message: 'Contact picking cancelled.' };
    if (error && error.name === 'NotAllowedError') return { ok: false, denied: true, message: 'Contacts permission was denied.' };
    return { ok: false, message: 'Could not open the device contacts picker.' };
  }
}

export const IMAGE_LIMITS = { maxBytes: MAX_IMAGE_BYTES, maxStoredBytes: MAX_STORED_IMAGE_BYTES };
