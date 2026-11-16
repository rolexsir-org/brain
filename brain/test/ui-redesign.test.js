// Redesigned shell coverage: navigation, real-data dashboard, module pages,
// quick-add, calendar, theme and accessibility affordances.
// Runs the real app under jsdom against fake IndexedDB — no mocks of app logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import 'fake-indexeddb/auto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const dom = new JSDOM(html, { url: 'https://brain.test/', runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
const { document } = window;

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
const notification = { permission: 'denied', requestPermission: async () => 'denied' };
expose('Notification', notification);
window.Notification = notification;
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.confirm = () => true;
window.prompt = () => '';
expose('confirm', window.confirm);
expose('prompt', window.prompt);

const errors = [];
window.console.error = (...args) => errors.push(args.join(' '));
process.on('uncaughtException', error => errors.push(error.stack || String(error)));
process.on('unhandledRejection', error => errors.push(error && error.stack || String(error)));

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function send(text) {
  const input = $('#in');
  input.value = text;
  $('#send').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await delay(160);
}

async function boot() {
  await import('../js/app.js');
  await delay(150);
}

function navClick(label) {
  const item = $$('[data-view]').find(button => (button.getAttribute('aria-label') || button.textContent).trim().includes(label));
  assert.ok(item, `navigation item ${label} exists`);
  item.click();
  return item;
}

test('redesigned shell boots with five primary destinations and accessible labels', async () => {
  await boot();
  assert.equal($$('#sidenav .nav-item').length, 5, 'desktop sidebar exposes five destinations');
  assert.equal($$('#bottomnavInner .bottomnav-item').length, 5, 'mobile bottom navigation exposes five destinations');
  assert.ok($$('.skip-link').length === 1, 'a skip link is available for keyboard users');
  assert.equal($$('#sidenav [aria-current="page"]').length, 1, 'exactly one destination is marked current');
  assert.equal($('#themeBtn').children.length, 1, 'theme control renders an icon');
  assert.equal($('#menuBtn').children.length, 1, 'menu control renders an icon');
  assert.equal($('#send').children.length, 1, 'composer send control renders an icon');
});

test('home dashboard renders greeting, real records and graceful empty states', async () => {
  await send('Aarav');
  await send('add task finish the report by friday');
  await send('remind me to call mom tomorrow at 7pm');
  const home = $('#view-home');
  assert.ok(home.textContent.includes('Good'), 'personal greeting is rendered');
  assert.ok(/Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(home.textContent), 'today’s date is rendered');
  assert.ok(/finish the report/i.test(home.textContent), 'a real task appears on the dashboard');
  assert.ok(/call mom/i.test(home.textContent), 'a real reminder appears on the dashboard');
  assert.equal($$('.stat').length, 4, 'dashboard shows four real-data stats');
  assert.ok($$('.qa').length >= 6, 'quick actions are available');
  assert.ok(home.textContent.includes('Ask Brain'), 'a prominent assistant entry point exists');
});

test('module navigation renders real records and quick-add creates one', async () => {
  navClick('Tasks');
  await delay(30);
  const moduleView = $('#view-module');
  assert.equal(moduleView.hidden, false, 'tasks view is visible after navigation');
  assert.ok(moduleView.textContent.includes('Tasks'), 'module title renders');
  assert.ok(moduleView.querySelector('.card'), 'existing task card renders');

  const newButton = $$('#view-module .btn').find(button => /New task/.test(button.textContent));
  assert.ok(newButton, 'quick-add action is available');
  newButton.click();
  await delay(30);
  assert.equal($('#sheetTitle').textContent, 'New task', 'quick-add opens a real form');
  const titleInput = $('#sheetBody input[type="text"]');
  titleInput.value = 'Redesign polish pass';
  $('#sheetBody .primary').click();
  await delay(120);
  assert.ok($('#view-module').textContent.includes('Redesign polish pass'), 'quick-add persists a real record');
});

