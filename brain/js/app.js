// Brain application shell. This is the only device-action executor: intent
// replies, entity cards, notification callbacks, and menu shortcuts all travel
// through runAction(), which keeps state changes and honest fallbacks coherent.

import { Store, previewImport, MAX_BACKUP_CHARS, V } from './store/store.js';
import { Brain } from './engine/intent.js';
import * as Domain from './engine/actions.js';
import { nodes as E, todayKey } from './util/util.js';
import { nextOccurrence } from './util/date.js';
import { entityCard, kindIcon } from './ui/cards.js';
import { Scheduler, brief, requestPermission, perm } from './notify.js';
import { setupInstall, registerSw, isStandalone, reminderCapability } from './install.js';
import { LOCALES, CURRENCIES } from './util/constants.js';
import { getCaps, isIOS, isAndroid, isMobileUA } from './caps.js';
import { ACTION, canOffer } from './actions/system.js';
import * as Ext from './actions/external.js';

const $ = selector => document.querySelector(selector);
const BACKUP_MAX_BYTES = MAX_BACKUP_CHARS;
let store;
let brain;
let ctx;
let scheduler;
let swRegistration = null;
let busy = false;
let sheetWasPushed = false;
let sheetFocus = null;
let sheetFieldId = 0;
let toastTimer = null;
let restoreBusy = false;

const SUGGESTIONS = [
  { text: 'remind me to call mom tomorrow at 7pm', label: '🔔 Reminder' },
  { text: 'add task finish the report by friday', label: '✅ Task' },
  { text: 'spent 850 on groceries', label: '💰 Spent' },
  { text: 'Priya’s birthday is March 12', label: '🎂 Birthday' },
  { text: 'add a photo to my journal', label: '📷 Photo' },
  { text: 'share today’s plan', label: '🔗 Share' }
];

async function boot() {
  store = new Store();
  await store.init();
  brain = new Brain(store);
  document.documentElement.classList.toggle('reduce', !!store.settings.reducedMotion);

  ctx = {
    store,
    brain,
    get cur() { return { currency: store.settings.currency, locale: store.settings.locale }; },
    getCaps,
    get caps() { return getCaps(); },
    notify: showSystemNotification,
    pushAlert: (text, reminder) => pushBot(text, reminder ? [{ kind: 'reminder', id: reminder.id }] : [], { sys: true }),
    afterMutate: renderAll,
    scrollToCard: id => {
      const element = document.querySelector(`[data-cid="${cssEscape(id)}"]`);
      if (element) element.scrollIntoView({ block: 'center', behavior: motionBehavior() });
    },
    runAction,
    edit: (kind, id) => openEditor(kind, id),
    viewPhoto,
    toast
  };
  scheduler = new Scheduler(ctx);

  wireHeader();
  wireComposer();
  wireSheet();
  buildSuggestions();
  wireLifecycle();
  wireServiceWorkerMessages();
  setupInstall($('#installBtn'));
  registerSw().then(registration => { swRegistration = registration || null; }).catch(() => {});
  bootVoice();
  store.onPersistenceError(() => toast('Brain could not save the latest change. Check device storage, then try again.'));

  setTitle();
  await handleNotificationLaunch();
  showWelcome();
  scheduler.start();
  showBriefOnce();
}

function motionBehavior() { return store && store.settings.reducedMotion ? 'auto' : 'smooth'; }
function cssEscape(value) { return (window.CSS && CSS.escape) ? CSS.escape(value) : String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

// ---------- Conversation rendering ----------
const blocks = [];

function renderAll() {
  const chat = $('#chat');
  if (!chat) return;
  chat.textContent = '';
  for (const block of blocks.slice(-200)) chat.append(renderBlock(block));
  autoScroll();
}

function renderBlock(block) {
  const row = E.div({ class: `row ${block.role === 'user' ? 'user' : `bot ${block.kind === 'brief' ? 'brief' : ''}`}`.trim() });
  const content = E.div({ style: 'min-width:0' });
  if (block.role === 'bot') row.append(E.div({ class: 'avatar', 'aria-hidden': 'true' }, block.kind === 'brief' ? '☀️' : '🧠'));
  if (block.text) content.append(E.div({ class: 'bubble' }, block.text));
  if (block.cards && block.cards.length) {
    const cards = E.div({ class: 'cards' });
    for (const card of block.cards) {
      const node = entityCard(ctx, card.kind, card.id);
      if (node) cards.append(node);
    }
    if (cards.childNodes.length) content.append(cards);
  }
  if (block.actions && block.actions.length) {
    const choices = E.div({ class: 'choicebar', role: 'group', 'aria-label': 'Choose a contact' });
    for (const action of block.actions) {
      const button = E.button({ class: 'runbtn', type: 'button' }, action.label || 'Choose');
      button.addEventListener('click', async () => {
        if (button.disabled) return;
        button.disabled = true;
        try { await runAction(action); } finally { button.disabled = false; }
      });
      choices.append(button);
    }
    content.append(choices);
  }
  if (block.run && block.run.label) {
    const button = E.button({ class: 'runbtn', type: 'button' }, block.run.label);
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      button.disabled = true;
      try { await runAction(block.run); } finally { button.disabled = false; }
    });
    content.append(button);
  }
  content.append(E.div({ class: 'ts' }, clock(block.ts)));
  row.append(content);
  return row;
}

