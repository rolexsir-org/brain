// Brain application shell — wires the store, intent engine, chat UI, menu,
// settings, notifications, install and voice together. No innerHTML is used
// for user content; everything is built with the safe nodes factory.

import { Store, previewImport } from './store/store.js';
import { Brain } from './engine/intent.js';
import { nodes as E, debounce, escHtml } from './util/util.js';
import { entityCard, kindIcon } from './ui/cards.js';
import { Scheduler, brief, requestPermission, perm } from './notify.js';
import { setupInstall, registerSw, isStandalone, reminderCapability } from './install.js';
import { todayKey } from './util/util.js';
import { LOCALES, CURRENCIES } from './util/constants.js';
import { getCaps, isIOS, isAndroid, isMobileUA } from './caps.js';
import * as Ext from './actions/external.js';

const $ = s => document.querySelector(s);
let store, brain, ctx, scheduler, busy = false;

const SUGGEST = [
  { t: 'remind me to call mom tomorrow at 7pm', l: '🔔 Reminder' },
  { t: 'add task finish the report by friday', l: '✅ Task' },
  { t: 'spent 850 on groceries', l: '💰 Spent' },
  { t: 'Priya’s birthday is March 12', l: '🎂 Birthday' },
  { t: 'I have 5kg rice', l: '📦 Stock' },
  { t: 'did yoga today', l: '🔥 Habit' },
  { t: 'what’s coming up?', l: '❓ Ask' }
];

