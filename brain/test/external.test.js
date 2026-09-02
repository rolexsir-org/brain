import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Ext from '../js/actions/external.js';

test('phone, SMS, mail and WhatsApp builders are conservative and encoded', () => {
  assert.equal(Ext.toDialable(' +91 (987) 650-0011 '), '+919876500011');
  assert.equal(Ext.toDialable('12++34'), '1234');
  assert.equal(Ext.telUri('+91 (987) 650-0011'), 'tel:+919876500011');
  assert.equal(Ext.telUri('123'), null);
  assert.equal(Ext.smsUri('+919876500011', 'I’ll be there & ready'), 'sms:+919876500011?body=I%E2%80%99ll%20be%20there%20%26%20ready');
  assert.equal(Ext.smsUri('+919876500011', 'hello', { ios: true }), 'sms:+919876500011&body=hello');
  assert.equal(Ext.mailtoUri('john@example.com', { subject: 'Project & notes', body: 'Hi John' }), 'mailto:john@example.com?subject=Project%20%26%20notes&body=Hi%20John');
  assert.equal(Ext.mailtoUri('not-an-email'), null);
  assert.equal(Ext.mailtoUri('plus+tag@example.com'), 'mailto:plus%2Btag@example.com');
  assert.equal(Ext.waChatLink('9876500011'), null, 'no country code is guessed');
  assert.equal(Ext.waChatLink('9876500011', 'hello & bye', { countryCode: '91' }), 'https://wa.me/919876500011?text=hello%20%26%20bye');
  assert.equal(Ext.waChatLink('+919876500011', 'hello'), 'https://wa.me/919876500011?text=hello');
});

test('map, Instagram and external links use legitimate public URL formats', () => {
  assert.equal(Ext.mapsUri('12.97, 77.59'), 'https://www.google.com/maps/search/?api=1&query=12.97%2C%2077.59');
  assert.equal(Ext.mapsUri('12.97, 77.59', { directions: true }), 'https://www.google.com/maps/dir/?api=1&destination=12.97%2C+77.59');
  assert.equal(Ext.mapsUri('John’s house', { directions: true }), 'https://www.google.com/maps/dir/?api=1&destination=John%E2%80%99s+house');
  assert.equal(Ext.instagramProfileUri('@john.doe'), 'https://www.instagram.com/john.doe/');
  assert.equal(Ext.instagramProfileUri('bad/handle'), 'https://www.instagram.com/badhandle/');
  assert.equal(Ext.openLinkUri('https://example.com/a'), 'https://example.com/a');
  assert.equal(Ext.openLinkUri('javascript:alert(1)'), null);
  assert.equal(Ext.openLinkUri('/relative'), null);
});

test('device contacts reports a denied permission rather than treating it as a silent cancel', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { contacts: { select: async () => { const error = new Error('denied'); error.name = 'NotAllowedError'; throw error; } } }
  });
  try {
    const result = await Ext.pickDeviceContacts();
    assert.equal(result.ok, false);
    assert.equal(result.denied, true);
    assert.equal(result.cancelled, undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});

test('ICS builder accepts ISO strings and has required calendar fields', () => {
  const ics = Ext.buildIcs({
    title: 'Dentist, check-up',
    start: '2026-03-12T10:00:00.000Z',
    end: '2026-03-12T11:00:00.000Z',
    location: 'Main; Clinic',
    description: 'Bring x-rays\nAsk about follow-up'
  });
  assert.match(ics, /^BEGIN:VCALENDAR\r\nVERSION:2\.0/m);
  assert.match(ics, /SUMMARY:Dentist\\, check-up/);
  assert.match(ics, /LOCATION:Main\\; Clinic/);
  assert.match(ics, /DESCRIPTION:Bring x-rays\\nAsk about follow-up/);
  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
  assert.match(ics, /DTSTART:20260312T100000/);
  assert.match(ics, /DTEND:20260312T110000/);
  const allDay = Ext.buildIcs({ title: 'Birthday', start: '2026-03-12T00:00:00.000Z', allDay: true });
  assert.match(allDay, /DTSTART;VALUE=DATE:20260312/);
  assert.match(allDay, /DTEND;VALUE=DATE:20260313/);
  const folded = Ext.buildIcs({ title: 'Long event', start: '2026-03-12T10:00:00.000Z', description: 'x'.repeat(180) });
  assert.match(folded, /DESCRIPTION:x{60,}\r\n x+/);
});