function clock(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function autoScroll() {
  const chat = $('#chat');
  requestAnimationFrame(() => { chat.scrollTop = chat.scrollHeight; });
}
function pushUser(text) { blocks.push({ role: 'user', text, ts: Date.now() }); renderAll(); }
function pushBot(text, cards = [], options = {}) {
  blocks.push({
    role: 'bot', kind: options.brief ? 'brief' : options.sys ? 'sys' : 'msg', text,
    cards, run: options.run || null, actions: options.actions || [], ts: Date.now()
  });
  renderAll();
}
let typingNode = null;
function showTyping() {
  const chat = $('#chat');
  const row = E.div({ class: 'row bot typing', 'aria-label': 'Brain is thinking' });
  row.append(E.div({ class: 'avatar', 'aria-hidden': 'true' }, '🧠'));
  row.append(E.div({ class: 'bubble' }, E.i(), E.i(), E.i()));
  chat.append(row);
  typingNode = row;
  autoScroll();
}
function hideTyping() { if (typingNode && typingNode.parentNode) typingNode.remove(); typingNode = null; }

function showWelcome() {
  if (!store.settings.name) {
    blocks.length = 0;
    pushBot('👋 Hi! I’m Brain — a private assistant that lives on this device.\n\nTasks, reminders, notes, people and files stay here unless you explicitly choose an external action.\n\nWhat should I call you?');
  } else pushBot(`Hi, ${store.settings.name} 👋 What can I help with?`);
}
function isNameish(text) { return /^[A-Za-z][A-Za-z .'-]{1,40}$/.test(text.trim()) && text.trim().split(/\s+/).length <= 4; }

async function sendNow(value = null) {
  if (busy) return;
  const input = $('#in');
  const raw = String(value == null ? input.value : value).trim();
  if (!raw) return;
  input.value = '';
  autosize();
  pushUser(raw);

  if (!store.settings.name) {
    if (isNameish(raw)) {
      const saved = await store.updateSettings({ name: raw.replace(/\s+/g, ' ').trim(), onboarded: true });
      if (!saved) { toast('I could not save your name. Check device storage and try again.'); return; }
      brain.name = store.settings.name;
      setTitle();
      pushBot(`Nice to meet you, ${store.settings.name}.\n\nTry “remind me to take medicine at 8pm”, “add a photo to my journal”, or “call John”.`);
      return;
    }
    const saved = await store.updateSettings({ name: 'there', onboarded: true });
    if (!saved) { toast('I could not start safely because this browser could not save settings.'); return; }
    brain.name = 'there';
  }

  busy = true;
  $('#send').disabled = true;
  showTyping();
  try {
    const response = await brain.handle(raw);
    const flush = await store.flush();
    hideTyping();
    // A command reply must not claim that a new task, note, or reminder was
    // saved until the write-behind queue has actually accepted it. Keep the
    // in-memory item visible for a possible later retry, but be clear that it
    // is not durable if storage has rejected the write.
    if (!flush.ok) {
      pushBot('Brain could not save the latest change. It is only in this open session until storage works again; check available device storage and retry.');
      return;
    }
    const prepared = prepareReplyForDevice(response);
    if (prepared && (prepared.text || (prepared.cards && prepared.cards.length) || prepared.run || (prepared.actions && prepared.actions.length))) {
      pushBot(prepared.text || '', prepared.cards || [], { run: prepared.run, actions: prepared.actions });
    } else pushBot('I’m not sure how to help with that yet.');
  } catch (error) {
    hideTyping();
    toast('Something went wrong. Nothing was sent anywhere. Please try again.');
  } finally {
    busy = false;
    $('#send').disabled = false;
  }
}

// ---------- Capability-aware reply presentation ----------
function prepareReplyForDevice(response) {
  if (!response || !store) return response;
  const caps = getCaps();
  const context = { caps, settings: store.settings };
  // Ambiguity choices use the same availability contract as cards and direct
  // replies, so an invalid saved number cannot surface as a dead button.
  const prepared = {
    ...response,
    actions: (response.actions || []).filter(action => canOffer(action.id, action.args || {}, context))
  };
  if (!prepared.run || canOffer(prepared.run.id, prepared.run.args || {}, context)) return prepared;

  // Camera capture is optional. Where an ordinary image picker remains real,
  // offer that precise fallback rather than leaving an impossible camera button.
  if (prepared.run.id === ACTION.CAMERA_PICK && caps.files.picker) {
    return {
      ...prepared,
      text: `${prepared.text || 'Camera capture is unavailable here.'}\n\nThis browser does not expose direct camera capture, but you can choose a photo instead.`,
      run: { ...prepared.run, id: ACTION.PHOTO_PICK, label: '🖼️ Choose photo' }
    };
  }
  const names = {
    [ACTION.CONTACT_PICK]: 'the Contacts Picker',
    [ACTION.LOCATION_CURRENT]: 'location access',
    [ACTION.PHOTO_PICK]: 'a photo picker',
    [ACTION.CAMERA_PICK]: 'camera capture'
  };
  return {
    ...prepared,
    run: null,
    text: `${prepared.text || ''}${prepared.text ? '\n\n' : ''}This browser does not expose ${names[prepared.run.id] || 'that capability'}, so there is no action to open.`
  };
}

// ---------- Header, composer, sheet ----------
function setTitle() { $('#title').textContent = 'Brain'; }
function wireHeader() { $('#menuBtn').addEventListener('click', openMenu); }
function buildSuggestions() {
  const root = $('#suggests');
  root.textContent = '';
  for (const suggestion of SUGGESTIONS) {
    const button = E.button({ class: 'chip', type: 'button' }, suggestion.label);
    button.addEventListener('click', () => { $('#in').value = suggestion.text; $('#in').focus(); autosize(); });
    root.append(button);
  }
}
function wireComposer() {
  const input = $('#in');
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendNow(); }
  });
  input.addEventListener('focus', () => setTimeout(autoScroll, 200));
  $('#send').addEventListener('click', () => sendNow());
  $('#mic').addEventListener('click', toggleVoice);
}
function autosize() {
  const input = $('#in');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}
function sheetFocusable() {
  const sheet = $('#sheet');
  if (!sheet) return [];
  return [...sheet.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.hidden && !element.closest('[hidden], [aria-hidden="true"]'));
}
function setSheetModalState(open) {
  const sheet = $('#sheet');
  const app = $('#app');
  if (sheet) sheet.setAttribute('aria-hidden', open ? 'false' : 'true');
  const menuButton = $('#menuBtn');
  if (menuButton) menuButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!app) return;
  if (open) {
    app.setAttribute('aria-hidden', 'true');
    // `inert` prevents pointer/focus escape where it is implemented. Focus
    // trapping below preserves the dialog behavior in browsers without it.
    if ('inert' in app) app.inert = true;
  } else {
    app.removeAttribute('aria-hidden');
    if ('inert' in app) app.inert = false;
  }
}
function trapSheetFocus(event) {
  if (event.key !== 'Tab' || !$('#sheet').classList.contains('open')) return;
  const items = sheetFocusable();
  if (!items.length) { event.preventDefault(); $('#sheet').focus(); return; }
  const current = document.activeElement;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (current === first || !$('#sheet').contains(current))) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && (current === last || !$('#sheet').contains(current))) { event.preventDefault(); first.focus(); }
}
function wireSheet() {
  $('#sheetClose').addEventListener('click', () => closeSheet());
  $('#sheet').addEventListener('click', event => { if (event.target === $('#sheet')) closeSheet(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('#sheet').classList.contains('open')) { event.preventDefault(); closeSheet(); return; }
    trapSheetFocus(event);
  });
  window.addEventListener('popstate', () => { if ($('#sheet').classList.contains('open')) closeSheet({ fromHistory: true }); });
}
function openSheet() {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('open')) {
    sheetFocus = document.activeElement;
    sheet.classList.add('open');
    setSheetModalState(true);
    if (!sheetWasPushed && window.history && window.history.pushState) {
      window.history.pushState({ ...(window.history.state || {}), brainSheet: true }, '', window.location.href);
      sheetWasPushed = true;
    }
  }
  requestAnimationFrame(() => {
    const items = sheetFocusable();
    const target = items.find(element => element.id !== 'sheetClose') || items[0] || sheet;
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  });
}
function closeSheet({ fromHistory = false } = {}) {
  const sheet = $('#sheet');
  if (!sheet.classList.contains('open')) return;
  sheet.classList.remove('open');
  setSheetModalState(false);
  if (sheetWasPushed && !fromHistory && window.history && window.history.back) window.history.back();
  sheetWasPushed = false;
  if (sheetFocus && typeof sheetFocus.focus === 'function') {
    try { sheetFocus.focus({ preventScroll: true }); } catch {}
  }
  sheetFocus = null;
}

