// Shared pure helpers.
export function uid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

/** Set an absolute ceiling on how old/random an id prefix can be avoided; ids are only local. */

/** Money formatting with explicit sign and locale. */
export function formatMoney(n, { currency = '₹', locale = 'en-IN', cents = false } = {}) {
  if (n == null || Number.isNaN(+n)) return '';
  const neg = +n < 0;
  const v = Math.abs(+n);
  const opts = { maximumFractionDigits: cents ? 2 : 0 };
  if (cents) opts.minimumFractionDigits = 2;
  let s;
  try { s = v.toLocaleString(locale, opts); } catch { s = String(Math.round(v)); }
  return (neg ? '-' : '') + currency + s;
}

/** Compact inline money used inside sentences (no surrounding). */
export function moneyToken(n) {
  const neg = n < 0 ? '-' : '';
  return neg + Math.abs(Math.round(n)).toLocaleString('en-IN');
}

/** Parse a human number out of a string: strip grouping, handle "5k"/"2 thousand". */
export function parseNum(raw) {
  if (raw == null) return NaN;
  const str = String(raw).trim();
  if (str === '') return NaN;
  let t = str.replace(/,/g, '');
  const m = t.match(/-?\d+(?:\.\d+)?/);
  if (!m) return NaN;
  let v = parseFloat(m[0]);
  const lower = t.toLowerCase();
  if (/k\b/.test(lower) || / thousand/.test(lower)) v *= 1000;
  return v;
}

const CAP_FIRST = /^(mr|mrs|ms|dr|sir|bro|sis|aunty|uncle)\.?\s+/i;

/** Clean a person's name: strip honorifics, normalize spaces, keep case. */
export function cleanName(raw) {
  let s = String(raw || '').trim().replace(CAP_FIRST, '').replace(/\s+/g, ' ').trim();
  return s;
}

/** Return the base locale language code, e.g. 'hi'. */
export function langOf(locale) { return (locale || 'en').split('-')[0].toLowerCase(); }

export function normStr(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(); }

/**
 * Lightweight contains/search scoring between a normalized query and a value.
 * Returns a score (higher better) or 0 when no meaningful match.
 */
export function score(needleNorm, hayNorm) {
  if (!needleNorm || !hayNorm) return 0;
  if (hayNorm === needleNorm) return 10;
  if (hayNorm.startsWith(needleNorm)) return 8;
  if (hayNorm.includes(needleNorm)) return 6;
  // tolerate when the query is the full word but hay is a phrase we appear in at a token boundary
  const tokens = hayNorm.split(/\s+/);
  if (tokens.includes(needleNorm)) return 7;
  return 0;
}

/** Debounce. */
export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

/** Throttle leading. */
export function throttle(fn, ms) {
  let last = 0, timer;
  return (...a) => {
    const now = Date.now();
    if (now - last >= ms) { last = now; fn(...a); }
    else { clearTimeout(timer); timer = setTimeout(() => { last = Date.now(); fn(...a); }, ms - (now - last)); }
  };
}

/** Simple deep clone safe for plain JSON-able state. */
export function clone(obj) { return obj == null ? obj : JSON.parse(JSON.stringify(obj)); }

export function todayKey(d = new Date()) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}

export function nowISO() { return new Date().toISOString(); }

/** Bounded string to guard against absurdly long inputs. */
export function clampStr(s, max = 5000) { return String(s || '').slice(0, max); }

// ------- XSS-safe rendering -------

/** Escape HTML special chars for text nodes injected as HTML. */
export function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build DOM nodes from a trusted, tiny template DSL — no innerHTML for
 * user content. Only a whitelisted set of tags/attributes is allowed.
 * Returns a DocumentFragment.
 *
 * Template arrays: ["tag", {attr: val|fn, ...}, child|text, child, ...]
 * attr value 'true' → boolean attribute; handler functions are attached as events.
 */
export function el(tag, attrs, ...children) {
  const doc = (typeof document !== 'undefined') ? document : null;
  const node = doc.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      }
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) { appendChildren(node, c); continue; }
    if (c.nodeType) node.appendChild(c);
    else node.appendChild(document.createTextNode(String(c)));
  }
}

/** Return an element factory bound to a tag for ergonomic templates. */
export function h(tag) { return (attrs, ...kids) => el(tag, attrs, ...kids); }

export const nodes = new Proxy({}, {
  get: (_t, tag) => (attrs, ...kids) => el(String(tag), attrs, ...kids)
});

/** Parse an ISO date string to a Date safely (never throw / never Invalid that stays silent). */
export function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
