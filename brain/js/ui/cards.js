// Inline entity cards rendered into the chat. All DOM is built via the safe
// nodes factory (never innerHTML with user data). Actions mutate the store and
// then call ctx.refresh() to re-render.

import { nodes as E, formatMoney, todayKey } from '../util/util.js';
import { fmtHM } from '../util/date.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function humanDate(ctx, iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d2 = new Date(d); d2.setHours(0, 0, 0, 0);
  const diff = Math.round((d2 - today) / 86400000);
  let prefix = '';
  if (diff === 0) prefix = 'today'; else if (diff === 1) prefix = 'tomorrow'; else if (diff === -1) prefix = 'yesterday';
  else if (diff > 1 && diff < 30) prefix = `in ${diff} days`;
  return (prefix ? prefix + ' · ' : '') + (MONTHS[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : ''));
}

export function kindIcon(kind) {
  const m = { task: '✅', reminder: '🔔', note: '📝', person: '👤', money: '💰', debt: '💸', stockItem: '📦', habit: '🔥', journal: '📔', event: '📅', photo: '📷' };
  return m[kind] || '•';
}

function mini(label, cls, onClick) {
  const b = E.button({ class: 'mini' + (cls ? ' ' + cls : ''), type: 'button' }, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

/** A device-action button routed through the universal action system. */
function dev(ctx, label, id, args, cls) {
  return mini(label, cls || '', () => { if (ctx.runAction) ctx.runAction({ id, label, args }); });
}
const hasEmail = e => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const hasAddr = e => typeof e === 'string' && e.trim().length > 3;

export function entityCard(ctx, kind, id) {
  const rec = ctx.store.list(kind).find(x => x.id === id);
  if (!rec) return null;
  const card = E.div({ class: 'card' });
  const head = E.div({ class: 'k' }, E.span({}, kindIcon(kind)), E.span({}, kind.toUpperCase()));
  card.append(head);
  const meta = E.div({ class: 'meta' });
  const acts = E.div({ class: 'act' });

  switch (kind) {
    case 'task': {
      card.append(E.div({ class: 't' }, rec.status === 'done' ? '✓ ' + (rec.title || '') : rec.title || ''));
      if (rec.due) meta.append('Due ' + humanDate(ctx, rec.due));
      acts.append(rec.status !== 'done' ? mini('Done', 'g', () => { ctx.store.updateSync('task', id, { status: 'done', completedAt: new Date().toISOString() }); ctx.afterMutate(); }) :
        mini('Reopen', '', () => { ctx.store.updateSync('task', id, { status: 'open', completedAt: null }); ctx.afterMutate(); }));
      if (rec.due) acts.append(dev(ctx, 'Calendar', 'calendar', { title: rec.title || 'Task', start: rec.due, end: new Date(new Date(rec.due).getTime() + 3600000).toISOString() }));
      acts.append(mini('Edit', '', () => ctx.edit('task', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('task', id); ctx.afterMutate(); }));
      break;
    }
    case 'reminder': {
      card.append(E.div({ class: 't' }, rec.title || ''));
      if (rec.recur) meta.append(recurText(rec.recur));
      else if (rec.at) meta.append(humanDate(ctx, rec.at) + (rec.at ? ' · ' + fmtHM(new Date(rec.at).getHours(), new Date(rec.at).getMinutes()) : ''));
      acts.append(mini('Done', 'g', () => { ctx.store.updateSync('reminder', id, { status: 'done' }); ctx.afterMutate(); }));
      acts.append(mini('Snooze 10m', '', () => snooze(ctx, rec)));
      if (rec.at) acts.append(dev(ctx, 'Calendar', 'calendar', { title: rec.title || 'Reminder', start: rec.at, end: new Date(new Date(rec.at).getTime() + 600000).toISOString() }));
      acts.append(mini('Edit', '', () => ctx.edit('reminder', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('reminder', id); ctx.afterMutate(); }));
      break;
    }
    case 'note': {
      card.append(E.div({ class: 't' }, (rec.private ? '🔒 ' : '') + (rec.title || 'Note')));
      meta.append(E.div({ style: 'white-space:pre-wrap' }, rec.body || ''));
      if (rec.private) meta.append(E.div({ class: 'att' }, 'Private — stays on this device'));
      const body = rec.body || rec.title || '';
      acts.append(dev(ctx, 'Share', 'share', { title: rec.title || 'Note', text: body }));
      acts.append(dev(ctx, 'Copy', 'copy', { text: body }));
      acts.append(mini('Edit', '', () => ctx.edit('note', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('note', id); ctx.afterMutate(); }));
      break;
    }
    case 'photo': {
      card.append(E.div({ class: 't' }, (rec.name || 'Photo')));
      if (rec.width && rec.height) meta.append(`${rec.width}×${rec.height}`);
      if (rec.dataUrl) card.append(E.img({ class: 'thumb', src: rec.dataUrl, alt: rec.name || 'photo' }));
      acts.append(mini('View', 'g', () => ctx.viewPhoto(id)));
      acts.append(dev(ctx, 'Share', 'share', { title: rec.name || 'Photo', text: 'Photo from Brain', files: photoFile(rec) }));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('photo', id); ctx.afterMutate(); }));
      break;
    }
    case 'journal': {
      card.append(E.div({ class: 't' }, (rec.mood ? moodEmoji(rec.mood) + ' ' : '') + humanDate(ctx, rec.date)));
      const ph = rec.photoId ? ctx.store.list('photo').find(p => p.id === rec.photoId) : null;
      if (ph && ph.dataUrl) {
        card.append(E.img({ class: 'thumb', src: ph.dataUrl, alt: 'photo' }));
        acts.append(mini('View photo', 'g', () => ctx.viewPhoto(ph.id)));
      }
      meta.append(rec.text || '');
      acts.append(dev(ctx, 'Share', 'share', { title: 'Journal', text: rec.text || '' }));
      acts.append(mini('Edit', '', () => ctx.edit('journal', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('journal', id); ctx.afterMutate(); }));
      break;
    }
    case 'person': {
      card.append(E.div({ class: 't' }, rec.name || ''));
      if (rec.phone) meta.append(E.div({ class: 'contact' }, '📞 ' + rec.phone));
      if (rec.email) meta.append(E.div({ class: 'contact' }, '✉️ ' + rec.email));
      if (rec.address) meta.append(E.div({ class: 'contact' }, '📍 ' + rec.address));
      if (rec.birthday) meta.append('🎂 ' + rec.birthday);
      if (rec.relationship) meta.append(' · ' + rec.relationship);
      if (rec.notes) meta.append(E.div({}, rec.notes));
      // Every displayed value is actionable.
      if (rec.phone) {
        acts.append(dev(ctx, 'Call', 'call', { number: rec.phone }, 'g'));
        acts.append(dev(ctx, 'WhatsApp', 'whatsapp', { number: rec.phone }, 'wa'));
        acts.append(dev(ctx, 'Text', 'sms', { number: rec.phone }));
        acts.append(dev(ctx, 'Copy', 'copy', { text: rec.phone }));
      }
      if (hasEmail(rec.email)) acts.append(dev(ctx, 'Email', 'email', { email: rec.email }));
      if (hasAddr(rec.address)) acts.append(dev(ctx, 'Maps', 'maps', { query: rec.address }));
      acts.append(mini('Edit', '', () => ctx.edit('person', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('person', id); ctx.afterMutate(); }));
      break;
    }
    case 'money': {
      const sign = rec.kind === 'income' ? '+' : '−';
      card.append(E.div({ class: 't' }, `${sign} ${formatMoney(rec.amount, ctx.cur)}`));
      meta.append((rec.category || rec.kind) + (rec.date ? ' · ' + humanDate(ctx, rec.date) : ''));
      const line = `${rec.category || rec.kind}: ${sign === '+' ? 'income' : 'expense'} ${formatMoney(rec.amount, ctx.cur)}`;
      acts.append(dev(ctx, 'Share', 'share', { title: rec.category || 'Money', text: line }));
      acts.append(dev(ctx, 'Copy', 'copy', { text: line }));
      acts.append(mini('Edit', '', () => ctx.edit('money', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('money', id); ctx.afterMutate(); }));
      break;
    }
    case 'debt': {
      const who = rec.dir === 'they_owe_me' ? rec.person + ' owes you' : 'You owe ' + rec.person;
      card.append(E.div({ class: 't' }, who));
      meta.append(formatMoney(rec.amount, ctx.cur));
      if (rec.status === 'settled') meta.append(' · settled');
      acts.append(mini(rec.status === 'settled' ? 'Unsettle' : 'Settle', rec.status === 'settled' ? '' : 'g', () => {
        ctx.store.updateSync('debt', id, { status: rec.status === 'settled' ? 'open' : 'settled', settledAt: rec.status === 'settled' ? null : new Date().toISOString() });
        ctx.afterMutate();
      }));
      const dline = `${who}: ${formatMoney(rec.amount, ctx.cur)}`;
      acts.append(dev(ctx, 'Copy', 'copy', { text: dline }));
      acts.append(mini('Edit', '', () => ctx.edit('debt', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('debt', id); ctx.afterMutate(); }));
      break;
    }
    case 'stockItem': {
      card.append(E.div({ class: 't' }, `${rec.qty} ${rec.unit} ${rec.name}`));
      if (rec.lowThreshold != null && rec.qty <= rec.lowThreshold) meta.append('⚠️ Low');
      acts.append(mini('+1', '', () => bump(ctx, 'stockItem', id, 1, rec.unit)));
      acts.append(mini('−1', 'r', () => bump(ctx, 'stockItem', id, -1, rec.unit)));
      acts.append(mini('Edit', '', () => ctx.edit('stockItem', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('stockItem', id); ctx.afterMutate(); }));
      break;
    }
    case 'habit': {
      card.append(E.div({ class: 't' }, rec.name));
      meta.append(streak(rec.log) + ' day streak');
      acts.append(mini('Log today', 'g', () => { const log = rec.log.concat([todayKey()]); ctx.store.updateSync('habit', id, { log: Array.from(new Set(log)) }); ctx.afterMutate(); }));
      acts.append(mini('Edit', '', () => ctx.edit('habit', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('habit', id); ctx.afterMutate(); }));
      break;
    }
    case 'event': {
      card.append(E.div({ class: 't' }, rec.title || ''));
      meta.append((rec.kind ? rec.kind + ' · ' : '') + (rec.at ? humanDate(ctx, rec.at) : 'no date'));
      if (rec.at) {
        acts.append(dev(ctx, 'Calendar', 'calendar', { title: rec.title || 'Event', start: rec.at, end: new Date(new Date(rec.at).getTime() + 3600000).toISOString(), location: '', description: rec.kind || '' }));
        acts.append(dev(ctx, 'Share', 'share', { title: rec.title || 'Event', text: `${rec.title || 'Event'} on ${humanDate(ctx, rec.at)}` }));
      }
      acts.append(mini('Edit', '', () => ctx.edit('event', id)));
      acts.append(mini('Delete', 'r', () => { ctx.store.removeSync('event', id); ctx.afterMutate(); }));
      break;
    }
    default: return null;
  }
  card.append(meta, acts);
  return card;
}