function busyClick(button, handler) {
  button.addEventListener('click', async event => {
    if (button.disabled) return;
    button.disabled = true;
    try { await handler(event); }
    catch { toast('That action could not be completed. Please try again.'); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  return button;
}
function menuButton(label, handler, className = 'ghost') {
  return busyClick(E.button({ class: className, type: 'button' }, label), handler);
}
function openMenu() {
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = 'Menu';
  body.textContent = '';
  const counts = store.counts();
  body.append(E.div({ class: 'banner' }, `Hi${store.settings.name ? `, ${store.settings.name}` : ''}. Everything below is stored locally on this device.`));

  const sections = [
    ['task', 'Tasks'], ['reminder', 'Reminders'], ['note', 'Notes'], ['person', 'People'], ['photo', 'Photos'],
    ['event', 'Events'], ['money', 'Money'], ['debt', 'Debts'], ['stockItem', 'Stock'], ['habit', 'Habits'], ['journal', 'Journal']
  ];
  for (const [kind, label] of sections) {
    const row = E.button({ class: 'srow', type: 'button' },
      E.div({ class: 'em', 'aria-hidden': 'true' }, kindIcon(kind)),
      E.div({ class: 'tx' }, E.b({}, `${label} · ${counts[kind] || 0}`), E.small({}, sectionHint(kind))));
    row.addEventListener('click', () => { closeSheet(); listKind(kind); });
    body.append(row);
  }
  body.append(E.div({ class: 'hr' }));
  const caps = getCaps();
  if (caps.files.picker) body.append(menuButton('🖼️ Add a photo', () => { closeSheet(); runAction({ id: ACTION.PHOTO_PICK, args: {} }); }));
  if (caps.files.captureCamera) body.append(menuButton('📸 Take a photo', () => { closeSheet(); runAction({ id: ACTION.CAMERA_PICK, args: {} }); }));
  if (caps.contacts.select) body.append(menuButton('👤 Import device contacts', () => { closeSheet(); runAction({ id: ACTION.CONTACT_PICK, args: {} }); }));
  body.append(menuButton('🔗 Share today’s plan', () => { closeSheet(); runAction({ id: ACTION.SHARE, args: { title: 'Brain — Today’s plan', text: brain._sharePlanText() } }); }));
  body.append(menuButton('💾 Back up my data', () => { closeSheet(); doExport(); }));
  body.append(menuButton('⚙️ Settings', () => openSettings()));
  body.append(menuButton('🧰 Device capabilities', () => openDiagnostics()));
  body.append(menuButton('✨ Add sample data', () => { closeSheet(); loadDemo(); }));
  openSheet();
}
function sectionHint(kind) {
  const hints = {
    task: 'Complete, edit, reschedule or delete', reminder: 'Snooze, complete, edit or delete', note: 'Copy, share, edit or delete',
    person: 'Call, text, email, map or copy', photo: 'View, save, share or delete', event: 'Calendar, maps, share or edit',
    money: 'Review, copy, share, edit or delete', debt: 'Settle, edit or delete', stockItem: 'Adjust, review history, edit or delete',
    habit: 'Log, edit or delete', journal: 'Share, edit or delete'
  };
  return hints[kind] || '';
}
function listKind(kind) {
  const items = store.list(kind);
  const label = ({ task: 'tasks', reminder: 'reminders', note: 'notes', person: 'people', photo: 'photos', event: 'events', money: 'money records', debt: 'debts', stockItem: 'stock items', habit: 'habits', journal: 'journal entries' })[kind] || kind;
  if (!items.length) { pushBot(`No ${label} yet.`); return; }
  const latest = items.slice().sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt))).slice(0, 40);
  pushBot(`Your ${label}:`, latest.map(record => ({ kind, id: record.id })));
}

// ---------- Settings and diagnostics ----------
function field(label, input, note = '') {
  const id = input.id || `brain-field-${++sheetFieldId}`;
  input.id = id;
  const wrap = E.div({ class: 'field' }, E.label({ for: id }, label), input);
  if (note) {
    const noteId = `${id}-note`;
    input.setAttribute('aria-describedby', noteId);
    wrap.append(E.div({ class: 'fieldnote', id: noteId }, note));
  }
  return wrap;
}
function openSettings() {
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = 'Settings';
  body.textContent = '';
  const current = store.settings;
  const name = E.input({ value: current.name, placeholder: 'Your name', autocomplete: 'name' });
  const currency = E.select({}, CURRENCIES.map(value => E.option({ value, selected: current.currency === value || null }, value)));
  const locale = E.select({}, LOCALES.map(value => E.option({ value, selected: current.locale === value || null }, value)));
  const countryCode = E.input({ type: 'tel', inputmode: 'numeric', value: current.countryCode || '', placeholder: 'e.g. 91', maxlength: '3' });
  body.append(field('Your name', name));
  body.append(field('Currency', currency));
  body.append(field('Number and date format', locale));
  body.append(field('WhatsApp country code (optional)', countryCode, 'Needed only when saved numbers do not start with +. Brain never guesses a country code.'));
  const save = E.button({ class: 'primary', type: 'button' }, 'Save settings');
  busyClick(save, async () => {
    const saved = await store.updateSettings({ name: name.value.trim(), currency: currency.value, locale: locale.value, countryCode: countryCode.value.replace(/\D/g, '') });
    if (!saved) { toast('Could not save settings. Check device storage and try again.'); return; }
    brain.name = store.settings.name;
    setTitle();
    closeSheet();
    toast('Settings saved.');
    renderAll();
  });
  body.append(save, E.div({ class: 'hr' }));

  const caps = getCaps();
  if (caps.notifications.supported) {
    const notificationRow = E.div({ class: 'toggle' }, E.div({ class: 'tt' }, 'Notifications', E.small({}, reminderCapability())), makeToggle(current.notifEnabled && perm() === 'granted', async enabled => {
      if (!enabled) {
        const saved = await store.updateSettings({ notifEnabled: false });
        if (!saved) toast('Could not save this setting.');
        return !!saved;
      }
      const permission = await requestPermission();
      if (permission === 'granted') {
        const saved = await store.updateSettings({ notifEnabled: true });
        if (!saved) toast('Notification permission was granted, but Brain could not save this setting.');
        return !!saved;
      }
      toast(permission === 'denied' ? 'Notifications are blocked by the browser. Reminders still appear when Brain runs.' : 'Notifications are unavailable here.');
      return false;
    }, 'Notifications'));
    body.append(notificationRow);
  } else body.append(E.div({ class: 'note' }, 'Notifications are not exposed by this browser. Brain will still show reminders whenever it is open.'));
  const reduced = E.div({ class: 'toggle' }, E.div({ class: 'tt' }, 'Reduce motion', E.small({}, 'Removes non-essential movement in Brain')), makeToggle(!!current.reducedMotion, async enabled => {
    const saved = await store.updateSettings({ reducedMotion: enabled });
    if (!saved) { toast('Could not save this setting.'); return false; }
    document.documentElement.classList.toggle('reduce', enabled);
    return true;
  }, 'Reduce motion'));
  body.append(reduced, E.div({ class: 'hr' }));
  if (caps.files.picker) body.append(menuButton('📂 Restore from a backup', openRestorePicker));
  body.append(menuButton('💾 Back up (save file)', () => { closeSheet(); doExport(); }));
  const erase = menuButton('🗑️ Erase all local data', eraseAll, 'ghost danger');
  body.append(erase);
  body.append(E.div({ class: 'note' }, 'Privacy: data stays in this browser’s local storage (usually IndexedDB). Keep a backup before clearing browser/site data.'));
  body.append(E.div({ class: 'note' }, 'Reminder limitation: browsers cannot guarantee a timer once the OS fully suspends or closes the app. Brain catches up when it runs again; it does not claim guaranteed background alarms.'));
  openSheet();
}
function makeToggle(on, callback, labelText = 'setting') {
  const input = E.input({ type: 'checkbox', 'aria-label': `Enable or disable ${labelText}` });
  input.checked = !!on;
  const label = E.label({ class: 'switch' }, input, E.i({ 'aria-hidden': 'true' }));
  input.addEventListener('change', async event => {
    const prior = !event.target.checked;
    input.disabled = true;
    try {
      const accepted = await callback(event.target.checked);
      if (accepted === false) event.target.checked = prior;
    } catch {
      event.target.checked = prior;
      toast(`Could not update ${labelText}.`);
    } finally { input.disabled = false; }
  });
  return label;
}
function openDiagnostics() {
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = 'Device capabilities';
  body.textContent = '';
  const caps = getCaps();
  const platform = isStandalone() ? 'Installed PWA' : isMobileUA() ? (isIOS() ? 'iOS browser' : isAndroid() ? 'Android browser' : 'Mobile browser') : 'Desktop browser';
  const rows = [
    ['Platform', platform], ['Online now', caps.platform.online ? 'yes' : 'no — Brain’s core data still works offline'],
    ['Notifications', !caps.notifications.supported ? 'not exposed' : caps.notifications.permission],
    ['Service worker', caps.sw.supported ? (caps.sw.controlled ? 'active' : 'supported; awaiting control') : 'not exposed'],
    ['Push API', caps.notifications.pushApi ? 'browser supports it, but Brain has no push server' : 'not exposed'],
    ['Background alarms', 'not guaranteed by web browsers; Brain catches up when it can run'],
    ['Native share sheet', caps.share.webShare ? (caps.share.shareFiles ? 'text and files' : 'text') : 'not exposed — copy/download fallback'],
    ['File picker', caps.files.picker ? 'available' : 'not exposed'], ['File System Access', caps.files.fileSystemAccess ? 'available' : 'not exposed'],
    ['Camera picker', caps.files.captureCamera ? 'available' : 'not exposed'], ['Microphone / voice', caps.speech.recognition ? 'speech recognition available' : 'not exposed'],
    ['Location', caps.geolocation.supported ? 'asks when you tap an action' : 'not exposed'],
    ['Contacts Picker', caps.contacts.select ? 'can copy selected contacts into Brain' : 'not exposed'],
    ['Clipboard', caps.clipboard.write ? 'write available' : caps.clipboard.legacyCopy ? 'legacy copy fallback' : 'manual copy only']
  ];
  for (const [name, value] of rows) body.append(E.div({ class: 'diag' }, E.div({ class: 'dn' }, name), E.div({ class: 'dv' }, value)));
  body.append(E.div({ class: 'note' }, 'Brain only presents direct external actions that use standard browser links/APIs. Instagram and WhatsApp actions open their supported routes; Brain cannot post or send on your behalf.'));
  openSheet();
}

