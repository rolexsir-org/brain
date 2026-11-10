// Browser-shell smoke test. It exercises the user-visible command -> record ->
// card -> action path under jsdom and fails on unhandled runtime errors.
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

// Fail loudly instead of hanging forever if an expectation breaks mid-run.
const watchdog = setTimeout(() => {
  console.error('TIMEOUT: UI smoke test did not finish within 90s');
  process.exit(1);
}, 90_000);
watchdog.unref?.();

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { url: 'https://brain.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const errors = [];
window.console.error = (...args) => errors.push(args.join(' '));

function expose(name, value) {
  try { Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); } catch {}
}
for (const name of ['document', 'window', 'location', 'HTMLElement', 'Node', 'NodeList', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'Blob', 'URL', 'FileReader', 'Text', 'File', 'Image']) {
  if (window[name] !== undefined) expose(name, window[name]);
}
expose('navigator', window.navigator);
expose('atob', value => Buffer.from(String(value), 'base64').toString('binary'));
expose('btoa', value => Buffer.from(String(value), 'binary').toString('base64'));
expose('localStorage', window.localStorage);
// Keep fake-indexeddb supplied by the import above; jsdom does not expose one.
const notification = { permission: 'denied', requestPermission: async () => 'denied' };
expose('Notification', notification);
window.Notification = notification;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.confirm = () => true;
expose('confirm', window.confirm);

const unhandled = [];
process.on('uncaughtException', error => unhandled.push(error.stack || String(error)));
process.on('unhandledRejection', error => unhandled.push(error && error.stack || String(error)));

await import('../js/app.js');
await delay(100);

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function assert(condition, message) {
  if (condition) console.log(`ok: ${message}`);
  else { console.error(`ASSERT FAIL: ${message}`); process.exitCode = 1; }
}
async function send(text) {
  const input = window.document.querySelector('#in');
  input.value = text;
  window.document.querySelector('#send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await delay(90);
}
const chatText = () => window.document.querySelector('#chat').textContent;

await send('Aarav');
assert(/Nice to meet you/i.test(chatText()), 'onboarding name is accepted');
for (const turn of [
  "John's number is +919876500011",
  "John's email is john@example.com",
  "John's instagram is @john_brain",
  'John lives at 12 Market Road',
  "John's alias is Johnny",
  'add task finish the report by friday',
  'remind me to call mom tomorrow at 7pm',
  'remember the wifi password is alpha123',
  'spent 850 on groceries',
  'Ravi owes me 500',
  'I have 5kg rice',
  'did yoga today',
  'schedule dentist appointment tomorrow at 3pm'
]) await send(turn);

await send('call Johnny');
assert(/Ready to call John/i.test(chatText()), 'alias resolves to a real call action');
assert([...window.document.querySelectorAll('.runbtn')].some(button => /Call John/.test(button.textContent)), 'call action button renders');
await send('text John “I’ll be there at 7”');
assert([...window.document.querySelectorAll('.runbtn')].some(button => /Text John/.test(button.textContent)), 'SMS composer action renders');
await send('open John’s instagram');
assert([...window.document.querySelectorAll('.runbtn')].some(button => /Instagram/.test(button.textContent)), 'Instagram profile action renders');
await send('navigate to John’s house');
assert([...window.document.querySelectorAll('.runbtn')].some(button => /Navigate to John/.test(button.textContent)), 'maps directions action renders');
await send('add that to my calendar');
assert([...window.document.querySelectorAll('.runbtn')].some(button => /Add to calendar/.test(button.textContent)), 'calendar export action renders');
const taskCard = [...window.document.querySelectorAll('.card')].find(card => /finish the report/i.test(card.textContent));
const taskEdit = taskCard && [...taskCard.querySelectorAll('.mini')].find(button => button.textContent === 'Edit');
taskEdit && taskEdit.click();
await delay(30);
assert(window.document.querySelector('#sheetTitle').textContent === 'Edit Task', 'task editor is reachable');
assert(window.document.querySelector('#sheetBody').textContent.includes('Schedule'), 'task editor exposes recurrence schedule controls');
assert(window.document.querySelector('#sheetBody').textContent.includes('Every'), 'task editor exposes recurrence intervals');
window.document.querySelector('#sheetClose').click();
await delay(20);

window.document.querySelector('#menuBtn').click();
await delay(40);
const menuBody = window.document.querySelector('#sheetBody');
assert(window.document.querySelector('#sheet').getAttribute('aria-hidden') === 'false', 'open sheet is exposed as a modal dialog');
assert(window.document.querySelector('#app').getAttribute('aria-hidden') === 'true', 'background is hidden from assistive technology while modal is open');
assert(window.document.querySelector('#menuBtn').getAttribute('aria-expanded') === 'true', 'menu control reflects its expanded dialog state');
const focusables = [...window.document.querySelector('#sheet').querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])')].filter(node => !node.hidden);
focusables.at(-1).focus();
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
assert(window.document.activeElement === focusables[0], 'modal Tab focus wraps instead of escaping to the page');
assert(menuBody.querySelectorAll('.srow').length >= 13, 'menu contains every collection including photos and Instagram Reels');
assert([...menuBody.querySelectorAll('button')].some(button => /Settings/.test(button.textContent)), 'settings action is reachable');
const people = [...menuBody.querySelectorAll('.srow')].find(row => /People/.test(row.textContent));
people.click();
await delay(40);
assert(/John/.test(chatText()), 'people collection is reachable from menu');
const personCard = [...window.document.querySelectorAll('.card')].find(card => /John/.test(card.textContent));
assert(!!personCard, 'person card renders');
assert([...personCard.querySelectorAll('.mini')].some(button => button.textContent === 'Call'), 'person card exposes call');
assert([...personCard.querySelectorAll('.mini')].some(button => button.textContent === 'Email'), 'person card exposes email');
assert([...personCard.querySelectorAll('.mini')].some(button => button.textContent === 'Maps'), 'person card exposes maps');

