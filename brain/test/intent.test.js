import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../js/store/store.js';
import { MemoryBackend } from '../js/store/db.js';
import { Brain } from '../js/engine/intent.js';

let store, brain;
beforeEach(async () => { MemoryBackend._m = {}; store = new Store(); await store.init(); store.updateSettings({ name: 'Aarav', currency: '₹', locale: 'en-IN' }); brain = new Brain(store); });
afterEach(async () => { try { await store.db.destroy(); } catch {} });

async function say(text) { return brain.handle(text); }

function isSameClock(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() && a.getHours() === b.getHours() && a.getMinutes() === b.getMinutes();
}

test('one-time reminder with time', async () => {
  const r = await say('remind me to call mom tomorrow at 7pm');
  assert.match(r.text, /call mom/i);
  assert.equal(store.list('reminder').length, 1);
  const rem = store.list('reminder')[0];
  assert.match(rem.title, /call mom/i);
  const exp = new Date(); exp.setDate(exp.getDate() + 1); exp.setHours(19, 0, 0, 0);
  assert.ok(isSameClock(new Date(rem.at), exp), `expected ~${exp} got ${rem.at}`);
});

test('recurring weekly reminder', async () => {
  const r = await say('remind me to water the plants every sunday at 9am');
  assert.equal(store.list('reminder').length, 1);
  const rem = store.list('reminder')[0];
  assert.equal(rem.recur.freq, 'weekly');
  assert.deepEqual(rem.recur.days, [0]);
  assert.equal(rem.recur.time, '09:00');
});

test('recurring daily', async () => {
  await say('remind me to take medicine every day at 8pm');
  const rem = store.list('reminder')[0];
  assert.equal(rem.recur.freq, 'daily');
  assert.equal(rem.recur.time, '20:00');
});

test('reminder asks for missing time then completes', async () => {
  const r = await say('remind me to call John tomorrow');
  assert.match(r.text, /When should I remind you/);
  assert.equal(store.list('reminder').length, 0);
  const r2 = await say('7pm');
  assert.equal(store.list('reminder').length, 1);
  const rem = store.list('reminder')[0];
  assert.equal(new Date(rem.at).getHours(), 19);
});

test('task add with by friday', async () => {
  await say('add task finish the report by friday');
  assert.equal(store.list('task').length, 1);
  const t = store.list('task')[0];
  assert.match(t.title, /finish the report/i);
  assert.ok(t.due && new Date(t.due) > new Date());
  assert.equal(new Date(t.due).getDay(), 5);
});

test('task imperative submit assignment', async () => {
  await say('submit the assignment tomorrow');
  const t = store.list('task')[0];
  assert.match(t.title, /submit the assignment/i);
  const exp = new Date(); exp.setDate(exp.getDate() + 1);
  assert.equal(new Date(t.due).getDate(), exp.getDate());
});

test('private note saved', async () => {
  await say('remember the wifi password is Home123');
  const n = store.list('note')[0];
  assert.ok(n.private);
  assert.match(n.body, /Home123/i);
});

test('person birthday', async () => {
  await say("Priya's birthday is March 12");
  const p = store.list('person').find(x => x.name.toLowerCase() === 'priya');
  assert.ok(p);
  assert.match(p.birthday, /march 12/i);
});

test('person phone', async () => {
  await say("John's number is 9876500011");
  const p = store.list('person').find(x => x.name.toLowerCase() === 'john');
  assert.ok(p);
  assert.equal(p.phone, '9876500011');
});

test('expense', async () => {
  const r = await say('spent 850 on groceries');
  assert.equal(store.list('money').length, 1);
  const m = store.list('money')[0];
  assert.equal(m.kind, 'expense');
  assert.equal(m.amount, 850);
  assert.match(m.category, /groceries/i);
});

test('income', async () => {
  await say('salary came in 45000');
  const m = store.list('money')[0];
  assert.equal(m.kind, 'income');
  assert.equal(m.amount, 45000);
});

test('debt they owe me & I owe them', async () => {
  await say('Ravi owes me 500');
  assert.equal(store.list('debt').length, 1);
  assert.equal(store.list('debt')[0].dir, 'they_owe_me');
  await say('I owe Sarah 300');
  assert.equal(store.list('debt').length, 2);
  assert.equal(store.list('debt')[1].dir, 'i_owe_them');
});

test('stock add and consume', async () => {
  await say('I have 5kg rice');
  let it = store.list('stockItem')[0];
  assert.equal(it.qty, 5); assert.equal(it.unit, 'kg');
  await say('used 2kg rice');
  it = store.list('stockItem')[0];
  assert.equal(it.qty, 3);
});

test('habit logging', async () => {
  const r = await say('did yoga today');
  assert.match(r.text, /yoga/i);
  assert.equal(store.list('habit').length, 1);
});

test('journal', async () => {
  await say('I felt great today');
  assert.equal(store.list('journal').length, 1);
});

test('delete asks confirmation then deletes', async () => {
  await say('remember to buy milk');
  await say('delete the note about buy milk'); // none; use a task context instead
  // clear pending from above if any
  // Simpler: create task then delete it
  await say('add task clean the garage');
  assert.equal(store.list('task').length, 1);
  const r = await say('delete my task clean the garage');
  assert.match(r.text, /Delete/);
  assert.equal(store.list('task').length, 1, 'not deleted before confirm');
  await say('yes');
  assert.equal(store.list('task').length, 0);
});

test('mark last task done via pronoun', async () => {
  await say('add task write the chapter');
  assert.equal(store.list('task').length, 1);
  const r = await say('mark it done');
  assert.match(r.text, /done/i);
  assert.equal(store.list('task')[0].status, 'done');
});

test('correction updates last money amount', async () => {
  await say('spent 500 on groceries');
  await say('actually make that 650');
  const m = store.list('money')[0];
  assert.equal(m.amount, 650);
  assert.equal(store.list('money').length, 1, 'no duplicate');
});

test('query spend summary does not create data', async () => {
  await say('spent 850 on groceries');
  const r = await say('how much did I spend this month?');
  assert.match(r.text, /850/);
  assert.equal(store.list('money').length, 1);
});

test('query who owes me', async () => {
  await say('Ravi owes me 500');
  const r = await say('who owes me?');
  assert.match(r.text, /Ravi/);
});

test('search everything about John', async () => {
  await say("John's number is 9876500011");
  await say('John owes me 200');
  const r = await say('show everything about John');
  assert.ok(r.cards && r.cards.length >= 2);
});

test('unrecognized gives guidance, no crash', async () => {
  const r = await say('xyzzy nonsense blah');
  assert.match(r.text, /didn't quite catch/);
});

test('birthday query report', async () => {
  await say("Priya's birthday is March 12");
  const r = await say('who has a birthday coming up?');
  assert.match(r.text, /Priya/i);
});