async function boot() {
  store = new Store();
  await store.init();
  brain = new Brain(store);

  ctx = {
    store, brain,
    get cur() { return { currency: store.settings.currency, locale: store.settings.locale }; },
    notify: showSystemNotification,
    pushAlert: (text) => { pushBot(text, [], { sys: true }); },
    afterMutate: renderAll,
    scrollToCard: (id) => { const el = document.querySelector(`[data-cid="${id}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); },
    runAction,
    edit: (kind, id) => openEditor(kind, id),
    viewPhoto,
    caps: getCaps()
  };
  scheduler = new Scheduler(ctx);

  wireHeader();
  buildSuggest();
  wireComposer();
  $('#sheetClose').addEventListener('click', closeSheet);
  $('#sheet').addEventListener('click', (e) => { if (e.target === $('#sheet')) closeSheet(); });
  setupInstall($('#installBtn'));
  registerSw();
  bootVoice();

  setTitle();
  showWelcome();

  await store.flush();
  scheduler.start();
  showBriefOnce();
}

function setTitle() {
  const n = store.settings.name;
  $('#title').textContent = n ? `Brain` : 'Brain';
}

// ---------- chat ----------
const blocks = []; // {role, kind, text, cards, ts}
function renderAll() {
  const chat = $('#chat');
  chat.textContent = '';
  const list = blocks.slice(-200);
  for (const b of list) chat.append(renderBlock(b));
  autoScroll();
}
function renderBlock(b) {
  const row = E.div({ class: 'row' + (b.role === 'user' ? ' user' : ' bot' + (b.kind === 'brief' ? ' brief' : '')) });
  const content = E.div({ style: 'min-width:0' });
  if (b.role === 'bot') row.append(E.div({ class: 'avatar' }, b.kind === 'brief' ? '☀️' : '🧠'));
  if (b.text) content.append(E.div({ class: 'bubble' }, b.text));
  if (b.kind === 'brief') { /* same bubble already styled via class */ }
  if (b.cards && b.cards.length) {
    const wrap = E.div();
    for (const c of b.cards) {
      const card = entityCard(ctx, c.kind, c.id);
      if (card) { card.dataset.cid = c.id; wrap.append(card); }
    }
    content.append(wrap);
  }
  if (b.run && b.run.label) {
    const rb = E.button({ class: 'runbtn', type: 'button' }, b.run.label);
    rb.addEventListener('click', () => runAction(b.run));
    content.append(rb);
  }
  const ts = E.div({ class: 'ts' }, clock(b.ts));
  content.append(ts);
  row.append(content);
  return row;
}
function clock(iso) { const d = new Date(iso); return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function autoScroll() { const c = $('#chat'); requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; }); }

function pushUser(text) { blocks.push({ role: 'user', text, ts: Date.now() }); renderAll(); }
function pushBot(text, cards, o) {
  blocks.push({ role: 'bot', kind: (o && o.brief) ? 'brief' : (o && o.sys) ? 'sys' : 'msg', text, cards: cards || [], run: (o && o.run) || null, ts: Date.now() });
  renderAll();
}
let typingNode = null;
function showTyping() {
  const chat = $('#chat');
  const row = E.div({ class: 'row bot typing' });
  row.append(E.div({ class: 'avatar' }, '🧠'));
  const bub = E.div({ class: 'bubble' }, E.i(), E.i(), E.i());
  row.append(bub);
  chat.append(row); autoScroll();
  typingNode = row;
}
function hideTyping() { if (typingNode && typingNode.parentNode) typingNode.parentNode.removeChild(typingNode); typingNode = null; }

// ---------- welcome / onboarding ----------
function showWelcome() {
  if (!store.settings.name) {
    blocks.length = 0;
    pushBot("👋 Hi! I'm Brain — a private assistant living entirely on this device.\n\nNothing you tell me leaves your phone. I remember tasks, reminders, notes, people, money, habits and more — you just talk to me.\n\nWhat should I call you?");
  } else {
    pushBot(`Hi${store.settings.name ? ', ' + store.settings.name : ''} 👋 What can I help with?`);
  }
}

function isNameish(text) {
  const t = text.trim();
  return /^[A-Za-z][A-Za-z .'-]{1,22}$/.test(t) && t.split(/\s+/).length <= 3;
}

async function sendNow(text) {
  if (busy) return;
  const raw = (text != null ? text : $('#in').value).trim();
  if (!raw) return;
  $('#in').value = ''; autosize();
  pushUser(raw);

  // Onboarding name capture
  if (!store.settings.name) {
    if (isNameish(raw)) {
      store.updateSettings({ name: raw.trim().replace(/\s+/g, ' '), onboarded: true });
      setTitle();
      pushBot(`Nice to meet you, ${store.settings.name}! 🤝\n\nTry typing something like:\n• “remind me to take medicine at 8pm”\n• “spent 850 on groceries”\n• “Priya’s birthday is March 12”\n\nOr open ☰ for quick actions and demo help.`);
      return;
    }
    store.updateSettings({ name: 'there', onboarded: true });
  }

  busy = true;
  $('#send').disabled = true;
  showTyping();
  try {
    const r = await brain.handle(raw);
    hideTyping();
    if (r && (r.text || (r.cards && r.cards.length))) pushBot(r.text, r.cards, { run: r.run });
    else if (r && r.text === '') pushBot('…');
  } catch (e) {
    hideTyping();
    console.error(e);
    pushBot("Something went wrong on my end — try that again.");
  }
  busy = false;
  $('#send').disabled = false;
}

// ---------- header + composer ----------
function wireHeader() {
  $('#menuBtn').addEventListener('click', openMenu);
}
function buildSuggest() {
  const el = $('#suggests');
  el.textContent = '';
  for (const s of SUGGEST) {
    const chip = E.button({ class: 'chip', type: 'button' }, s.l);
    chip.addEventListener('click', () => { $('#in').value = s.t; $('#in').focus(); });
    el.append(chip);
  }
}
function wireComposer() {
  const inp = $('#in');
  const send = $('#send');
  inp.addEventListener('input', autosize);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNow(); } });
  send.addEventListener('click', () => sendNow());
  $('#mic').addEventListener('click', toggleVoice);
}
function autosize() { const i = $('#in'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 120) + 'px'; }

// ---------- menu ----------
function menuBtn(label, onClick) {
  const b = E.button({ class: 'ghost' }, label);
  b.addEventListener('click', onClick);
  return b;
}

function openMenu() {
  const body = $('#sheetBody');
  const title = $('#sheetTitle'); title.textContent = 'Menu';
  body.textContent = '';
  const name = store.settings.name;
  const counts = store.counts();

  body.append(E.div({ class: 'banner' },
    `Hi${name ? ', ' + name : ''}. Here’s what Brain is holding — tap a section to browse.`));

  const sections = [
    ['task', 'Tasks', counts.task], ['reminder', 'Reminders', counts.reminder], ['note', 'Notes', counts.note],
    ['person', 'People', counts.person], ['money', 'Money', counts.money], ['debt', 'Debts', counts.debt],
    ['stockItem', 'Stock', counts.stockItem], ['habit', 'Habits', counts.habit], ['journal', 'Journal', counts.journal],
    ['event', 'Events', counts.event], ['photo', 'Photos', counts.photo]
  ];
  for (const [kind, label, n] of sections) {
    const row = E.div({ class: 'srow' }, E.div({ class: 'em' }, kindIcon(kind)),
      E.div({ class: 'tx' }, E.b({}, `${label} · ${n}`), E.small({}, sampleHint(kind))));
    row.addEventListener('click', () => { closeSheet(); listKind(kind); });
    body.append(row);
  }
  body.append(E.div({ class: 'hr' }));
  body.append(menuBtn('📷 Add a photo', () => { closeSheet(); runAction({ id: 'photoPick' }); }));
  body.append(menuBtn('🔗 Share today’s plan', () => { closeSheet(); toast('Tap to share when you’re ready.'); runAction({ id: 'share', args: { title: 'Brain — Today’s plan', text: brain._sharePlanText() } }); }));
  body.append(menuBtn('💾 Back up my data', doExport));
  body.append(menuBtn('⚙️ Settings', () => { closeSheet(); openSettings(); }));
  body.append(menuBtn('✨ Load sample data', () => { closeSheet(); loadDemo(); }));

  openSheet();
}
const KIND_PLURAL = { task: 'Tasks', reminder: 'Reminders', note: 'Notes', person: 'People', money: 'Money records', debt: 'Debts', stockItem: 'Stock items', habit: 'Habits', journal: 'Journal entries', event: 'Events', photo: 'Photos' };
function sampleHint(kind) {
  const h = { task: 'e.g. “submit the report”', reminder: 'e.g. “call mom at 7pm”', note: 'e.g. “wifi password is Home123”', person: 'e.g. “Priya, birthday March 12”', money: 'e.g. “spent 850 on food”', debt: 'e.g. “Ravi owes me 500”', stockItem: 'e.g. “I have 5kg rice”', habit: 'e.g. “did yoga”', journal: 'e.g. “felt great”', event: 'e.g. “dentist 25 dec”', photo: 'e.g. “add a photo”' };
  return h[kind] || '';
}
function listKind(kind) {
  const items = store.list(kind).slice(-40);
  const label = KIND_PLURAL[kind] || (kind.charAt(0).toUpperCase() + kind.slice(1) + 's');
  if (!items.length) { pushBot(`Nothing in ${label.toLowerCase()} yet.`, []); return; }
  pushBot(`Here are your ${label.toLowerCase()} (latest first):`, items.slice().reverse().map(x => ({ kind, id: x.id })));
}

// ---------- settings ----------
function openSettings() {
  const body = $('#sheetBody'); const title = $('#sheetTitle'); title.textContent = 'Settings';
  body.textContent = '';
  const c = store.settings;
  const f = (label, input) => E.div({ class: 'field' }, E.label({}, label), input);

  const nameIn = E.input({ value: c.name || '', placeholder: 'Your name' });
  const curIn = E.select({}, CURRENCIES.map(x => E.option({ value: x, selected: c.currency === x ? true : null }, x)));
  const locIn = E.select({}, LOCALES.map(x => E.option({ value: x, selected: c.locale === x ? true : null }, x)));

  body.append(f('Your name', nameIn));
  body.append(f('Currency', curIn));
  body.append(f('Number & date format', locIn));

  const save = E.button({ class: 'primary' }, 'Save');
  save.addEventListener('click', async () => {
    store.updateSettings({ name: nameIn.value.trim(), currency: curIn.value, locale: locIn.value });
    setTitle(); closeSheet(); pushBot('Settings saved.');
  });
  body.append(save);
  body.append(E.div({ class: 'hr' }));

  // Notifications
  const notif = E.div({ class: 'toggle' },
    E.div({ class: 'tt' }, 'Notifications', E.small({}, reminderCapability())),
    toggle(perm() === 'granted', async (on) => {
      if (on) {
        if (perm() === 'granted') { await store.updateSettings({ notifEnabled: true }); return true; }
        const p = await requestPermission();
        if (p === 'granted') { await store.updateSettings({ notifEnabled: true }); return true; }
        notifNote(); return false;
      }
      await store.updateSettings({ notifEnabled: false });
      return true;
    }));
  body.append(notif);

  const mm = typeof matchMedia === 'function' ? matchMedia : (typeof window !== 'undefined' && window.matchMedia) || (() => ({ matches: false }));
  const vm = mm('(prefers-reduced-motion: reduce)');
  const motion = E.div({ class: 'toggle' },
    E.div({ class: 'tt' }, 'Reduce motion'),
    toggle(c.reducedMotion !== false || vm.matches, async (on) => {
      await store.updateSettings({ reducedMotion: on });
      document.documentElement.classList.toggle('reduce', on);
      return true;
    }));
  body.append(motion);

  body.append(E.div({ class: 'hr' }));
  body.append(menuBtn('💾 Back up (download file)', doExport));
  body.append(menuBtn('📂 Restore from a backup', () => $('#restoreFile').click()));
  const rf = E.input({ type: 'file', id: 'restoreFile', accept: 'application/json', style: 'display:none' });
  rf.addEventListener('change', () => handleImport(rf));
  body.append(rf);
  const del = E.button({ class: 'ghost danger' }, '🗑️ Erase all my data');
  del.addEventListener('click', eraseAll);
  body.append(del);

  body.append(E.div({ class: 'note' }, '🔒 Privacy: everything stays on this device. Nothing is sent anywhere. Your backup is a plain file you keep yourself.'));
  body.append(E.div({ class: 'note' }, `About: Brain v2 · offline · no account.${isStandalone() ? ' Running as an installed app.' : ''}`));
  body.append(menuBtn('🧰 What can this device do?', () => { closeSheet(); openDiagnostics(); }));
  openSheet();
}
function toggle(on, cb) {
  const inp = E.input({ type: 'checkbox' }); inp.checked = on;
  const label = E.label({ class: 'switch' }, inp, E.i({}));
  inp.addEventListener('change', async (e) => { const keep = await cb(e.target.checked); if (keep === false) e.target.checked = !e.target.checked; });
  return label;
}
function notifNote() { toast('Notifications were blocked by your browser. Reminders will still show in the chat.'); }

// ---------- backup / import / erase ----------
function doExport() {
  store.exportState().then(snapshot => {
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const a = E.a({ href: URL.createObjectURL(blob), download: `brain-backup-${todayKey()}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Backup downloaded.');
  });
}
function handleImport(fileEl) {
  const file = fileEl.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const info = previewImport(reader.result);
      toast(`Found a backup (${info.total} items). Choose how to apply.`);
      const body = $('#sheetBody'); const t = $('#sheetTitle'); t.textContent = 'Restore backup';
      body.textContent = '';
      body.append(E.div({ class: 'banner' }, `This backup has ${info.total} item(s). Pick how to add them to your current data.`));
      const replace = E.button({ class: 'ghost' }, '⚠️ Replace everything');
      const merge = E.button({ class: 'primary' }, 'Merge (keep existing)');
      const cancel = E.button({ class: 'ghost' }, 'Cancel');
      merge.addEventListener('click', async () => { await applyImport(reader.result, 'merge'); });
      replace.addEventListener('click', async () => { if (confirm('Replace ALL current data with this backup? This cannot be undone.')) await applyImport(reader.result, 'replace'); });
      cancel.addEventListener('click', () => closeSheet());
      body.append(merge, replace, cancel);
    } catch (e) { toast('That file isn’t a valid Brain backup.'); }
  };
  reader.readAsText(file);
}
async function applyImport(raw, mode) {
  const data = JSON.parse(raw);
  if (mode === 'replace') {
    await store.replaceAll(data.collections, data.settings);
    toast('Backup restored.');
  } else {
    for (const kind in data.collections || {}) {
      for (const rec of data.collections[kind]) {
        const existing = store.list(kind).find(x => x.id === rec.id);
        if (!existing && rec.id) store.addSync(kind, rec);
      }
    }
    await store.flush();
    toast('Backup merged in.');
  }
  closeSheet(); renderAll();
}
function eraseAll() {
  if (!confirm('Erase ALL of your data permanently? This cannot be undone.')) return;
  store.wipe().then(() => { blocks.length = 0; renderAll(); pushBot('Everything has been erased. 👋'); });
}