window.document.querySelector('#menuBtn').click();
await delay(30);
const settings = [...window.document.querySelectorAll('#sheetBody button')].find(button => /Settings/.test(button.textContent));
settings.click();
await delay(30);
assert(window.document.querySelector('#sheetTitle').textContent === 'Settings', 'settings sheet opens');
assert(window.document.querySelector('#sheetBody').textContent.includes('WhatsApp country code'), 'honest WhatsApp configuration is available');
window.document.querySelector('#sheetClose').click();
assert(window.document.querySelector('#sheet').getAttribute('aria-hidden') === 'true', 'closed sheet is hidden from assistive technology');
assert(!window.document.querySelector('#app').hasAttribute('aria-hidden'), 'background accessibility state is restored after closing');
assert(window.document.querySelector('#menuBtn').getAttribute('aria-expanded') === 'false', 'menu state resets after closing');

// --- Backup round-trip through the real UI (regression: encrypted v2) ---
const { encryptBackup } = await import('../js/util/crypto.js');

const nowIso = new Date().toISOString();
const backup = {
  app: 'brain', schema: 5, exportedAt: nowIso,
  settings: { name: 'Aarav' },
  collections: {
    task: [{ id: 'restore-task-1', title: 'Restored from encrypted backup', status: 'open', priority: 1, createdAt: nowIso, updatedAt: nowIso }]
  }
};
const packed = await encryptBackup(JSON.stringify(backup), 'test-passphrase', 'v2');
window.prompt = () => 'test-passphrase';
expose('prompt', window.prompt);

