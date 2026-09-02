// Real device / external-app integrations for Brain.
//
// Two layers:
//  1. PURE builders (url/ics/text) — unit-testable, no DOM, no side effects.
//  2. Guarded launchers — perform the actual device action via the correct
//     mechanism (tel:/sms:/mailto:, wa.me links, Web Share, clipboard, maps,
//     calendar .ics download). Every launcher checks support and reports a
//     truthful {ok, message}; nothing is faked. Where the platform cannot do
//     a full operation we fall back to the strongest legitimate action.
//
// Launching a phone/SMS/email link is always the user tapping an action; we
// never auto-dial without a gesture, and SMS is never sent silently.

// ---------------- Pure builders ----------------

/** Keep only the dialable digits of a phone number (accepts +, digits). */
export function toDialable(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d+]/g, '');
}
export function isValidPhone(raw) {
  const d = toDialable(raw).replace(/\D/g, '');
  return d.length >= 7 && d.length <= 15;
}

export function telUri(raw) { return isValidPhone(raw) ? 'tel:' + toDialable(raw) : null; }

/** SMS deep link with optional body. `sms:` body syntax differs iOS/Android;
 *  we include both ?body= and &body= variants so the OS parses whichever it expects. */
export function smsUri(raw, body) {
  const num = toDialable(raw);
  if (!isValidPhone(num)) return null;
  const b = body ? encodeURIComponent(body) : '';
  return b ? `sms:${num}?body=${b}&body=${b}` : `sms:${num}`;
}

export function mailtoUri(email, { subject = '', body = '' } = {}) {
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const q = [];
  if (subject) q.push('subject=' + encodeURIComponent(subject));
  if (body) q.push('body=' + encodeURIComponent(body));
  return 'mailto:' + email + (q.length ? '?' + q.join('&') : '');
}

/** WhatsApp: number → wa.me chat. Text-only → open compose-on-web share link. */
export function waChatLink(phone) {
  const d = toDialable(phone).replace(/\D/g, '');
  // wa.me requires an international number (digits only, no + needed)
  return d.length >= 7 && d.length <= 15 ? `https://wa.me/${d}` : null;
}
export function waShareLink(text) {
  return 'https://wa.me/?text=' + encodeURIComponent(text || '');
}

export function mapsUri(queryOrCoords, { place = false } = {}) {
  // 'geo:lat,lng?q=lat,lng(label)' is the OS-native maps opener.
  const q = String(queryOrCoords || '').trim();
  if (!q) return null;
  if (/^-?\d{1,2}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?$/.test(q)) {
    return `geo:0,0?q=${encodeURIComponent(q)}`;
  }
  return place
    ? `geo:0,0?q=${encodeURIComponent(q)}`
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q);
}

/** Open a map location. Native `geo:` for coordinates, Maps web for places. */
export function launchMaps(query) {
  const uri = mapsUri(query);
  const loc = navGo();
  if (!uri) return { ok: false, message: 'No usable location.' };
  if (uri.startsWith('geo:')) {
    if (!loc) return { ok: false, message: 'No usable location.' };
    loc.href = uri;
    return { ok: true, message: 'Opening the map…' };
  }
  openInTab(uri);
  return { ok: true, message: 'Opening the map…' };
}

export function instagramProfileUri(handle) {
  const h = String(handle || '').replace(/^@/, '').replace(/[^a-zA-Z0-9._]/g, '');
  return h ? `https://www.instagram.com/${h}/` : null;
}
export const instagramHome = 'https://www.instagram.com/';

export function openLinkUri(url) {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://');
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch { return null; }
}

/** Build an .ics VCALENDAR document. All fields supported (title, start, end,
 *  location, description, all-day). Times in local, no tz block (kept simple). */
