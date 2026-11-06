// Brain's universal action vocabulary.
//
// Entity cards, natural-language intents, notification callbacks, and menu
// shortcuts all emit the same {id, args} request. The app shell is the single
// executor; this module decides which actions are honest to offer for a record
// on the current device. Keeping availability separate from rendering avoids
// dozens of inconsistent, optimistic buttons.

import { isValidPhone, waChatLink, openLinkUri, instagramProfileUri } from './external.js';
import { isSafeImageDataUrl } from '../store/validate.js';

export const ACTION = Object.freeze({
  CALL: 'call', SMS: 'sms', WHATSAPP: 'whatsapp', EMAIL: 'email', MAPS: 'maps',
  OPEN: 'open', COPY: 'copy', SHARE: 'share', CALENDAR: 'calendar',
  PHOTO_PICK: 'photoPick', CAMERA_PICK: 'cameraPick', PHOTO_VIEW: 'photo.view',
  PHOTO_DOWNLOAD: 'photo.download', CONTACT_PICK: 'contactPick',
  RECORD_EDIT: 'record.edit', RECORD_DELETE: 'record.delete',
  TASK_COMPLETE: 'task.complete', TASK_REOPEN: 'task.reopen',
  REMINDER_COMPLETE: 'reminder.complete', REMINDER_SNOOZE: 'reminder.snooze',
  DEBT_TOGGLE: 'debt.toggle', STOCK_BUMP: 'stock.bump', HABIT_LOG: 'habit.log',
  LOCATION_CURRENT: 'location.current',
  INSTAGRAM_CONNECT: 'instagram.connect',
  INSTAGRAM_DISCONNECT: 'instagram.disconnect',
  INSTAGRAM_CHECK: 'instagram.check',
  INSTAGRAM_OPEN: 'instagram.open',
  INSTAGRAM_DRAFT_CREATE: 'instagram.draft.create',
  INSTAGRAM_DRAFT_EDIT: 'instagram.draft.edit',
  INSTAGRAM_DRAFT_DELETE: 'instagram.draft.delete',
  INSTAGRAM_DRAFT_PREVIEW: 'instagram.draft.preview',
  INSTAGRAM_PUBLISH_PREVIEW: 'instagram.publish.preview',
  INSTAGRAM_PUBLISH: 'instagram.publish',
  INSTAGRAM_SCHEDULE: 'instagram.schedule',
  INSTAGRAM_QUEUE_ADD: 'instagram.queue.add',
  INSTAGRAM_QUEUE_CANCEL: 'instagram.queue.cancel',
  INSTAGRAM_FAILED_RETRY: 'instagram.failed.retry',
  INSTAGRAM_AUTOMATION_OPEN: 'instagram.automation.open',
  INSTAGRAM_AUTOMATION_PAUSE: 'instagram.automation.pause',
  INSTAGRAM_AUTOMATION_RESUME: 'instagram.automation.resume',
  INSTAGRAM_INSIGHTS: 'instagram.insights',
  COMMAND_CENTRE_OPEN: 'commandCentre.open',
  AUTOMATION_CENTRE_OPEN: 'automation.centre.open',
  CALENDAR_OPEN: 'calendar.open',
  TASK_EVENT_LINK: 'taskEvent.link',
  REMINDER_TASK_LINK: 'reminder.task.link'
});

export function makeAction(id, label, args = {}) { return { id, label, args }; }

function hasEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function hasAddress(value) { return String(value || '').trim().length > 3; }
function hasPhoto(value) { return isSafeImageDataUrl(value); }