/** Rebuild a File from a stored photo data-URL for Web Share of media. */
function photoFile(rec) {
  try {
    const m = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(rec.dataUrl || '');
    if (!m) return null;
    const bin = atob(m[2]); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
    return new File([arr], (rec.name || 'photo') + '.' + ext, { type: m[1] });
  } catch { return null; }
}

function recurText(recur) {
  const d = { daily: 'every day', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };
  let s = d[recur.freq] || recur.freq;
  if (recur.freq === 'weekly' && recur.days) s += ' on ' + recur.days.map(x => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(',');
  if (recur.time) s += ' at ' + fmtHM(+recur.time.split(':')[0], +recur.time.split(':')[1]);
  return s;
}
function streak(log) {
  const set = new Set(log); let n = 0; const d = new Date();
  while (true) { if (set.has(todayKey(d))) { n++; d.setDate(d.getDate() - 1); } else break; }
  return n;
}
function moodEmoji(m) { const e = { happy: '😄', down: '😔', tired: '😴', stressed: '😰' }; return e[m] || '📔'; }
function bump(ctx, kind, id, d, unit) {
  const it = ctx.store.list(kind).find(x => x.id === id);
  const hist = (it.history || []).concat([{ at: new Date().toISOString(), delta: d }]).slice(-300);
  ctx.store.updateSync(kind, id, { qty: Math.max(0, it.qty + d), history: hist });
  ctx.afterMutate();
}
function snooze(ctx, rec) {
  const n = new Date(); n.setMinutes(n.getMinutes() + 10);
  ctx.store.updateSync('reminder', rec.id, { at: n.toISOString(), status: 'active', snoozedUntil: n.toISOString() });
  ctx.afterMutate();
}

/** Inline history reference card (for pronoun actions on the last item). */
export function miniRef(ctx, kind, id) {
  const card = entityCard(ctx, kind, id);
  if (!card) return null;
  const w = E.div({ class: 'mini' }, 'Last: ' + (cardText(ctx, kind, id)));
  w.addEventListener('click', () => ctx.scrollToCard(id));
  return w;
}
export function cardText(ctx, kind, id) {
  const r = ctx.store.list(kind).find(x => x.id === id);
  if (!r) return '';
  return r.title || r.name || r.person || r.category || r.text || '';
}