// ---------- Backup, restore, sample data ----------
async function doExport() {
  try {
    const snapshot = await store.exportState();
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const result = await Ext.saveBlob(blob, `brain-backup-${todayKey()}.json`, {
      types: [{ description: 'Brain backup', accept: { 'application/json': ['.json'] } }]
    });
    if (result.ok) {
      await store.updateSettings({ lastBackupAt: new Date().toISOString() });
      toast(result.method === 'picker' ? 'Backup saved.' : 'Backup downloaded. Keep it somewhere safe.');
    } else if (!result.cancelled) toast(result.message || 'Could not save the backup.');
  } catch (error) { toast('Could not create a backup. Check device storage and try again.'); }
}
function openRestorePicker() {
  const input = E.input({ type: 'file', accept: 'application/json,.json', style: 'display:none', 'aria-hidden': 'true' });
  input.addEventListener('change', () => handleImport(input));
  input.addEventListener('cancel', () => { input.remove(); toast('Restore cancelled.'); }, { once: true });
  document.body.append(input);
  // Not every browser emits `cancel` for native pickers. Remove the temporary
  // input when focus comes back without a selected file so it cannot linger.
  setTimeout(() => window.addEventListener('focus', () => {
    setTimeout(() => {
      if (input.isConnected && !(input.files && input.files.length)) { input.remove(); toast('Restore cancelled.'); }
    }, 350);
  }, { once: true }), 0);
  try { input.click(); } catch { input.remove(); toast('Could not open the file picker.'); }
}
async function textFromFile(file) {
  if (file && typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.readAsText(file);
  });
}
async function handleImport(input) {
  const file = input.files && input.files[0];
  input.remove();
  if (!file) return;
  if (file.size > BACKUP_MAX_BYTES) { toast('That backup is too large (maximum 25 MB).'); return; }
  try {
    const raw = await textFromFile(file);
    const info = previewImport(raw);
    showRestoreOptions(raw, info);
  } catch (error) {
    toast(error && error.message === 'backup-too-large' ? 'That backup is too large (maximum 25 MB).' : 'That file is not a valid Brain backup.');
  }
}
function showRestoreOptions(raw, info) {
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = 'Restore backup';
  body.textContent = '';
  body.append(E.div({ class: 'banner' }, `Found ${info.total} valid item${info.total === 1 ? '' : 's'} in this backup.${info.errors.length ? ` ${info.errors.length} collection${info.errors.length === 1 ? '' : 's'} contain invalid or duplicate records that will be skipped.` : ''}`));
  const merge = E.button({ class: 'primary', type: 'button' }, 'Merge (keep current data)');
  const replace = E.button({ class: 'ghost', type: 'button' }, 'Replace all data');
  const cancel = E.button({ class: 'ghost', type: 'button' }, 'Cancel');
  busyClick(merge, () => applyImport(raw, 'merge'));
  busyClick(replace, () => {
    if (window.confirm('Replace all current Brain data with this backup? This cannot be undone.')) return applyImport(raw, 'replace');
    return null;
  });
  busyClick(cancel, closeSheet);
  body.append(merge, replace, cancel, E.div({ class: 'note' }, 'Merge skips records already present by ID or content. Replace uses only validated records from this backup.'));
  openSheet();
}
function validatedBackupCollections(data) {
  const output = {};
  for (const kind of V.COLLECTIONS) {
    const records = Array.isArray(data.collections && data.collections[kind]) ? data.collections[kind] : [];
    const ids = new Set();
    output[kind] = [];
    for (const raw of records) {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id || ids.has(raw.id)) continue;
      const record = V.sanitizeRecord(kind, raw);
      if (!record || (kind === 'photo' && !record.dataUrl)) continue;
      ids.add(raw.id);
      output[kind].push(record);
    }
  }
  return output;
}
async function applyImport(raw, mode) {
  if (restoreBusy) return { ok: false, message: 'A restore is already in progress.' };
  restoreBusy = true;
  try {
    const info = previewImport(raw);
    let result;
    if (mode === 'merge') result = await store.mergeBackup(raw);
    else {
      const data = JSON.parse(raw);
      result = await store.replaceAll(validatedBackupCollections(data), data.settings);
    }
    if (!result.ok) { toast('Could not restore the backup. Your current data was kept.'); return result; }
    closeSheet();
    renderAll();
    if (mode === 'merge') toast(`Merged ${result.added} item${result.added === 1 ? '' : 's'}; skipped ${result.duplicates} duplicate${result.duplicates === 1 ? '' : 's'}.`);
    else toast(`Restored ${info.total} validated item${info.total === 1 ? '' : 's'}.`);
    return result;
  } catch {
    toast('Could not restore that backup. Your current data was kept.');
    return { ok: false };
  } finally { restoreBusy = false; }
}
async function eraseAll() {
  if (!window.confirm('Erase all Brain data stored on this device? This cannot be undone.')) return;
  const result = await store.wipe();
  if (!result.ok) { toast('Could not erase all data. Please try again.'); return; }
  blocks.length = 0;
  renderAll();
  closeSheet();
  pushBot('Everything stored by Brain on this device has been erased.');
}
async function loadDemo() {
  if (!window.confirm('Add sample data to your existing Brain data? Existing records will not be erased.')) return;
  let added = 0;
  let skipped = 0;
  const addIfMissing = (kind, matcher, record) => {
    if (store.list(kind).some(matcher)) return;
    if (store.addSync(kind, record)) added += 1;
    else skipped += 1;
  };
  addIfMissing('person', person => person.name === 'Sample Mom', { name: 'Sample Mom', phone: '+919876500001', relationship: 'family' });
  addIfMissing('task', task => task.title === 'Sample: submit the report', { title: 'Sample: submit the report', due: daysFromNow(1, 17) });
  addIfMissing('reminder', reminder => reminder.title === 'Sample: take medicine', { title: 'Sample: take medicine', at: daysFromNow(0, 20) });
  addIfMissing('note', note => note.title === 'Sample note', { title: 'Sample note', body: 'This is safe sample data. Delete it any time.' });
  addIfMissing('stockItem', item => item.name === 'Sample rice', { name: 'Sample rice', qty: 1, unit: 'kg', lowThreshold: 2 });
  addIfMissing('event', event => event.title === 'Sample appointment', { title: 'Sample appointment', at: daysFromNow(2, 15), end: daysFromNow(2, 16), kind: 'appointment', allDay: false });
  const flush = await store.flush();
  if (!flush.ok) { toast('Sample data could not be saved.'); return; }
  if (!added) { toast(skipped ? 'Sample data could not be added because storage is full.' : 'Those sample records are already present.'); return; }
  pushBot(`Added ${added} sample item${added === 1 ? '' : 's'} without removing anything you already had.${skipped ? ` ${skipped} could not be added.` : ''}`);
}
function daysFromNow(days, hour) { const date = new Date(); date.setDate(date.getDate() + days); date.setHours(hour, 0, 0, 0); return date.toISOString(); }

