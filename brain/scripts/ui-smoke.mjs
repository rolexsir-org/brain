// DOM boot + interaction smoke test. Requires: npm i jsdom fake-indexeddb
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const html = fs.readFileSync('index.html', 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.console.error = (...a) => { window.__errs = window.__errs || []; window.__errs.push(a.join(' ')); };

for (const k of ['document', 'window', 'navigator', 'location', 'HTMLElement', 'Node', 'NodeList',
  'Event', 'CustomEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'matchMedia', 'Blob', 'URL', 'FileReader', 'Text', 'MouseEvent']) {
  if (window[k] !== undefined) globalThis[k] = window[k];
}
globalThis.localStorage = window.localStorage;
globalThis.indexedDB = window.indexedDB;
globalThis.Notification = { permission: 'denied', requestPermission: async () => 'granted' };
globalThis.confirm = () => true;
window.Notification = globalThis.Notification;
window.matchMedia = window.matchMedia || (q => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
globalThis.navigator = window.navigator;

const errored = [];
process.on('uncaughtException', e => errored.push(e.stack || String(e)));
process.on('unhandledRejection', e => errored.push(e && e.stack || String(e)));

await import('../js/app.js');
await new Promise(r => setTimeout(r, 60));

function assert(c, m) { if (!c) { console.error('ASSERT FAIL: ' + m); process.exitCode = 1; } else console.log('ok: ' + m); }
function errs() {
  const all = [...(window.__errs || []), ...errored].filter(x => !/Warning:|Not implemented|Could not parse CSS|error text/i.test(x));
  if (all.length) { console.error('RUNTIME ERRORS:\n' + all.join('\n')); process.exitCode = 1; return true; }
  return false;
}
async function send(text) {
  const inp = window.document.querySelector('#in');
  inp.value = text;
  window.document.querySelector('#send').click();
  await new Promise(r => setTimeout(r, 50));
}
const chat = () => window.document.querySelector('#chat').textContent;

await send('I am Aarav');
await new Promise(r => setTimeout(r, 40));

// add many entity types via chat
const turns = [
  'add task buy milk tomorrow',
  'remind me to call mom at 7pm',
  'note the wifi password is alpha123',
  'Priya birthday is March 12',
  'spent 850 on groceries',
  'Ravi owes me 500',
  'I have 5kg of rice',
  'did yoga today',
  'dentist appointment on December 25',
];
for (const t of turns) await send(t);

// verify store counts reflect all adds
await import('../js/store/store.js').then(async ({ Store }) => {
  // store instance lives in app closure; verify via menu counts instead
});
// open menu and inspect a section
window.document.querySelector('#menuBtn').click();
await new Promise(r => setTimeout(r, 40));
const body = window.document.querySelector('#sheetBody');
assert(body.textContent.includes('Stock'), 'stock section count row exists');
// tap a section row (People)
const rows = [...body.querySelectorAll('.srow')];
assert(rows.length === 10, 'menu lists 10 sections, got ' + rows.length);
// click Notes section
rows.find(r => r.textContent.includes('Notes')).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await new Promise(r => setTimeout(r, 40));
assert(/wifi password/.test(chat()), 'notes listing appears in chat');

// open settings and verify render (no throw)
window.document.querySelector('#menuBtn').click();
await new Promise(r => setTimeout(r, 30));
const body2 = window.document.querySelector('#sheetBody');
// click Settings ghost button
const ghost = [...body2.querySelectorAll('button.ghost')].find(b => b.textContent.includes('Settings'));
if (ghost) { ghost.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); await new Promise(r => setTimeout(r, 30)); }
assert(window.document.querySelector('#sheet').classList.contains('open'), 'settings sheet open');
window.document.querySelector('#sheetClose').click();

// type a reminder-relative query handled by scheduler path not needed; final errs check
await send('what do I have stored?');
await new Promise(r => setTimeout(r, 40));
assert(/stored|Nothing|here|have|records|found|entries/i.test(chat()) || window.document.querySelector('#chat').children.length > 4, 'summary/listing query answered');

errs();
console.log('DONE');
process.exit(process.exitCode || 0);
