import { test } from 'node:test';
import assert from 'node:assert/strict';
import { availableActions, ACTION, canOffer } from '../js/actions/system.js';

const caps = {
  files: { picker: true, captureCamera: true },
  share: { webShare: true, shareFiles: true },
  contacts: { select: true },
  geolocation: { supported: true }
};

test('person actions only expose supported, meaningful handoffs', () => {
  const actions = availableActions('person', {
    id: 'p1', name: 'John', phone: '+919876500011', email: 'john@example.com',
    address: '12 Market Road', instagram: 'john_brain'
  }, { caps, settings: {} });
  const ids = actions.map(action => action.id);
  assert.ok(ids.includes(ACTION.CALL));
  assert.ok(ids.includes(ACTION.SMS));
  assert.ok(ids.includes(ACTION.WHATSAPP));
  assert.ok(ids.includes(ACTION.EMAIL));
  assert.ok(ids.includes(ACTION.MAPS));
  assert.ok(ids.includes(ACTION.OPEN));
  assert.ok(ids.includes(ACTION.COPY));
});

test('WhatsApp is not offered for a local number when no country code is configured', () => {
  const actions = availableActions('person', { id: 'p1', name: 'John', phone: '9876500011' }, { caps, settings: {} });
  assert.equal(actions.some(action => action.id === ACTION.WHATSAPP), false);
  const configured = availableActions('person', { id: 'p1', name: 'John', phone: '9876500011' }, { caps, settings: { countryCode: '91' } });
  assert.equal(configured.some(action => action.id === ACTION.WHATSAPP), true);
});

test('journal photo controls are only offered when the referenced local photo exists', () => {
  const missing = availableActions('journal', { id: 'j1', text: 'Entry', photoId: 'gone' }, { caps, settings: {}, store: { get: () => null } });
  assert.equal(missing.some(action => action.id === ACTION.PHOTO_VIEW), false);
  const photo = { id: 'p1', dataUrl: `data:image/jpeg;base64,/9j/${'A'.repeat(120)}` };
  const present = availableActions('journal', { id: 'j1', text: 'Entry', photoId: 'p1' }, { caps, settings: {}, store: { get: () => photo } });
  const view = present.find(action => action.id === ACTION.PHOTO_VIEW);
  assert.equal(view.args.id, 'p1');
  assert.equal(view.args.dataUrl, photo.dataUrl);
});

test('capability checks distinguish real pickers from unsupported actions', () => {
  assert.equal(canOffer(ACTION.PHOTO_PICK, {}, { caps }), true);
  assert.equal(canOffer(ACTION.CONTACT_PICK, {}, { caps }), true);
  assert.equal(canOffer(ACTION.LOCATION_CURRENT, {}, { caps }), true);
  assert.equal(canOffer(ACTION.CAMERA_PICK, {}, { caps: { files: { picker: true, captureCamera: false } } }), false);
  assert.equal(canOffer(ACTION.OPEN, { url: 'javascript:alert(1)' }, { caps }), false);
  assert.equal(canOffer(ACTION.WHATSAPP, { number: '9876500011', allowShareFallback: true }, { caps, settings: {} }), true);
});