// ---------- Central action executor ----------
async function runAction(action) {
  if (!action || !action.id) return { ok: false, message: 'That action is unavailable.' };
  // Tapping a direct choice resolves its pending contact question. The choice
  // remains a normal capability-aware action rather than a special fake flow.
  if (action.clearPending && brain && brain.ctx) brain.ctx.clearPending();
  const args = action.args || {};
  try {
    let result;
    switch (action.id) {
      case ACTION.CALL: result = Ext.launchCall(args.number); break;
      case ACTION.SMS: result = Ext.launchSms(args.number, args.body || ''); break;
      case ACTION.WHATSAPP: result = Ext.launchWhatsApp(args.number, args.text || args.body || '', { countryCode: args.countryCode || store.settings.countryCode || '' }); break;
      case ACTION.EMAIL: result = Ext.launchEmail(args.email, { subject: args.subject || '', body: args.body || '' }); break;
      case ACTION.MAPS: result = Ext.launchMaps(args.query, { directions: !!args.directions, origin: args.origin || '' }); break;
      case ACTION.OPEN: result = Ext.openUrl(args.url); break;
      case ACTION.COPY: result = await Ext.launchCopy(args.text || ''); break;
      case ACTION.SHARE: {
        const files = shareFilesFor(args);
        if (args.photoId && !files.length) {
          toast('That photo is no longer available to share.');
          return { ok: false, message: 'Photo unavailable.' };
        }
        result = await Ext.launchShare({ title: args.title || 'Brain', text: args.text || '', url: args.url || '', files });
        break;
      }
      case ACTION.CALENDAR: result = await Ext.launchCalendar(Ext.buildIcs(args), calendarFilename(args.title)); break;
      case ACTION.PHOTO_PICK: return photoPick({ ...args, capture: false });
      case ACTION.CAMERA_PICK:
        if (!getCaps().files.captureCamera) { toast('Camera capture is not exposed by this browser — choose a photo instead.'); return photoPick({ ...args, capture: false }); }
        return photoPick({ ...args, capture: true });
      case ACTION.CONTACT_PICK: return importDeviceContacts();
      case ACTION.LOCATION_CURRENT: return openCurrentLocation();
      case ACTION.PHOTO_VIEW: return viewPhoto(args.id);
      case ACTION.PHOTO_DOWNLOAD: return downloadPhoto(args.id, args);
      case ACTION.RECORD_EDIT: return openEditor(args.kind, args.id);
      case ACTION.RECORD_DELETE: return deleteRecord(args.kind, args.id);
      case ACTION.TASK_COMPLETE: return mutate(() => Domain.completeTask(store, args.id), 'Task completed.');
      case ACTION.TASK_REOPEN: return mutate(() => Domain.reopenTask(store, args.id), 'Task reopened.');
      case ACTION.REMINDER_COMPLETE: return mutate(() => Domain.completeReminder(store, args.id), 'Reminder updated.');
      case ACTION.REMINDER_SNOOZE: return mutate(() => Domain.snoozeReminder(store, args.id, args.minutes || 10), 'Reminder snoozed.');
      case ACTION.DEBT_TOGGLE: return toggleDebt(args.id);
      case ACTION.STOCK_BUMP: return bumpStock(args.id, args.delta);
      case ACTION.HABIT_LOG: return logHabit(args.id);
      default: return { ok: false, message: 'That action is not available.' };
    }
    if (result && result.message) toast(result.message);
    return result || { ok: true };
  } catch (error) {
    toast('That action could not be completed. Please try again.');
    return { ok: false, message: 'Action failed.' };
  }
}
async function mutate(operation, fallbackMessage) {
  const result = operation();
  if (!result) { toast('That item is no longer available.'); return { ok: false }; }
  const flushed = await store.flush();
  renderAll();
  if (!flushed.ok) { toast('Could not save that change.'); return { ok: false }; }
  toast(result.text || fallbackMessage);
  return { ok: true, result };
}
async function deleteRecord(kind, id) {
  const record = store.get(kind, id);
  if (!record) { toast('That item is no longer available.'); return { ok: false }; }
  const label = record.title || record.name || record.person || 'this item';
  if (!window.confirm(`Delete “${label}”?`)) return { ok: false, cancelled: true };
  const removed = await store.remove(kind, id);
  if (!removed) { toast('Could not save that deletion. Your item was kept.'); return { ok: false }; }
  renderAll();
  toast('Deleted.');
  return { ok: true };
}
async function toggleDebt(id) {
  const debt = store.get('debt', id);
  if (!debt) return { ok: false };
  const saved = await store.update('debt', id, { status: debt.status === 'settled' ? 'open' : 'settled', settledAt: debt.status === 'settled' ? null : new Date().toISOString() });
  if (!saved) { toast('Could not save that change. Your debt was kept as-is.'); return { ok: false }; }
  renderAll();
  toast(debt.status === 'settled' ? 'Debt reopened.' : 'Debt settled.');
  return { ok: true };
}
async function bumpStock(id, delta) {
  const item = store.get('stockItem', id);
  if (!item) return { ok: false };
  const amount = Number(delta) || 0;
  const history = [...(item.history || []), { at: new Date().toISOString(), delta: amount, note: '' }].slice(-300);
  const saved = await store.update('stockItem', id, { qty: Math.max(0, Number(item.qty || 0) + amount), history });
  if (!saved) { toast('Could not save stock. Your quantity was kept as-is.'); return { ok: false }; }
  renderAll();
  toast('Stock updated.');
  return { ok: true };
}
async function logHabit(id) {
  const habit = store.get('habit', id);
  if (!habit) return { ok: false };
  const key = todayKey();
  const alreadyLogged = (habit.log || []).includes(key);
  if (alreadyLogged) { toast('Already logged today.'); return { ok: true, already: true }; }
  const log = [...new Set([...(habit.log || []), key])];
  const saved = await store.update('habit', id, { log });
  if (!saved) { toast('Could not save this habit. Your log was kept as-is.'); return { ok: false }; }
  renderAll();
  toast('Habit logged for today.');
  return { ok: true };
}