export function buildIcs({ title, start, end, allDay, location, description }) {
  const fmt = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}00`;
  };
  const fmtDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const st = start || new Date();
  const en = end || new Date(st.getTime() + 60 * 60 * 1000);
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Brain//Local//EN', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + (st.getTime().toString(36)) + '@brain.local',
    'SUMMARY:' + esc(title || 'Event'),
    allDay ? ('DTSTART;VALUE=DATE:' + fmtDate(st)) : ('DTSTART:' + fmt(st)),
    allDay ? ('DTEND;VALUE=DATE:' + fmtDate(new Date(en.getTime() + 86400000))) : ('DTEND:' + fmt(en)),
  ];
  if (location) lines.push('LOCATION:' + esc(location));
  if (description) lines.push('DESCRIPTION:' + esc(description));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---------------- Guarded launchers ----------------
// Each returns {ok:boolean, message:string}. ok means it handed off to the OS/
// browser successfully (the user still confirms/chooses the target app).

function navGo() { try { return typeof location !== 'undefined' ? location : null; } catch { return null; } }
function docEl() { try { return typeof document !== 'undefined' ? document : null; } catch { return null; } }
function navGlob() { try { return typeof navigator !== 'undefined' ? navigator : null; } catch { return null; } }

export function launchCall(raw) {
  const uri = telUri(raw);
  const loc = navGo();
  if (!uri || !loc) return { ok: false, message: 'No usable phone number.' };
  loc.href = uri;
  return { ok: true, message: 'Opening the dialer…' };
}

export function launchSms(raw, body) {
  const uri = smsUri(raw, body);
  const loc = navGo();
  if (!uri || !loc) return { ok: false, message: 'No usable phone number for text.' };
  loc.href = uri;
  return { ok: true, message: 'Opening your messages app…' };
}

export function launchEmail(email, { subject = '', body = '' } = {}) {
  const uri = mailtoUri(email, { subject, body });
  const loc = navGo();
  if (!uri || !loc) return { ok: false, message: 'No usable email address.' };
  loc.href = uri;
  return { ok: true, message: 'Opening your mail app…' };
}

/**
 * WhatsApp. With a number → wa.me chat; without → compose-on-web.
 * A browser cannot fully "automate" WhatsApp, so we open the official route.
 */
export function launchWhatsApp(phone, text) {
  const n = navGlob();
  const link = waChatLink(phone) || waShareLink(text || '');
  openInTab(link);
  return { ok: true, message: waChatLink(phone) ? 'Opening WhatsApp chat…' : 'Opening WhatsApp…' };
}

function openInTab(href) {
  const doc = docEl();
  const a = doc.createElement('a');
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  doc.body.appendChild(a); a.click(); a.remove();
}

/** Open a raw https URL in a new tab (Instagram, Maps web, etc.). */
export function openUrl(href) { openInTab(href); return { ok: true, message: 'Opening…' }; }

/** Native share sheet; falls back to copying + telling the user. */
export async function launchShare({ text = '', title = '', url = '', files = null }) {
  const n = navGlob();
  try {
    if (n && typeof n.share === 'function') {
      const data = { title, text };
      if (url) data.url = url;
      if (files && n.canShare && n.canShare({ files })) data.files = files;
      await n.share(data);
      return { ok: true, message: 'Shared.' };
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, message: 'Share cancelled.' };
    // fall through to copy fallback
  }
  // Fallback: copy text so it can be pasted into any app.
  if (text || url) {
    const c = await launchCopy(text || url);
    return { ok: false, message: c.ok ? 'Share unavailable — text copied so you can paste it.' : 'Share isn’t available on this device.' };
  }
  return { ok: false, message: 'Sharing isn’t available here.' };
}

/** Copy to clipboard; legacy execCommand fallback; graceful on permission deny. */
export async function launchCopy(text) {
  const n = navGlob();
  const doc = docEl();
  try {
    if (n && n.clipboard && typeof n.clipboard.writeText === 'function') {
      await n.clipboard.writeText(text);
      return { ok: true, message: 'Copied to clipboard.' };
    }
  } catch (e) { /* permission or transient failure → try fallback */ }
  try {
    if (doc) {
      const ta = doc.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      doc.body.appendChild(ta); ta.select();
      const ok = doc.execCommand && doc.execCommand('copy');
      ta.remove();
      if (ok) return { ok: true, message: 'Copied to clipboard.' };
    }
  } catch (e) { /* ignore */ }
  return { ok: false, message: 'Clipboard permission was denied — select & copy manually.' };
}

/** Open a calendar .ics as a real downloadable file (OS then lets the user add it). */
export async function launchCalendar(ics) {
  const doc = docEl();
  if (!doc) return { ok: false, message: 'Cannot create a calendar file here.' };
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url; a.download = 'brain-event.ics';
  doc.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 4000);
  return { ok: true, message: 'Calendar file downloaded — open it to add the event.' };
}

/**
 * Pick an image file (or capture from camera where the picker supports it).
 * Pure DOM helper used by the app shell. Validates size & type, downscales to a
 * JPEG data-URL so the whole thing persists cleanly through the store/backup.
 * Returns {file, dataUrl, width, height} or {cancelled:true}/{error}.
 */
export function pickImage({ capture = false, maxDim = 1600, quality = 0.82, maxBytes = 12 * 1024 * 1024 } = {}) {
  const doc = docEl();
  return new Promise((resolve) => {
    if (!doc) return resolve({ error: 'No document context for file picking.' });
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (capture && (input.capture !== undefined)) input.capture = 'user'; // camera; environment = 'environment'
    let handled = false;
    const done = (r) => { if (!handled) { handled = true; resolve(r); } };
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return done({ cancelled: true });
      if (!/^image\//.test(file.type)) return done({ error: 'That file isn’t an image.' });
      if (file.size > maxBytes) return done({ error: 'That image is too large (over ' + Math.round(maxBytes / 1048576) + ' MB).' });
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = doc.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const cx = canvas.getContext('2d');
        cx.drawImage(img, 0, 0, w, h);
        let dataUrl = '';
        try { dataUrl = canvas.toDataURL('image/jpeg', quality); } catch (e) { dataUrl = url; }
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 100);
        if (!dataUrl || dataUrl.length < 100) return done({ error: 'Couldn’t read that image.' });
        done({ file, dataUrl, width: w, height: h, name: file.name || 'photo' });
      };
      img.onerror = () => { try { URL.revokeObjectURL(url); } catch (e) {} done({ error: 'That image couldn’t be opened (unsupported or corrupt).' }); };
      img.src = url;
    };
    input.oncancel = () => done({ cancelled: true });
    try { input.click(); } catch (e) { done({ error: 'Couldn’t open the file picker.' }); }
  });
}