window.document.querySelector('#menuBtn').click();
await delay(30);
[...window.document.querySelectorAll('#sheetBody button')].find(button => /Settings/.test(button.textContent)).click();
await delay(30);
const restoreButton = [...window.document.querySelectorAll('#sheetBody button')].find(button => /Restore from a backup/.test(button.textContent));
assert(!!restoreButton, 'restore action is reachable from settings');
restoreButton.click();
await delay(20);
const fileInputs = [...window.document.querySelectorAll('input[type="file"]')];
const fileInput = fileInputs[fileInputs.length - 1];
assert(fileInputs.length === 1 && !!fileInput, 'restore opens exactly one file input');
const file = new window.File([packed], 'brain-backup.enc', { type: 'application/json' });
Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
await delay(500);
const restoreTitle = window.document.querySelector('#sheetTitle').textContent;
assert(/Restore/i.test(restoreTitle), 'encrypted v2 backup is decrypted and previewed');
const replaceButton = [...window.document.querySelectorAll('#sheetBody button')].find(button => /Replace all data/.test(button.textContent));
assert(!!replaceButton, 'restore preview offers replace');
if (replaceButton) replaceButton.click();
await delay(150);
window.document.querySelector('#menuBtn').click();
await delay(30);
[...window.document.querySelectorAll('#sheetBody .srow')].find(row => /Tasks/.test(row.textContent)).click();
await delay(60);
assert(/Restored from encrypted backup/.test(chatText()), 'encrypted v2 backup restores records into the app');

// --- Secondary panels must open without runtime errors ---
async function openMenuItem(pattern) {
  window.document.querySelector('#menuBtn').click();
  await delay(30);
  const row = [...window.document.querySelectorAll('#sheetBody button')].find(button => pattern.test(button.textContent));
  assert(!!row, `menu row ${pattern} exists`);
  if (!row) return false;
  row.click();
  await delay(80);
  return true;
}
if (await openMenuItem(/Command Centre/)) {
  assert(/Command Centre/.test(window.document.querySelector('#sheetTitle').textContent), 'command centre opens');
  assert(window.document.querySelector('#sheet').getAttribute('aria-hidden') === 'false', 'command centre is exposed as a dialog');
  assert(window.document.querySelector('#app').getAttribute('aria-hidden') === 'true', 'command centre hides the background from assistive technology');
  const search = window.document.querySelector('#sheetBody input[type="search"]');
  search.value = 'restored';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await delay(400);
  assert(/result/i.test(window.document.querySelector('#sheetBody').textContent), 'command centre search runs');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(30);
  assert(window.document.querySelector('#sheet').getAttribute('aria-hidden') === 'true', 'Escape closes the command centre');
  assert(!window.document.querySelector('#app').hasAttribute('aria-hidden'), 'closing the command centre restores the background');
}
if (await openMenuItem(/Automation Centre/)) {
  assert(/Automation Centre/.test(window.document.querySelector('#sheetTitle').textContent), 'automation centre opens');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(30);
}
if (await openMenuItem(/Diagnostics & release/)) {
  assert(window.document.querySelector('#sheetBody').textContent.length > 50, 'diagnostics panel renders');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(30);
}
if (await openMenuItem(/Instagram/)) {
  assert(/Instagram/.test(window.document.querySelector('#sheet').textContent), 'Instagram hub renders');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(30);
}

// Browser Back must close the panel, and each open must add exactly one history
// entry (no stacked duplicates).
const pushes = [];
const realPush = window.history.pushState.bind(window.history);
window.history.pushState = (...args) => { pushes.push(args[1] && args[1].brainSheet); return realPush(...args); };
if (await openMenuItem(/Command Centre/)) {
  assert(pushes.filter(Boolean).length === 1, 'opening a panel adds exactly one history entry');
  window.dispatchEvent(new window.Event('popstate'));
  await delay(50);
  assert(window.document.querySelector('#sheet').getAttribute('aria-hidden') === 'true', 'browser Back closes the panel');
  assert(!window.document.querySelector('#app').hasAttribute('aria-hidden'), 'browser Back restores the background');
}
if (await openMenuItem(/Automation Centre/)) {
  assert(pushes.filter(Boolean).length === 2, 'reopening a panel adds one entry, not a duplicate');
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(50);
}
window.history.pushState = realPush;

await delay(30);
if (errors.length || unhandled.length) {
  console.error(`RUNTIME ERRORS:\n${[...errors, ...unhandled].join('\n')}`);
  process.exitCode = 1;
}
clearTimeout(watchdog);
console.log('DONE');
process.exit(process.exitCode || 0);
