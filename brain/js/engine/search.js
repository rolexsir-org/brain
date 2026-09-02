// Global search across all collections. Tolerant of case, partials, names and
// dates. Returns grouped, relevance-ordered matches for a normalized query.

import { normStr, score } from '../util/util.js';

export function searchAll(q, store) {
  const needle = normStr(q);
  if (!needle) return [];
  const out = [];
  for (const col of ['task', 'reminder', 'note', 'person', 'money', 'debt', 'stockItem', 'habit', 'journal', 'event']) {
    const hits = [];
    for (const r of store.list(col)) {
      const s = relevance(col, r, needle, q);
      if (s > 0) hits.push({ r, s });
    }
    hits.sort((a, b) => b.s - a.s);
    for (const h of hits.slice(0, 12)) out.push({ type: col, record: h.r, score: h.s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

function relevance(col, r, needle, rawQ) {
  let hay = '';
  switch (col) {
    case 'task': hay = r.title + ' ' + r.note; break;
    case 'reminder': hay = r.title; break;
    case 'note': hay = r.title + ' ' + r.body; break;
    case 'person': hay = r.name + ' ' + r.phone + ' ' + r.relationship + ' ' + r.notes; break;
    case 'money': hay = r.category + ' ' + r.party + ' ' + r.amount; break;
    case 'debt': hay = r.person + ' ' + r.amount; break;
    case 'stockItem': hay = r.name; break;
    case 'habit': hay = r.name; break;
    case 'journal': hay = r.text + ' ' + r.mood; break;
    case 'event': hay = r.title + ' ' + (r.kind || ''); break;
  }
  let s = score(needle, normStr(hay));
  // give extra weight to name/title matches
  const titleHay = normStr(r.title || r.name || '');
  const ts = score(needle, titleHay);
  if (ts > 0) s = Math.max(s, ts + 2);
  return s;
}

export { normStr };