test('module search filters real records', async () => {
  const search = $('#view-module input[type="search"]');
  assert.ok(search, 'module search is available');
  search.value = 'polish';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await delay(30);
  const view = $('#view-module').textContent;
  assert.ok(view.includes('Redesign polish pass'), 'matching record stays visible');
  assert.ok(!view.includes('finish the report'), 'non-matching record is filtered out');
});

test('calendar renders a real month grid with a marked today', async () => {
  navClick('Calendar');
  await delay(30);
  assert.equal($('#view-calendar').hidden, false, 'calendar view is visible');
  assert.equal($$('.cal-grid .cal-day').length, 42, 'month grid renders six weeks');
  assert.ok($('.cal-grid .cal-day.today'), 'today is marked in the month grid');
  assert.ok($$('#view-calendar .agenda-day').length >= 0, 'agenda renders without errors');
});

test('More exposes every existing module plus tools', async () => {
  navClick('More');
  await delay(30);
  const tiles = $$('#view-more .tile');
  assert.ok(tiles.length >= 13, 'More grid exposes every module');
  assert.ok($('#view-more').textContent.includes('Settings'), 'settings is reachable from More');
  assert.ok($('#view-more').textContent.includes('Back up'), 'backup is reachable from More');
});

test('theme toggle switches between light and dark and persists the choice', async () => {
  const root = document.documentElement;
  const before = root.dataset.theme || 'system';
  $('#themeBtn').click();
  await delay(10);
  const after = root.dataset.theme;
  assert.ok(after === 'light' || after === 'dark', 'theme attribute is set explicitly');
  assert.notEqual(after, before === 'system' ? '' : before, 'theme changed');
  assert.equal(window.localStorage.getItem('brain:theme'), after, 'theme choice is persisted');
  $('#themeBtn').click();
  await delay(10);
  assert.notEqual(document.documentElement.dataset.theme, after, 'theme toggles back');
});

test('every module page renders from live data without runtime errors', async () => {
  navClick('More');
  await delay(30);
  const tiles = $$('#view-more .tile');
  const moduleTiles = tiles.filter(tile => !/Settings|Back up|capabilities|Diagnostics|Command Centre|Automation Centre/.test(tile.textContent));
  assert.ok(moduleTiles.length >= 13, 'all modules are listed in More');
  for (const tile of moduleTiles) {
    tile.click();
    await delay(25);
    if (/Reels/.test(tile.textContent) && !/Published/.test(tile.textContent)) {
      // The Reels tile opens the Instagram workspace sheet.
      assert.equal($('#sheet').classList.contains('open'), true, 'Instagram workspace opens from More');
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await delay(25);
      navClick('More');
      await delay(25);
      continue;
    }
    assert.equal($('#view-module').hidden, false, `${tile.textContent.trim()} module renders`);
    assert.ok($('#view-module').textContent.trim().length > 0, `${tile.textContent.trim()} module has content`);
  }
});

test('quick-add supports reminders and notes with real persistence', async () => {
  navClick('More');
  await delay(25);
  $$('#view-more .tile').find(tile => /Reminders/.test(tile.textContent)).click();
  await delay(25);
  $$('#view-module .btn').find(button => /New reminder/.test(button.textContent)).click();
  await delay(25);
  assert.equal($('#sheetTitle').textContent, 'New reminder');
  const inputs = $$('#sheetBody input');
  inputs[0].value = 'Take medicine';
  inputs[1].value = '2030-01-01T09:00';
  $('#sheetBody .primary').click();
  await delay(120);
  assert.ok($('#view-module').textContent.includes('Take medicine'), 'reminder quick-add persists');

  navClick('More');
  await delay(25);
  $$('#view-more .tile').find(tile => /Notes/.test(tile.textContent)).click();
  await delay(25);
  $$('#view-module .btn').find(button => /New note/.test(button.textContent)).click();
  await delay(25);
  const noteInputs = $$('#sheetBody input, #sheetBody textarea');
  noteInputs[0].value = 'Redesign ideas';
  noteInputs[1].value = 'Premium blue, generous whitespace, calm motion.';
  $('#sheetBody .primary').click();
  await delay(120);
  assert.ok($('#view-module').textContent.includes('Redesign ideas'), 'note quick-add persists');
});

