import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';
import { Brain } from '../js/engine/intent.js';

let store;
let brain;
beforeEach(async () => {
  MemoryBackend._m = {};
  store = new Store();
  await store.init();
  await store.updateSettings({ name: 'Aarav', countryCode: '91' });
  brain = new Brain(store);
  await brain.handle("John Home's number is 9876500011");
  await brain.handle("John Work's number is +919876500012");
  await brain.handle("John Home's email is home@example.com");
  await brain.handle("John Home's instagram is @john_home");
  await brain.handle("John Home lives at 12 Market Road");
  await brain.handle("John Home's alias is Johnny");
});

test('call, SMS, WhatsApp, email, maps and Instagram intents return legitimate action requests', async () => {
  let reply = await brain.handle('call Johnny');
  assert.equal(reply.run.id, 'call');
  assert.equal(reply.run.args.number, '9876500011');
  reply = await brain.handle('text Johnny “I’ll be there at 7”');
  assert.equal(reply.run.id, 'sms');
  assert.equal(reply.run.args.body, 'I’ll be there at 7');
  reply = await brain.handle('WhatsApp Johnny saying hello');
  assert.equal(reply.run.id, 'whatsapp');
  assert.equal(reply.run.args.countryCode, '91');
  assert.equal(reply.run.args.text, 'hello');
  reply = await brain.handle('email Johnny the project update');
  assert.equal(reply.run.id, 'email');
  assert.equal(reply.run.args.email, 'home@example.com');
  assert.match(reply.run.args.body, /project update/i);
  reply = await brain.handle("open Johnny's instagram");
  assert.equal(reply.run.id, 'open');
  assert.equal(reply.run.args.url, 'https://www.instagram.com/john_home/');
  reply = await brain.handle("navigate to Johnny's house");
  assert.equal(reply.run.id, 'maps');
  assert.equal(reply.run.args.query, '12 Market Road');
  assert.equal(reply.run.args.directions, true);
});

test('WhatsApp commands without a country code offer only the honest share-route fallback', async () => {
  await store.updateSettings({ countryCode: '' });
  const reply = await brain.handle('WhatsApp 9876500011');
  assert.equal(reply.run.id, 'whatsapp');
  assert.equal(reply.run.args.allowShareFallback, true);
  assert.match(reply.text, /share page/i);
});

test('ambiguous contacts ask a concise question and accept an answer', async () => {
  const first = await brain.handle('call John');
  assert.match(first.text, /Which John/i);
  assert.equal(first.actions.length, 2);
  const chosen = await brain.handle('John Work');
  assert.equal(chosen.run.id, 'call');
  assert.equal(chosen.run.args.number, '+919876500012');
});

test('ambiguous Instagram choices resolve to a real open action, not a fake executor', async () => {
  const reply = await brain.handle("open John's Instagram");
  assert.match(reply.text, /Which John/i);
  assert.equal(reply.actions.length, 1);
  assert.equal(reply.actions[0].id, 'open');
  assert.equal(reply.actions[0].clearPending, true);
  assert.equal(reply.actions[0].args.url, 'https://www.instagram.com/john_home/');
});

test('today plan only includes recurring reminders that actually occur today', () => {
  const now = new Date();
  const notToday = (now.getDay() + 1) % 7;
  store.addSync('reminder', {
    title: 'Tomorrow only', status: 'active',
    recur: { freq: 'weekly', interval: 1, days: [notToday], time: '09:00', anchor: now.toISOString() }
  });
  assert.doesNotMatch(brain._sharePlanText(), /Tomorrow only/);
});

test('upcoming plans do not surface a recurring reminder with no near occurrence', () => {
  const now = new Date();
  store.addSync('reminder', {
    title: 'Far yearly reminder', status: 'active',
    recur: {
      freq: 'yearly', interval: 1, monthOfYear: (now.getMonth() + 6) % 12,
      dayOfMonth: 1, time: '09:00', anchor: now.toISOString()
    }
  });
  const reply = brain._todayPlan(7);
  assert.equal(reply.cards.some(card => card.kind === 'reminder' && store.get('reminder', card.id).title === 'Far yearly reminder'), false);
});

test('sharing a local photo keeps the file attachment in the action payload', async () => {
  const photo = store.addSync('photo', { name: 'receipt.jpg', dataUrl: `data:image/jpeg;base64,/9j/${'A'.repeat(120)}` });
  brain.ctx.push('photo', photo.id, photo.name);
  const reply = await brain.handle('share this photo');
  assert.equal(reply.run.id, 'share');
  assert.equal(reply.run.args.photoId, photo.id);
  assert.equal(reply.run.args.text, 'Photo from Brain');
});

test('photo, calendar and social share commands return explicit user-tappable handoffs', async () => {
  let reply = await brain.handle('add a photo to my journal');
  assert.equal(reply.run.id, 'photoPick');
  assert.equal(reply.run.args.attachTo, 'journal');
  reply = await brain.handle('schedule dentist appointment tomorrow at 3pm');
  assert.equal(store.list('event').length, 1);
  reply = await brain.handle('add that to my calendar');
  assert.equal(reply.run.id, 'calendar');
  assert.ok(reply.run.args.start);
  reply = await brain.handle('share this event to Instagram');
  assert.equal(reply.run.id, 'share');
  assert.match(reply.text, /cannot post to Instagram automatically/i);
  reply = await brain.handle('share this event to WhatsApp');
  assert.equal(reply.run.id, 'whatsapp');
  assert.equal(reply.run.args.number, '');
  assert.match(reply.text, /official share page/i);
  reply = await brain.handle('automate a post to Instagram');
  assert.equal(reply.run, null);
  assert.match(reply.text, /cannot post to or automate Instagram/i);
});