/** Capability-aware availability check for a requested action. */
export function canOffer(id, args = {}, { caps = {}, settings = {} } = {}) {
  const share = (caps.share || {}).webShare;
  switch (id) {
    case ACTION.CALL:
    case ACTION.SMS:
      // Browsers do not provide a reliable "can open tel/sms" probe. A valid
      // scheme is the strongest legitimate test, and the OS owns the handoff.
      return isValidPhone(args.number);
    case ACTION.WHATSAPP:
      // Cards only request a direct chat. A typed command may explicitly ask
      // for WhatsApp without a country code, in which case the official share
      // route is still an honest, user-selected fallback.
      return !!waChatLink(args.number, args.text || '', { countryCode: settings.countryCode || '' }) || !!args.text || !!args.allowShareFallback;
    case ACTION.EMAIL: return hasEmail(args.email);
    case ACTION.MAPS: return hasAddress(args.query);
    case ACTION.OPEN: return !!openLinkUri(args.url);
    case ACTION.COPY: return typeof args.text === 'string'; // manual-copy fallback exists
    case ACTION.SHARE:
      // An unavailable native sheet degrades to a real copy/download action.
      return !!share || !!args.text || !!args.url || !!args.files;
    case ACTION.CALENDAR: return !!args.start;
    case ACTION.PHOTO_PICK: return !!(caps.files || {}).picker;
    case ACTION.CAMERA_PICK: return !!(caps.files || {}).captureCamera;
    case ACTION.CONTACT_PICK: return !!(caps.contacts || {}).select;
    case ACTION.LOCATION_CURRENT: return !!(caps.geolocation || {}).supported;
    case ACTION.PHOTO_VIEW: return hasPhoto(args.dataUrl);
    case ACTION.PHOTO_DOWNLOAD: return hasPhoto(args.dataUrl);
    case ACTION.INSTAGRAM_CONNECT: return true;
    case ACTION.INSTAGRAM_DISCONNECT: return !!(settings && settings.instagram && settings.instagram.connected);
    case ACTION.INSTAGRAM_CHECK: return !!(settings && settings.instagram && settings.instagram.connected);
    case ACTION.INSTAGRAM_OPEN: return !!(args.url);
    case ACTION.INSTAGRAM_DRAFT_CREATE: return !!(caps.files || {}).picker;
    case ACTION.INSTAGRAM_DRAFT_EDIT: return true;
    case ACTION.INSTAGRAM_DRAFT_DELETE: return true;
    case ACTION.INSTAGRAM_DRAFT_PREVIEW: return true;
    case ACTION.INSTAGRAM_PUBLISH_PREVIEW: return !!(settings && settings.instagram && settings.instagram.connected);
    case ACTION.INSTAGRAM_PUBLISH: return !!(settings && settings.instagram && settings.instagram.connected);
    case ACTION.INSTAGRAM_SCHEDULE: return true;
    case ACTION.INSTAGRAM_QUEUE_ADD: return true;
    case ACTION.INSTAGRAM_QUEUE_CANCEL: return true;
    case ACTION.INSTAGRAM_FAILED_RETRY: return true;
    case ACTION.INSTAGRAM_AUTOMATION_OPEN: return true;
    case ACTION.INSTAGRAM_AUTOMATION_PAUSE: return true;
    case ACTION.INSTAGRAM_AUTOMATION_RESUME: return true;
    case ACTION.INSTAGRAM_INSIGHTS: return !!(settings && settings.instagram && settings.instagram.connected);
    case ACTION.COMMAND_CENTRE_OPEN: return true;
    case ACTION.AUTOMATION_CENTRE_OPEN: return true;
    case ACTION.CALENDAR_OPEN: return true;
    default: return true;
  }
}

/**
 * Return all meaningful actions for an entity. Renderers may choose their own
 * compact labels but must use this list rather than inventing unsupported ones.
 */