// ---------- demo ----------
function loadDemo() {
  store.wipe().then(async () => {
    store.updateSettings({ name: store.settings.name || 'Friend', onboarded: true });
    const add = (kind, obj) => store.addSync(kind, obj);
    add('person', { name: 'Mom', phone: '9876500001', birthday: '5 Jan', relationship: 'family' });
    add('person', { name: 'Priya', phone: '9876500003', birthday: '12 Mar', relationship: 'friend' });
    add('person', { name: 'Ravi', phone: '9876500002', relationship: 'colleague' });
    add('task', { title: 'Submit physics assignment', due: daysFromNow(1, 17) });
    add('task', { title: 'Buy mom a birthday gift', due: daysFromNow(6, 10) });
    add('reminder', { title: 'Take medicine', recur: { freq: 'daily', interval: 1, time: '20:00' } });
    add('reminder', { title: 'Call mom', at: daysFromNow(0, 12) });
    add('reminder', { title: 'Water the plants', recur: { freq: 'weekly', interval: 1, days: [0], time: '09:00' } });
    add('note', { title: 'WiFi password', body: 'Home123', private: true });
    add('note', { title: 'Chai recipe', body: '2 cups water, 1 cup milk, 2 spoons sugar, tea leaves. Boil 5 min.' });
    add('money', { kind: 'income', amount: 45000, category: 'salary', date: new Date().toISOString() });
    add('money', { kind: 'expense', amount: 640, category: 'groceries', date: new Date().toISOString() });
    add('debt', { person: 'Ravi', amount: 500, dir: 'they_owe_me', date: new Date(Date.now() - 5 * 86400000).toISOString() });
    add('stockItem', { name: 'Rice', qty: 5, unit: 'kg', lowThreshold: 1 });
    add('stockItem', { name: 'Milk', qty: 1, unit: 'L', lowThreshold: 2 });
    add('habit', { name: 'Reading', schedule: { freq: 'daily', interval: 1 }, log: [todayKey(new Date(Date.now() - 86400000))] });
    add('event', { title: 'Dentist appointment', at: daysFromNow(2, 15), kind: 'appointment' });
    add('journal', { text: 'Met an old friend today. Great time.', mood: 'happy', date: new Date(Date.now() - 86400000).toISOString() });
    await store.flush();
    renderAll();
    pushBot('✨ Loaded some sample data so you can see how Brain works.\n\nTry asking:\n• “what’s coming up?”\n• “who owes me?”\n• “show my notes”\n• “I have 5kg rice”');
  });
}
function daysFromNow(day, hour) { const d = new Date(); d.setDate(d.getDate() + day); d.setHours(hour, 0, 0, 0); return d.toISOString(); }

