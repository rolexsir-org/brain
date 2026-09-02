import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escHtml, cleanName, score, parseNum, formatMoney, clampStr, todayKey } from '../js/util/util.js';

test('escHtml neutralizes markup', () => {
  assert.equal(escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escHtml('a & b < c > d " q'), 'a &amp; b &lt; c &gt; d &quot; q');
  assert.equal(escHtml(null), '');
});

test('cleanName strips honorifics and normalizes', () => {
  assert.equal(cleanName('Dr.  Sharma'), 'Sharma');
  assert.equal(cleanName('  John   Doe  '), 'John Doe');
  assert.equal(cleanName('Mr. Smith'), 'Smith');
});

test('score matching', () => {
  assert.ok(score('john', 'john') >= 10);
  assert.ok(score('john', 'call john tomorrow') > 0);
  assert.ok(score('john', 'mary') === 0);
  assert.ok(score('joh', 'john smith') > 0); // prefix
});

test('parseNum handles grouping and k', () => {
  assert.equal(parseNum('₹1,20,000'), 120000);
  assert.equal(parseNum('5k'), 5000);
  assert.equal(parseNum('2 thousand'), 2000);
  assert.equal(parseNum('68'), 68);
  assert.ok(Number.isNaN(parseNum('abc')));
});

test('formatMoney', () => {
  assert.equal(formatMoney(120000, { currency: '₹', locale: 'en-IN' }), '₹1,20,000');
  assert.equal(formatMoney(-850, { currency: '$' }), '-$850');
  assert.equal(formatMoney(12.5, { currency: '₹', cents: true }), '₹12.50');
});

test('clampStr limits length', () => {
  assert.equal(clampStr('x'.repeat(10000)).length, 5000);
});

test('todayKey', () => {
  const d = new Date(2026, 2, 6, 23, 59);
  assert.equal(todayKey(d), '2026-03-06');
});