export function availableActions(kind, record, context = {}) {
  if (!record) return [];
  const c = { caps: context.caps || {}, settings: context.settings || {} };
  const add = (id, label, args = {}) => canOffer(id, args, c) ? makeAction(id, label, args) : null;
  const list = [];
  const push = action => { if (action) list.push(action); };

  switch (kind) {
    case 'task':
      push(makeAction(record.status === 'done' ? ACTION.TASK_REOPEN : ACTION.TASK_COMPLETE, record.status === 'done' ? 'Reopen' : 'Done', { kind, id: record.id }));
      if (record.due) push(add(ACTION.CALENDAR, 'Calendar', { title: record.title, start: record.due, end: record.due, description: record.note || '' }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'reminder':
      push(makeAction(ACTION.REMINDER_COMPLETE, record.recur ? 'Dismiss today' : 'Complete', { kind, id: record.id }));
      push(makeAction(ACTION.REMINDER_SNOOZE, 'Snooze 10m', { kind, id: record.id, minutes: 10 }));
      if (record.at) push(add(ACTION.CALENDAR, 'Calendar', { title: record.title, start: record.at, end: new Date(new Date(record.at).getTime() + 10 * 60_000).toISOString() }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'note': {
      const text = record.body || record.title || '';
      push(add(ACTION.SHARE, (c.caps.share || {}).webShare ? 'Share' : 'Copy to share', { title: record.title || 'Note', text }));
      push(add(ACTION.COPY, 'Copy', { text }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    }
    case 'photo':
      push(add(ACTION.PHOTO_VIEW, 'View', { id: record.id, dataUrl: record.dataUrl }));
      push(add(ACTION.SHARE, (c.caps.share || {}).shareFiles ? 'Share' : 'Save / share', { title: record.name || 'Photo', text: 'Photo from Brain', photoId: record.id }));
      push(add(ACTION.PHOTO_DOWNLOAD, 'Save copy', { id: record.id, dataUrl: record.dataUrl, name: record.name, mime: record.mime }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'journal': {
      push(add(ACTION.SHARE, (c.caps.share || {}).webShare ? 'Share' : 'Copy to share', { title: 'Journal', text: record.text || '' }));
      const photo = record.photoId && (context.store ? context.store.get('photo', record.photoId) : null);
      if (photo) push(add(ACTION.PHOTO_VIEW, 'View photo', { id: photo.id, dataUrl: photo.dataUrl }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    }
    case 'person': {
      if (isValidPhone(record.phone)) {
        push(add(ACTION.CALL, 'Call', { number: record.phone }));
        const waArgs = { number: record.phone, countryCode: c.settings.countryCode || '' };
        if (canOffer(ACTION.WHATSAPP, waArgs, c) && waChatLink(record.phone, '', waArgs)) push(makeAction(ACTION.WHATSAPP, 'WhatsApp', waArgs));
        push(add(ACTION.SMS, 'Text', { number: record.phone }));
        push(add(ACTION.COPY, 'Copy number', { text: record.phone }));
      }
      if (hasEmail(record.email)) {
        push(add(ACTION.EMAIL, 'Email', { email: record.email }));
        push(add(ACTION.COPY, 'Copy email', { text: record.email }));
      }
      if (hasAddress(record.address)) {
        push(add(ACTION.MAPS, 'Maps', { query: record.address, directions: true }));
        push(add(ACTION.COPY, 'Copy address', { text: record.address }));
      }
      if (instagramProfileUri(record.instagram)) push(add(ACTION.OPEN, 'Instagram', { url: instagramProfileUri(record.instagram) }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    }
    case 'money': {
      const text = `${record.category || record.kind}: ${record.kind === 'income' ? 'income' : 'expense'} ${record.amount}`;
      push(add(ACTION.SHARE, (c.caps.share || {}).webShare ? 'Share' : 'Copy to share', { title: record.category || 'Money', text }));
      push(add(ACTION.COPY, 'Copy', { text }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    }
    case 'debt':
      push(makeAction(ACTION.DEBT_TOGGLE, record.status === 'settled' ? 'Unsettle' : 'Settle', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'stockItem':
      push(makeAction(ACTION.STOCK_BUMP, '+1', { kind, id: record.id, delta: 1 }));
      push(makeAction(ACTION.STOCK_BUMP, '−1', { kind, id: record.id, delta: -1 }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'habit':
      push(makeAction(ACTION.HABIT_LOG, 'Log today', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'event':
      if (record.at) {
        push(add(ACTION.CALENDAR, 'Calendar', { title: record.title, start: record.at, end: record.end, allDay: record.allDay, location: record.location || '', description: record.notes || record.kind || '' }));
        push(add(ACTION.SHARE, (c.caps.share || {}).webShare ? 'Share' : 'Copy to share', { title: record.title || 'Event', text: `${record.title || 'Event'} on ${record.at}` }));
        if (hasAddress(record.location)) push(add(ACTION.MAPS, 'Maps', { query: record.location, directions: true }));
      }
      push(makeAction(ACTION.RECORD_EDIT, 'Edit', { kind, id: record.id }));
      push(makeAction(ACTION.RECORD_DELETE, 'Delete', { kind, id: record.id }));
      break;
    case 'instagramDraft': {
      const isPublished = String(record.status).toUpperCase() === 'PUBLISHED';
      const isFailed = String(record.status).toUpperCase() === 'FAILED';
      const isCancelled = String(record.status).toUpperCase() === 'CANCELLED';
      const isQueued = ['SCHEDULED','AWAITING_APPROVAL','READY'].includes(String(record.status).toUpperCase());
      const igConnected = !!(c.settings && c.settings.instagram && c.settings.instagram.connected);
      push(makeAction(ACTION.INSTAGRAM_DRAFT_PREVIEW, 'Edit', { kind, id: record.id }));
      if (!isPublished) {
        push(makeAction(ACTION.INSTAGRAM_DRAFT_DELETE, 'Delete', { kind, id: record.id }));
        if (igConnected) push(add(ACTION.INSTAGRAM_PUBLISH_PREVIEW, 'Publish…', { kind, id: record.id }));
        if (isFailed) push(makeAction(ACTION.INSTAGRAM_FAILED_RETRY, 'Retry', { kind, id: record.id }));
        if (isQueued) push(makeAction(ACTION.INSTAGRAM_QUEUE_CANCEL, 'Cancel', { kind, id: record.id }));
        else if (!isCancelled) push(makeAction(ACTION.INSTAGRAM_QUEUE_ADD, 'Queue', { kind, id: record.id }));
      }
      if (record.permalink) push(add(ACTION.OPEN, 'View on Instagram', { url: record.permalink }));
      break;
    }
    case 'instagramPublication':
      if (record.permalink) push(add(ACTION.OPEN, 'View on Instagram', { url: record.permalink }));
      break;
    default:
      break;
  }
  return list;
}
