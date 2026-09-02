// Inline entity cards. Cards do not mutate state themselves: every interaction
// emits a request into Brain's universal action dispatcher. That keeps chat,
// notification actions, menu actions, and cards consistent and testable.

import { nodes as E, formatMoney, todayKey } from '../util/util.js';
import { fmtHM } from '../util/date.js';
import { availableActions, ACTION } from '../actions/system.js';
import { isSafeImageDataUrl } from '../store/validate.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function humanDate(ctx, iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(date); day.setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  let prefix = '';
  if (diff === 0) prefix = 'today';
  else if (diff === 1) prefix = 'tomorrow';
  else if (diff === -1) prefix = 'yesterday';
  else if (diff > 1 && diff < 30) prefix = `in ${diff} days`;
  return `${prefix ? `${prefix} · ` : ''}${MONTHS[date.getMonth()]} ${date.getDate()}${date.getFullYear() !== today.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
}

export function kindIcon(kind) {
  const icons = { task: '✅', reminder: '🔔', note: '📝', person: '👤', money: '💰', debt: '💸', stockItem: '📦', habit: '🔥', journal: '📔', event: '📅', photo: '📷' };
  return icons[kind] || '•';
}

function actionClass(action) {
  if ([ACTION.TASK_COMPLETE, ACTION.REMINDER_COMPLETE, ACTION.HABIT_LOG, ACTION.PHOTO_VIEW].includes(action.id)) return 'g';
  if ([ACTION.RECORD_DELETE, ACTION.STOCK_BUMP].includes(action.id) && (action.id !== ACTION.STOCK_BUMP || action.args.delta < 0)) return 'r';
  return '';
}

function actionButton(ctx, action) {
  const label = String(action.label || 'Action');
  const button = E.button({
    class: `mini ${actionClass(action)}`.trim(),
    type: 'button',
    'aria-label': label
  }, label);
  button.addEventListener('click', async event => {
    event.preventDefault();
    if (button.disabled || typeof ctx.runAction !== 'function') return;
    // A fast double-tap must not issue two mutations (or two external handoffs)
    // before the card has a chance to re-render.
    button.disabled = true;
    try { await ctx.runAction(action); } catch {} finally { button.disabled = false; }
  });
  return button;
}

function validPhoto(dataUrl) { return isSafeImageDataUrl(dataUrl); }

/** Render an actionable record card, or null for a removed / unavailable record. */
export function entityCard(ctx, kind, id) {
  const record = ctx.store.list(kind).find(item => item.id === id);
  if (!record) return null;
  const card = E.div({ class: 'card', dataset: { cid: id } });
  const heading = E.div({ class: 'k' }, E.span({}, kindIcon(kind)), E.span({}, kind.replace(/([A-Z])/g, ' $1').toUpperCase()));
  const meta = E.div({ class: 'meta' });
  const actions = E.div({ class: 'act' });
  card.append(heading);

  switch (kind) {
    case 'task':
      card.append(E.div({ class: 't' }, `${record.status === 'done' ? '✓ ' : ''}${record.title || 'Untitled task'}`));
      if (record.note) meta.append(E.div({ style: 'white-space:pre-wrap' }, record.note));
      if (record.due) meta.append(E.div({}, `Due ${humanDate(ctx, record.due)} · ${fmtHM(new Date(record.due).getHours(), new Date(record.due).getMinutes())}`));
      if (record.recur) meta.append(E.div({}, recurrenceText(record.recur)));
      break;
    case 'reminder':
      card.append(E.div({ class: 't' }, record.title || 'Untitled reminder'));
      if (record.snoozedUntil) meta.append(E.div({}, `Snoozed until ${humanDate(ctx, record.snoozedUntil)} · ${fmtHM(new Date(record.snoozedUntil).getHours(), new Date(record.snoozedUntil).getMinutes())}`));
      else if (record.recur) meta.append(recurrenceText(record.recur));
      else if (record.at) meta.append(`${humanDate(ctx, record.at)} · ${fmtHM(new Date(record.at).getHours(), new Date(record.at).getMinutes())}`);
      if (record.status === 'fired') meta.append(E.div({ class: 'att' }, 'Waiting for you to complete or snooze it'));
      break;
    case 'note':
      card.append(E.div({ class: 't' }, `${record.private ? '🔒 ' : ''}${record.title || 'Note'}`));
      meta.append(E.div({ style: 'white-space:pre-wrap' }, record.body || ''));
      if (record.private) meta.append(E.div({ class: 'att' }, 'Private — stored only on this device'));
      break;
    case 'photo':
      card.append(E.div({ class: 't' }, record.name || 'Photo'));
      if (record.width && record.height) meta.append(`${record.width}×${record.height}`);
      if (validPhoto(record.dataUrl)) card.append(E.img({ class: 'thumb', src: record.dataUrl, alt: record.name || 'Saved photo', loading: 'lazy' }));
      else meta.append(E.div({ class: 'att' }, 'Image data is unavailable. You can remove this record safely.'));
      break;
    case 'journal': {
      card.append(E.div({ class: 't' }, `${moodEmoji(record.mood)} ${humanDate(ctx, record.date)}`));
      const photo = record.photoId ? ctx.store.list('photo').find(item => item.id === record.photoId) : null;
      if (photo && validPhoto(photo.dataUrl)) card.append(E.img({ class: 'thumb', src: photo.dataUrl, alt: 'Journal attachment', loading: 'lazy' }));
      meta.append(E.div({ style: 'white-space:pre-wrap' }, record.text || ''));
      break;
    }
    case 'person':
      card.append(E.div({ class: 't' }, record.name || 'Unnamed person'));
      if (record.phone) meta.append(E.div({ class: 'contact' }, `📞 ${record.phone}`));
      if (record.email) meta.append(E.div({ class: 'contact' }, `✉️ ${record.email}`));
      if (record.address) meta.append(E.div({ class: 'contact' }, `📍 ${record.address}`));
      if (record.instagram) meta.append(E.div({ class: 'contact' }, `📸 @${String(record.instagram).replace(/^@/, '')}`));
      if (record.birthday) meta.append(E.div({}, `🎂 ${record.birthday}`));
      if (record.relationship) meta.append(E.div({}, record.relationship));
      if (record.aliases && record.aliases.length) meta.append(E.div({ class: 'att' }, `Also known as: ${record.aliases.join(', ')}`));
      if (record.notes) meta.append(E.div({ style: 'white-space:pre-wrap' }, record.notes));
      break;
    case 'money': {
      const sign = record.kind === 'income' ? '+' : '−';
      card.append(E.div({ class: 't' }, `${sign} ${formatMoney(record.amount, ctx.cur || {})}`));
      meta.append(`${record.category || record.kind}${record.date ? ` · ${humanDate(ctx, record.date)}` : ''}`);
      break;
    }
    case 'debt':
      card.append(E.div({ class: 't' }, record.dir === 'they_owe_me' ? `${record.person} owes you` : `You owe ${record.person}`));
      meta.append(`${formatMoney(record.amount, ctx.cur || {})}${record.status === 'settled' ? ' · settled' : ''}`);
      break;
    case 'stockItem':
      card.append(E.div({ class: 't' }, `${record.qty} ${record.unit} ${record.name}`));
      if (record.lowThreshold != null && record.qty <= record.lowThreshold) meta.append('⚠️ Low');
      if (Array.isArray(record.history) && record.history.length) {
        meta.append(E.div({ class: 'att' }, 'Recent adjustments'));
        for (const entry of record.history.slice(-3).reverse()) meta.append(E.div({ class: 'att' }, stockHistoryText(entry, record.unit)));
      }
      break;
    case 'habit':
      card.append(E.div({ class: 't' }, record.name || 'Habit'));
      meta.append(`${streak(record.log || [])} day streak`);
      break;
    case 'event':
      card.append(E.div({ class: 't' }, record.title || 'Untitled event'));
      meta.append(`${record.kind ? `${record.kind} · ` : ''}${record.at ? humanDate(ctx, record.at) : 'no date'}`);
      if (record.at && !record.allDay) meta.append(E.div({}, fmtHM(new Date(record.at).getHours(), new Date(record.at).getMinutes()) + (record.end ? ` – ${fmtHM(new Date(record.end).getHours(), new Date(record.end).getMinutes())}` : '')));
      if (record.location) meta.append(E.div({ class: 'contact' }, `📍 ${record.location}`));
      if (record.notes) meta.append(E.div({ style: 'white-space:pre-wrap' }, record.notes));
      break;
    default:
      return null;
  }

  for (const action of availableActions(kind, record, {
    caps: typeof ctx.getCaps === 'function' ? ctx.getCaps() : ctx.caps,
    settings: ctx.store.settings,
    store: ctx.store
  })) actions.append(actionButton(ctx, action));
  card.append(meta, actions);
  return card;
}

function recurrenceText(recur) {
  const words = { daily: 'every day', weekly: 'weekly', monthly: 'monthly', yearly: 'yearly' };
  let text = words[recur.freq] || 'recurring';
  if (recur.interval > 1) text = recur.freq === 'daily' ? `every ${recur.interval} days` : `every ${recur.interval} ${recur.freq.replace(/ly$/, '')}s`;
  if (recur.freq === 'weekly' && recur.days && recur.days.length) text += ` on ${recur.days.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')}`;
  if (recur.time) {
    const [hour, minute] = recur.time.split(':').map(Number);
    text += ` at ${fmtHM(hour, minute)}`;
  }
  return text;
}

function streak(log) {
  const set = new Set(log || []);
  const day = new Date();
  let count = 0;
  while (set.has(todayKey(day))) { count += 1; day.setDate(day.getDate() - 1); }
  return count;
}

function moodEmoji(mood) {
  const icons = { happy: '😄', down: '😔', tired: '😴', stressed: '😰' };
  return icons[mood] || '📔';
}

function stockHistoryText(entry, unit) {
  const delta = Number(entry && entry.delta);
  const amount = Number.isFinite(delta) ? `${delta >= 0 ? '+' : '−'}${Math.abs(delta)}` : 'Changed';
  const when = entry && entry.at ? humanDate({}, entry.at) : '';
  return `${amount}${unit ? ` ${unit}` : ''}${when ? ` · ${when}` : ''}`;
}