function shareFilesFor(args) {
  if (args.files) return Array.isArray(args.files) ? args.files.filter(Boolean) : [args.files].filter(Boolean);
  if (args.photoId) {
    const photo = store.get('photo', args.photoId);
    const file = photo ? photoAsFile(photo) : null;
    return file ? [file] : [];
  }
  return [];
}
function photoAsFile(record) {
  try {
    const match = /^data:(image\/[\w.+-]+);base64,([a-z0-9+/=]+)$/i.exec(record.dataUrl || '');
    if (!match || typeof atob !== 'function' || typeof File !== 'function') return null;
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const extension = (match[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const name = String(record.name || `brain-photo.${extension}`).replace(/\.[a-z0-9]+$/i, '') + `.${extension}`;
    return new File([bytes], name, { type: match[1] });
  } catch { return null; }
}
function calendarFilename(title) {
  const safe = String(title || 'brain-event').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'brain-event';
  return `${safe}.ics`;
}

// ---------- Photos, contacts, location ----------
let photoPickBusy = false;
async function photoPick({ attachTo = '', capture = false } = {}) {
  if (photoPickBusy) return { ok: false, message: 'A photo picker is already open.' };
  photoPickBusy = true;
  try {
    const picked = await Ext.pickImage({ capture });
    if (picked.cancelled) { toast('No photo selected.'); return { ok: false, cancelled: true }; }
    if (picked.error) { toast(picked.error); return { ok: false, message: picked.error }; }
    const photo = store.addSync('photo', {
      name: picked.name, mime: picked.mime, size: picked.size, width: picked.width, height: picked.height, dataUrl: picked.dataUrl
    });
    if (!photo) { toast('Could not store that photo. Device storage may be full.'); return { ok: false }; }
    let journal = null;
    let attachmentFailed = false;
    if (attachTo === 'journal') {
      const today = todayKey();
      const currentJournal = store.list('journal').slice().reverse().find(entry => todayKey(new Date(entry.date)) === today) || null;
      journal = currentJournal
        ? store.updateSync('journal', currentJournal.id, { photoId: photo.id })
        : store.addSync('journal', { text: 'Added a photo', mood: '', photoId: photo.id });
      attachmentFailed = !journal;
    }
    const flushed = await store.flush();
    if (!flushed.ok) {
      store.removeSync('photo', photo.id);
      await store.flush();
      toast('The photo could not be saved. Check device storage and try again.');
      return { ok: false };
    }
    if (journal) brain.ctx.push('journal', journal.id, journal.text || 'journal entry');
    brain.ctx.push('photo', photo.id, photo.name || 'photo');
    renderAll();
    const message = journal ? 'Photo saved with your journal entry.' : attachmentFailed
      ? 'Photo saved, but Brain could not attach it to a journal entry.'
      : 'Photo saved on this device.';
    pushBot(message, [{ kind: 'photo', id: photo.id }, ...(journal ? [{ kind: 'journal', id: journal.id }] : [])]);
    toast(journal ? 'Photo attached to your journal.' : attachmentFailed ? 'Photo saved, but it was not attached.' : 'Photo saved.');
    return { ok: true, photo, journal, attachmentFailed };
  } finally { photoPickBusy = false; }
}
function viewPhoto(id) {
  const photo = store.get('photo', id);
  if (!photo || !V.isSafeImageDataUrl(photo.dataUrl)) { toast('That photo is unavailable.'); return { ok: false }; }
  if (brain && brain.ctx) brain.ctx.push('photo', photo.id, photo.name || 'photo');
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = photo.name || 'Photo';
  body.textContent = '';
  body.append(E.div({ class: 'center' }, E.img({ class: 'photoView', src: photo.dataUrl, alt: photo.name || 'Saved photo' })));
  const actions = E.div({ class: 'actbar' });
  actions.append(menuButton(getCaps().share.shareFiles ? '🔗 Share' : '💾 Save / share', () => runAction({ id: ACTION.SHARE, args: { title: photo.name || 'Photo', text: 'Photo from Brain', photoId: photo.id } })));
  actions.append(menuButton('💾 Save copy', () => runAction({ id: ACTION.PHOTO_DOWNLOAD, args: { id: photo.id } })));
  actions.append(menuButton('🗑️ Delete', () => runAction({ id: ACTION.RECORD_DELETE, args: { kind: 'photo', id: photo.id } }), 'ghost danger'));
  body.append(actions);
  openSheet();
  return { ok: true };
}
async function downloadPhoto(id, args = {}) {
  const photo = store.get('photo', id) || (args.dataUrl ? args : null);
  const file = photo ? photoAsFile(photo) : null;
  if (!file) { toast('That photo cannot be saved.'); return { ok: false }; }
  const result = await Ext.downloadFile(file);
  if (result.message) toast(result.message);
  return result;
}
async function importDeviceContacts() {
  const outcome = await Ext.pickDeviceContacts({ multiple: true });
  if (!outcome.ok) { if (!outcome.cancelled) toast(outcome.message); return outcome; }
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const incoming of outcome.contacts) {
    const phoneDigits = String(incoming.phone || '').replace(/\D/g, '');
    const email = String(incoming.email || '').trim().toLowerCase();
    const name = String(incoming.name || '').trim();
    let existing = store.list('person').find(person => {
      const samePhone = phoneDigits && String(person.phone || '').replace(/\D/g, '') === phoneDigits;
      const sameEmail = email && String(person.email || '').toLowerCase() === email;
      const sameName = name && String(person.name || '').toLowerCase() === name.toLowerCase();
      // Names alone are not a safe identity when both contacts have a distinct
      // phone/email. Use a name match only to enrich a detail-less local card.
      const personHasIdentity = !!String(person.phone || '').replace(/\D/g, '') || !!String(person.email || '').trim();
      return samePhone || sameEmail || (sameName && ((!phoneDigits && !email) || !personHasIdentity));
    });
    if (existing) {
      const saved = store.updateSync('person', existing.id, { phone: existing.phone || incoming.phone, email: existing.email || incoming.email, name: existing.name || name });
      if (saved) updated += 1;
      else skipped += 1;
    } else if (name || incoming.phone || incoming.email) {
      const saved = store.addSync('person', { name: name || incoming.phone || incoming.email, phone: incoming.phone, email: incoming.email });
      if (saved) added += 1;
      else skipped += 1;
    }
  }
  const flushed = await store.flush();
  renderAll();
  if (!flushed.ok) { toast('Contacts were selected, but Brain could not save them.'); return { ok: false }; }
  toast(`Copied ${added} new contact${added === 1 ? '' : 's'}${updated ? ` and updated ${updated}` : ''}${skipped ? `; ${skipped} could not be saved.` : ''} into Brain.`);
  return { ok: true, added, updated, skipped };
}
async function openCurrentLocation() {
  const location = await Ext.getCurrentLocation();
  if (!location.ok) { toast(location.message); return location; }
  // Use the HTTPS directions handoff instead of a geo: URI: it works in
  // browsers without a native geo handler as well as on phones.
  const result = Ext.launchMaps(`${location.latitude},${location.longitude}`, { directions: true, sameTab: true });
  if (result.message) toast(result.message);
  return result;
}

// ---------- Editors ----------
const EDIT_FIELDS = {
  task: { title: 'text', note: 'textarea', due: 'datetime' },
  note: { title: 'text', body: 'textarea' },
  person: { name: 'text', phone: 'tel', email: 'email', address: 'textarea', birthday: 'text', relationship: 'text', aliases: 'aliases', instagram: 'text', notes: 'textarea' },
  money: { category: 'text', amount: 'number', date: 'datetime' },
  debt: { person: 'text', amount: 'number' },
  stockItem: { name: 'text', unit: 'text', qty: 'number', lowThreshold: 'number' },
  habit: { name: 'text' },
  journal: { text: 'textarea', mood: 'text', date: 'datetime' },
  event: { title: 'text', kind: 'text', at: 'datetime', end: 'datetime', allDay: 'checkbox', location: 'textarea', notes: 'textarea' }
};
function openEditor(kind, id) {
  if (kind === 'reminder') return openReminderEditor(id);
  const record = store.get(kind, id);
  const fields = EDIT_FIELDS[kind];
  if (!record || !fields) { toast('That item cannot be edited here.'); return { ok: false }; }
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = `Edit ${humanKind(kind)}`;
  body.textContent = '';
  const inputs = {};
  for (const [name, type] of Object.entries(fields)) {
    let input;
    const value = record[name];
    if (type === 'textarea') input = E.textarea({ class: 'ed' }, value == null ? '' : value);
    else if (type === 'datetime') input = E.input({ type: 'datetime-local', class: 'ed', value: value ? toLocalInput(value) : '' });
    else if (type === 'checkbox') { input = E.input({ type: 'checkbox' }); input.checked = !!value; }
    else if (type === 'aliases') input = E.input({ type: 'text', class: 'ed', value: (value || []).join(', '), placeholder: 'Comma-separated aliases' });
    else input = E.input({ type, class: 'ed', value: value == null ? '' : String(value), inputmode: type === 'number' ? 'decimal' : null });
    inputs[name] = input;
    body.append(field(name === 'allDay' ? 'All day' : humanField(name), input));
  }
  let taskSchedule = null;
  if (kind === 'task') {
    const mode = E.select({}, E.option({ value: 'once', selected: !record.recur || null }, 'One time'), E.option({ value: 'repeat', selected: record.recur || null }, 'Repeats'));
    const freq = E.select({}, ['daily', 'weekly', 'monthly', 'yearly'].map(value => E.option({ value, selected: record.recur && record.recur.freq === value || null }, value[0].toUpperCase() + value.slice(1))));
    const interval = E.input({ type: 'number', min: '1', max: '60', step: '1', value: String(record.recur && record.recur.interval || 1), inputmode: 'numeric' });
    const time = E.input({ type: 'time', value: record.recur ? record.recur.time || '09:00' : '09:00' });
    const days = E.input({ type: 'text', value: record.recur && record.recur.days ? record.recur.days.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ') : '', placeholder: 'Mon, Wed (weekly only)' });
    const repeatFields = E.div({ class: 'schedule-fields' }, field('Repeat', freq), field('Every', interval, 'For example, 2 repeats every 2 days, weeks, months, or years.'), field('Time', time), field('Days', days, 'For weekly tasks; leave blank to use the scheduled start day.'));
    const modeField = field('Schedule', mode);
    const toggle = () => { repeatFields.hidden = mode.value !== 'repeat'; };
    mode.addEventListener('change', toggle);
    body.append(modeField, repeatFields);
    toggle();
    taskSchedule = { mode, freq, interval, time, days };
  }
  const save = E.button({ class: 'primary', type: 'button' }, 'Save changes');
  busyClick(save, async () => {
    const patch = {};
    for (const [name, type] of Object.entries(fields)) {
      const input = inputs[name];
      if (type === 'datetime') {
        const date = input.value ? new Date(input.value) : null;
        if (input.value && Number.isNaN(date.getTime())) { toast(`Choose a valid ${humanField(name)}.`); return; }
        patch[name] = date ? date.toISOString() : null;
      } else if (type === 'number') {
        const value = input.value === '' ? null : Number(input.value);
        if ((kind === 'money' || kind === 'debt') && name === 'amount' && value == null) { toast('Enter an amount.'); return; }
        if (value != null && (!Number.isFinite(value) || value < 0)) { toast(`Choose a non-negative number for ${humanField(name)}.`); return; }
        patch[name] = value;
      } else if (type === 'checkbox') patch[name] = input.checked;
      else if (type === 'aliases') patch[name] = input.value.split(',').map(value => value.trim()).filter(Boolean);
      else patch[name] = input.value;
    }
    if (kind === 'event' && patch.at && patch.end && new Date(patch.end) < new Date(patch.at)) { toast('End time cannot be before the start time.'); return; }
    if (kind === 'task' && taskSchedule) {
      if (taskSchedule.mode.value !== 'repeat') {
        patch.recur = null;
        patch.nextTaskId = null;
      } else {
        const proposed = patch.due ? new Date(patch.due) : null;
        const anchorDate = proposed && !Number.isNaN(proposed.getTime())
          ? proposed
          : new Date(record.recur && record.recur.anchor || record.due || record.createdAt || Date.now());
        const recurrence = {
          freq: taskSchedule.freq.value,
          interval: Math.max(1, Math.min(60, Math.round(Number(taskSchedule.interval.value) || 1))),
          time: taskSchedule.time.value || '09:00',
          anchor: !Number.isNaN(anchorDate.getTime()) ? anchorDate.toISOString() : new Date().toISOString()
        };
        const selectedDays = parseDays(taskSchedule.days.value);
        if (recurrence.freq === 'weekly') recurrence.days = selectedDays.length ? selectedDays : [anchorDate.getDay()];
        if (recurrence.freq === 'monthly') recurrence.dayOfMonth = anchorDate.getDate();
        if (recurrence.freq === 'yearly') { recurrence.dayOfMonth = anchorDate.getDate(); recurrence.monthOfYear = anchorDate.getMonth(); }
        patch.recur = recurrence;
        const next = nextOccurrence(recurrence, new Date());
        if (next) patch.due = next.toISOString();
      }
    }
    const saved = await store.update(kind, id, patch);
    if (!saved) { toast('Could not save those changes. Your original item was kept.'); return; }
    closeSheet(); renderAll(); toast('Saved.');
  });
  body.append(save, menuButton('Cancel', closeSheet));
  openSheet();
  return { ok: true };
}
function openReminderEditor(id) {
  const record = store.get('reminder', id);
  if (!record) { toast('That reminder is no longer available.'); return { ok: false }; }
  const body = $('#sheetBody');
  $('#sheetTitle').textContent = 'Edit reminder';
  body.textContent = '';
  const title = E.input({ type: 'text', value: record.title || '' });
  const mode = E.select({}, E.option({ value: 'once', selected: !record.recur || null }, 'One time'), E.option({ value: 'repeat', selected: record.recur || null }, 'Repeats'));
  const at = E.input({ type: 'datetime-local', value: record.at ? toLocalInput(record.at) : '' });
  const freq = E.select({}, ['daily', 'weekly', 'monthly', 'yearly'].map(value => E.option({ value, selected: record.recur && record.recur.freq === value || null }, value[0].toUpperCase() + value.slice(1))));
  const interval = E.input({ type: 'number', min: '1', max: '60', step: '1', value: record.recur ? String(record.recur.interval || 1) : '1', inputmode: 'numeric' });
  const time = E.input({ type: 'time', value: record.recur ? record.recur.time || '09:00' : '09:00' });
  const days = E.input({ type: 'text', value: record.recur && record.recur.days ? record.recur.days.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ') : '', placeholder: 'Mon, Wed (weekly only)' });
  const repeatFields = E.div({ class: 'schedule-fields' }, field('Repeat', freq), field('Every', interval, 'For example, 2 repeats every 2 days, weeks, months, or years.'), field('Time', time), field('Days', days, 'For weekly reminders; leave blank to repeat on the original weekday.'));
  const onceField = field('Date and time', at);
  const toggleMode = () => { onceField.hidden = mode.value !== 'once'; repeatFields.hidden = mode.value !== 'repeat'; };
  mode.addEventListener('change', toggleMode);
  body.append(field('Title', title), field('Schedule', mode), onceField, repeatFields);
  toggleMode();
  const save = E.button({ class: 'primary', type: 'button' }, 'Save changes');
  busyClick(save, async () => {
    let patch;
    if (mode.value === 'once') {
      const selectedAt = at.value ? new Date(at.value) : null;
      if (!selectedAt || Number.isNaN(selectedAt.getTime())) { toast('Choose a valid date and time for this reminder.'); return; }
      if (selectedAt <= new Date()) { toast('Choose a future date and time for this reminder.'); return; }
      patch = { title: title.value, at: selectedAt.toISOString(), recur: null, status: 'active', lastFiredKey: null, nextAt: null, snoozedUntil: null };
    } else {
      const selectedDays = parseDays(days.value);
      const recurrence = {
        freq: freq.value,
        interval: Math.max(1, Math.min(60, Math.round(Number(interval.value) || 1))),
        time: time.value || '09:00', anchor: record.recur && record.recur.anchor || record.createdAt || new Date().toISOString()
      };
      if (freq.value === 'weekly') recurrence.days = selectedDays.length ? selectedDays : [new Date().getDay()];
      if (freq.value === 'monthly') recurrence.dayOfMonth = record.recur && record.recur.dayOfMonth || new Date().getDate();
      if (freq.value === 'yearly') { recurrence.dayOfMonth = record.recur && record.recur.dayOfMonth || new Date().getDate(); recurrence.monthOfYear = record.recur && record.recur.monthOfYear != null ? record.recur.monthOfYear : new Date().getMonth(); }
      patch = { title: title.value, at: null, recur: recurrence, status: 'active', snoozedUntil: null, ...Domain.recurringReminderSchedule(recurrence) };
    }
    const saved = await store.update('reminder', id, patch);
    if (!saved) { toast('Could not save that reminder. Your original reminder was kept.'); return; }
    closeSheet(); renderAll(); toast('Reminder saved.');
  });
  body.append(save, menuButton('Cancel', closeSheet));
  openSheet();
  return { ok: true };
}
function parseDays(value) {
  const map = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  return [...new Set(String(value || '').toLowerCase().split(/[,\s]+/).map(day => map[day]).filter(day => Number.isInteger(day)))].sort((a, b) => a - b);
}
function humanKind(kind) { return kind.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase()); }
function humanField(name) { return name.replace(/([A-Z])/g, ' $1').replace(/^./, char => char.toUpperCase()); }
function toLocalInput(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const two = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

// ---------- Notifications, service worker, lifecycle ----------
async function showSystemNotification(text, reminder) {
  if (store.settings.notifEnabled === false || perm() !== 'granted') return;
  const options = {
    body: text, tag: reminder ? `brain-reminder-${reminder.id}` : 'brain-reminder', renotify: true,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png',
    data: reminder ? { reminderId: reminder.id } : {},
    actions: reminder ? [{ action: 'snooze', title: 'Snooze 10 min' }, { action: 'complete', title: reminder.recur ? 'Dismiss today' : 'Complete' }] : []
  };
  try {
    const registration = swRegistration || (navigator.serviceWorker && await navigator.serviceWorker.ready);
    if (registration && typeof registration.showNotification === 'function') {
      await registration.showNotification('Brain', options);
      return;
    }
  } catch { /* fall back to the page Notification API */ }
  try { new Notification('Brain', options); } catch {}
}
function openReminderFromNotification(reminderId) {
  const reminder = store && store.get('reminder', reminderId);
  if (!reminder) { toast('That reminder is no longer available.'); return { ok: false }; }
  pushBot(`Reminder: ${reminder.title || 'Untitled reminder'}`, [{ kind: 'reminder', id: reminder.id }], { sys: true });
  requestAnimationFrame(() => ctx && ctx.scrollToCard(reminder.id));
  return { ok: true };
}
function wireServiceWorkerMessages() {
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('message', event => {
    const data = event.data || {};
    if (!data.reminderId) return;
    if (data.type === 'brain:reminder-open') { openReminderFromNotification(data.reminderId); return; }
    if (data.type !== 'brain:reminder-action') return;
    const id = data.action === 'snooze' ? ACTION.REMINDER_SNOOZE : ACTION.REMINDER_COMPLETE;
    runAction({ id, args: { id: data.reminderId, minutes: 10 } });
  });
}
async function handleNotificationLaunch() {
  try {
    const url = new URL(window.location.href);
    const reminderId = url.searchParams.get('brainReminderId');
    const action = url.searchParams.get('brainReminderAction');
    if (!reminderId) return;
    url.searchParams.delete('brainReminderId');
    url.searchParams.delete('brainReminderAction');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    if (!action) { openReminderFromNotification(reminderId); return; }
    await runAction({ id: action === 'snooze' ? ACTION.REMINDER_SNOOZE : ACTION.REMINDER_COMPLETE, args: { id: reminderId, minutes: 10 } });
  } catch {}
}
function wireLifecycle() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') store.flush().catch(() => {});
  });
  window.addEventListener('pagehide', () => { store.flush().catch(() => {}); });
}
function showBriefOnce() {
  const day = todayKey();
  if (store.settings.briefDate === day) return;
  const text = brief(store);
  if (text) { store.updateSettings({ briefDate: day }); pushBot(text, [], { brief: true }); }
}

// ---------- Voice input ----------
let recognizing = false;
let recognition = null;
function bootVoice() {
  if (!getCaps().speech.recognition) $('#mic').hidden = true;
}
function toggleVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) { toast('Voice input is not exposed by this browser.'); return; }
  if (recognizing && recognition) { try { recognition.stop(); } catch {} return; }
  const mic = $('#mic');
  recognition = new SpeechRecognition();
  recognition.lang = store.settings.locale || 'en';
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => { recognizing = true; mic.classList.add('on'); mic.textContent = '◉'; };
  recognition.onend = () => { recognizing = false; mic.classList.remove('on'); mic.textContent = '🎤'; };
  recognition.onerror = event => {
    recognizing = false; mic.classList.remove('on'); mic.textContent = '🎤';
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') toast('Microphone permission was denied.');
    else if (event.error !== 'aborted') toast('Voice input could not understand that. Try again.');
  };
  recognition.onresult = event => {
    const transcript = event.results && event.results[0] && event.results[0][0] ? event.results[0][0].transcript : '';
    if (!transcript) return;
    $('#in').value = transcript; autosize(); sendNow(transcript);
  };
  try { recognition.start(); } catch { toast('Voice input is already starting.'); }
}

function toast(message) {
  const element = $('#toast');
  if (!element || !message) return;
  element.textContent = String(message);
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3600);
}

function start() {
  if (!document.getElementById) return;
  boot().catch(error => {
    document.body.textContent = `Brain could not start safely: ${error && error.message ? error.message : 'unknown error'}. Reload and try again.`;
  });
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}