// ---------- daily brief ----------
function showBriefOnce() {
  const day = todayKey();
  if (store.settings.briefDate === day) return;
  const b = brief(store);
  if (b) { store.updateSettings({ briefDate: day }); pushBot(b, [], { brief: true }); }
}

// ---------- device actions (universal action system) ----------
// The single dispatcher every external action flows through (from the engine's
// `run` requests and from entity-card buttons). Each action is capability-gated
// and reports its outcome truthfully.
async function runAction(a) {
  if (!a || !a.id) return;
  let r;
  switch (a.id) {
    case 'call': r = Ext.launchCall(a.args && a.args.number); break;
    case 'sms': r = Ext.launchSms(a.args && a.args.number, (a.args && a.args.body) || ''); break;
    case 'whatsapp': r = Ext.launchWhatsApp(a.args && a.args.number, (a.args && a.args.text) || ''); break;
    case 'email': r = Ext.launchEmail(a.args && a.args.email, { subject: (a.args && a.args.subject) || '', body: (a.args && a.args.body) || '' }); break;
    case 'maps': r = Ext.launchMaps(a.args && a.args.query); break;
    case 'open': r = Ext.openUrl(a.args && a.args.url); break;
    case 'copy': r = await Ext.launchCopy((a.args && a.args.text) || ''); break;
    case 'share': r = await Ext.launchShare({ title: (a.args && a.args.title) || 'Brain', text: (a.args && a.args.text) || '', url: (a.args && a.args.url) || '' }); break;
    case 'calendar': r = await Ext.launchCalendar(Ext.buildIcs(a.args || {})); break;
    case 'photoPick': return photoPick(a.args || {});
    default: return;
  }
  if (r && r.message) toast(r.message);
  return r;
}

