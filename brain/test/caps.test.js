import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getCaps, isIOS, isAndroid, isMobileUA } from '../js/caps.js';

function input() { return { capture: '' }; }

test('capability snapshot reports exposed APIs without assuming online support', () => {
  class FileMock { constructor() {} }
  const window = {
    Notification: { permission: 'default', requestPermission() {} },
    PushManager: function PushManager() {},
    File: FileMock,
    showSaveFilePicker() {},
    matchMedia: () => ({ matches: true })
  };
  const navigator = {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile)', onLine: false,
    serviceWorker: { controller: {}, ready: Promise.resolve() },
    share() {}, canShare: () => true,
    clipboard: { writeText() {} },
    geolocation: { getCurrentPosition() {} }, contacts: { select() {} }
  };
  const document = { createElement: () => input(), execCommand() {} };
  const caps = getCaps({ window, navigator, document });
  assert.equal(caps.platform.online, false);
  assert.equal(caps.notifications.supported, true);
  assert.equal(caps.notifications.pushApi, true);
  assert.equal(caps.sw.controlled, true);
  assert.equal(caps.share.webShare, true);
  assert.equal(caps.share.shareFiles, true);
  assert.equal(caps.files.fileSystemAccess, true);
  assert.equal(caps.contacts.select, true);
  assert.equal(caps.geolocation.supported, true);
});

test('desktop capture attributes do not produce a misleading camera picker control', () => {
  const window = { File: class FileMock {} };
  const navigator = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' };
  const document = { createElement: () => input() };
  assert.equal(getCaps({ window, navigator, document }).files.captureCamera, false);
});

test('user agent helpers identify iOS / Android / mobile inputs', () => {
  assert.equal(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'), true);
  assert.equal(isAndroid('Mozilla/5.0 (Linux; Android 14; Pixel)'), true);
  assert.equal(isMobileUA('Mozilla/5.0 (iPad; CPU OS 17_0)'), true);
  assert.equal(isMobileUA('Mozilla/5.0 (X11; Linux x86_64)'), false);
});