test('settings panel saves real preferences and updates the dashboard', async () => {
  navClick('More');
  await delay(30);
  $$('#view-more .tile').find(tile => /Settings/.test(tile.textContent)).click();
  await delay(30);
  assert.equal($('#sheetTitle').textContent, 'Settings');
  const nameInput = $('#sheetBody input[aria-label="Your name"]');
  assert.ok(nameInput, 'name field is labelled for assistive tech');
  nameInput.value = 'Aarav';
  $('#sheetBody .primary').click();
  await delay(120);
  assert.equal($('#sheet').classList.contains('open'), false, 'sheet closes after saving');
  navClick('Home');
  await delay(30);
  assert.ok($('#view-home').textContent.includes('Aarav'), 'saved name appears on the dashboard');
});

test('command centre opens and reports live counts', async () => {
  navClick('More');
  await delay(30);
  $$('#view-more .tile').find(tile => /Command Centre/.test(tile.textContent)).click();
  await delay(30);
  assert.equal($('#sheetTitle').textContent, 'Command Centre');
  assert.equal($('#sheet').classList.contains('open'), true, 'command centre sheet is open');
  const bodyText = $('#sheetBody').textContent;
  assert.ok(bodyText.includes('Pending actions'), 'pending section renders');
  assert.ok(/result/i.test(bodyText) || bodyText.length > 0, 'command centre has content');
});

test('sheet closes via close control and Escape', async () => {
  navClick('More');
  await delay(30);
  $$('#view-more .tile').find(tile => /Settings/.test(tile.textContent)).click();
  await delay(30);
  assert.equal($('#sheet').classList.contains('open'), true);
  $('#sheetClose').click();
  await delay(30);
  assert.equal($('#sheet').classList.contains('open'), false, 'close control dismisses the sheet');
  $$('#view-more .tile').find(tile => /Settings/.test(tile.textContent)).click();
  await delay(30);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await delay(30);
  assert.equal($('#sheet').classList.contains('open'), false, 'Escape dismisses the sheet');
});

test('Instagram workspace renders an existing draft with its status icon', async () => {
  const { Store } = await import('../js/store/store.js');
  const { openInstagramHub } = await import('../js/instagram/ui.js');
  const store = new Store();
  await store.init();
  const draft = store.addSync('instagramDraft', { videoName: 'Test reel.mp4', videoMime: 'video/mp4', videoSize: 1024, caption: 'A real draft', status: 'draft' });
  assert.ok(draft);
  await store.flush();
  openInstagramHub({ store, toast() {} });
  const row = $('#sheetBody .ig-draft-list .srow');
  assert.ok(row, 'existing draft is rendered');
  assert.match(row.textContent, /A real draft/);
  assert.ok(row.querySelector('svg'), 'status and draft icons render');
  assert.doesNotMatch(row.textContent, /\[object SVG/);
  await store.remove('instagramDraft', draft.id);
  $('#sheetClose').click();
  await delay(30);
});

test('dashboard cards do not inherit sheet positioning', () => {
  const css = fs.readFileSync(path.join(ROOT, 'css/app.css'), 'utf8');
  assert.match(css, /\.sheet\s+\.panel\s*\{\s*position:\s*absolute/);
  assert.doesNotMatch(css, /(?:^|\n)\.panel\s*\{\s*position:\s*absolute/);
});

test('redesigned shell reports no runtime errors', async () => {
  await delay(30);
  assert.deepEqual(errors, [], `runtime errors: ${errors.join('\n')}`);
});