/** Provide ctx a stable action hook used by entity cards. */
function makeRunner() { return runAction; }

// ---------- photos (real device gallery) ----------
let photoPickBusy = false;
async function photoPick({ attachTo } = {}) {
  if (photoPickBusy) return { ok: false, message: 'A photo window is already open.' };
  photoPickBusy = true;
  try {
    const res = await Ext.pickImage({});
    if (res.cancelled) return { ok: false, message: 'No photo was selected.' };
    if (res.error) { toast(res.error); return { ok: false, message: res.error }; }
    // persist a photo record (data stored as data-URL so it survives reload/backup)
    const rec = store.addSync('photo', { name: res.name, size: res.dataUrl.length, width: res.width, height: res.height, dataUrl: res.dataUrl });
    if (!rec) { toast('Couldn’t store that image (storage may be full).'); return { ok: false, message: 'storage' }; }
    await store.flush();
    if (attachTo === 'journal') {
      // attach to today's/latest journal entry, else create one
      const today = todayKey();
      let j = store.list('journal').slice().reverse().find(x => todayKey(new Date(x.date)) === today) ||
               store.list('journal')[store.list('journal').length - 1];
      if (j) store.updateSync('journal', j.id, { photoId: rec.id, updatedAt: new Date().toISOString() });
      else { const nj = store.addSync('journal', { text: '📷 Added a photo', mood: '', photoId: rec.id }); j = nj; }
      await store.flush();
      toast('Photo added to your journal.');
      pushBot('📷 Photo saved and attached to your journal.', [{ kind: 'photo', id: rec.id }]);
    } else {
      toast('Photo saved.');
      pushBot('Photo saved.', [{ kind: 'photo', id: rec.id }]);
    }
    ctx.afterMutate();
    return { ok: true };
  } finally { photoPickBusy = false; }
}
function viewPhoto(id) {
  const rec = store.list('photo').find(x => x.id === id);
  if (!rec) return;
  const body = $('#sheetBody'); $('#sheetTitle').textContent = rec.name || 'Photo';
  body.textContent = '';
  const img = E.img({ src: rec.dataUrl, class: 'photoView', alt: (rec.name || 'photo') });
  body.append(E.div({ class: 'center' }, img));
  const row = E.div({ class: 'actbar' });
  row.append(actionBtn('🔗 Share', async () => { const r = await runAction({ id: 'share', args: { title: 'Photo', text: 'Photo from Brain', files: photoAsFile(rec) } }); if (r && r.ok) closeSheet(); }));
  row.append(actionBtn('🗑️ Delete', () => { store.removeSync('photo', id); closeSheet(); renderAll(); toast('Photo removed.'); }));
  body.append(row);
  openSheet();
}
function photoAsFile(rec) {
  try {
    const m = rec.dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s);
    if (!m) return null;
    const bin = atob(m[2]); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], (rec.name || 'photo') + '.jpg', { type: m[1] });
  } catch { return null; }
}

// ---------- edit entity (no dead ends) ----------
const EDIT_FIELDS = {
  task: { title: 'text', note: 'textarea', due: 'datetime' },
  reminder: { title: 'text', at: 'datetime' },
  note: { title: 'text', body: 'textarea' },
  person: { name: 'text', phone: 'text', email: 'text', address: 'textarea', birthday: 'text', relationship: 'text' },
  money: { category: 'text', amount: 'number' },
  debt: { person: 'text', amount: 'number' },
  stockItem: { name: 'text', unit: 'text', qty: 'number', lowThreshold: 'number' },
  habit: { name: 'text' },
  journal: { text: 'textarea', mood: 'text' },
  event: { title: 'text', kind: 'text', at: 'datetime' }
};
function openEditor(kind, id) {
  const rec = store.list(kind).find(x => x.id === id);
  const fields = EDIT_FIELDS[kind];
  if (!rec || !fields) { toast('That can’t be edited here.'); return; }
  const body = $('#sheetBody'); const title = $('#sheetTitle');
  title.textContent = 'Edit ' + kind.replace(/([A-Z])/g, ' $1').trim();
  body.textContent = '';
  const inputs = {};
  for (const [fname, type] of Object.entries(fields)) {
    let val = rec[fname];
    let input;
    const label = fname.charAt(0).toUpperCase() + fname.slice(1);
    if (type === 'textarea') { input = E.textarea({ class: 'ed' }, val == null ? '' : val); }
    else if (type === 'number') { input = E.input({ type: 'number', class: 'ed', value: val == null ? '' : String(val) }); }
    else if (type === 'datetime') { input = E.input({ type: 'datetime-local', class: 'ed', value: val ? toLocalInput(val) : '' }); }
    else { input = E.input({ type: 'text', class: 'ed', value: val == null ? '' : String(val) }); }
    inputs[fname] = input;
    body.append(E.div({ class: 'field' }, E.label({}, label), input));
  }
  const save = E.button({ class: 'primary' }, 'Save');
  save.addEventListener('click', async () => {
    const patch = {};
    for (const [fname, type] of Object.entries(fields)) {
      let v = inputs[fname].value;
      if (type === 'number') v = v === '' ? null : Number(v);
      else if (type === 'datetime') v = v ? new Date(v).toISOString() : null;
      else v = (v == null ? '' : v);
      patch[fname] = v;
    }
    store.updateSync(kind, id, patch);
    await store.flush();
    closeSheet(); ctx.afterMutate();
    toast('Saved.');
  });
  body.append(save);
  openSheet();
}
function toLocalInput(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function actionBtn(label, onClick) {
  const b = E.button({ class: 'ghost', type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

// ---------- capability diagnostics (honest about the platform) ----------
function openDiagnostics() {
  const body = $('#sheetBody'); $('#sheetTitle').textContent = 'Device capabilities';
  body.textContent = '';
  const c = getCaps();
  const rows = [
    ['Platform', isStandalone() ? 'Installed app (standalone)' : isMobileUA() ? (isIOS() ? 'iOS browser' : isAndroid() ? 'Android browser' : 'Mobile browser') : 'Desktop browser', c.platform],
    ['Online', c.platform.online ? 'yes' : 'no', c.platform],
    ['Notifications', c.notifications.supported ? (c.notifications.permission === 'granted' ? 'granted' : c.notifications.permission === 'denied' ? 'denied' : 'askable') : 'unsupported', c.notifications],
    ['Background push', 'not available (local-only, no server)', c.notifications],
    ['Service Worker', c.sw.supported ? (c.sw.controlled ? 'active' : 'registered') : 'unsupported', c.sw],
    ['Web Share', c.share.webShare ? (c.share.shareFiles ? 'yes (with files)' : 'yes') : 'no — copy fallback', c.share],
    ['Clipboard', c.clipboard.write ? 'yes' : 'legacy fallback', c.clipboard],
    ['File picker', 'yes', c.files],
    ['Camera input', c.media.camera ? 'yes' : 'unsupported', c.media],
    ['Voice input', c.speech.recognition ? 'yes' : 'unsupported', c.speech],
    ['Location', c.geolocation ? 'ask permission' : 'unsupported', c.geolocation],
    ['Contacts API', c.contacts ? 'ask permission' : 'not exposed to web — using saved contacts', c.contacts],
    ['Calendar', 'download .ics (OS adds it)', c.calendar],
    ['Vibration', c.vibration ? 'yes' : 'no', c.vibration],
    ['Phone / SMS / Email / Maps', 'open via OS links when you tap an action', null]
  ];
  for (const [name, val, grp] of rows) body.append(E.div({ class: 'diag' }, E.div({ class: 'dn' }, name), E.div({ class: 'dv' }, val)));
  body.append(E.div({ class: 'note' }, 'Brain only offers actions your device can genuinely do. Anything the platform can’t provide is handled with the strongest honest fallback (e.g. copy/share instead of claiming to post to Instagram).'));
  openSheet();
}

// ---------- notifications ----------
function showSystemNotification(text) {
  if (canNotify() && perm() === 'granted') {
    try { new Notification('Brain', { body: text, tag: 'brain-reminder', icon: 'icons/icon-192.png' }); } catch (e) {}
  }
}
function canNotify() { return typeof Notification !== 'undefined' && 'Notification' in window; }

// ---------- voice ----------
let recognizing = false;
function bootVoice() {
  const has = 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  if (!has) { $('#mic').style.display = 'none'; return; }
}
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = $('#mic');
  if (recognizing) { try { window.__rec && window.__rec.stop(); } catch (e) {} return; }
  const rec = new SR();
  window.__rec = rec;
  rec.lang = 'en-IN';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onstart = () => { recognizing = true; mic.classList.add('on'); mic.textContent = '◉'; };
  rec.onend = () => { recognizing = false; mic.classList.remove('on'); mic.textContent = '🎤'; };
  rec.onerror = (e) => { recognizing = false; mic.classList.remove('on'); mic.textContent = '🎤'; if (e.error === 'not-allowed') toast('Microphone permission was denied.'); };
  rec.onresult = (e) => { const tx = e.results[0][0].transcript; $('#in').value = tx; autosize(); sendNow(tx); };
  try { rec.start(); } catch (e) {}
}

// ---------- misc ----------
function openSheet() { $('#sheet').classList.add('open'); }
function closeSheet() { $('#sheet').classList.remove('open'); }
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = ''; t.append(document.createTextNode(msg));
  t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

function start() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  boot().catch(e => { console.error(e); document.body.textContent = 'Brain failed to start: ' + e.message; });
}
if (typeof document !== 'undefined' && document.readyState !== 'loading') start();
else if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', start);
