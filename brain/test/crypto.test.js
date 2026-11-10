// Regression tests for backup encryption: passphrase policy on new backups,
// unchanged wire format, and continued decryption of existing v1/v2 backups.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encryptBackup, decryptBackup, isEncryptedBackup, encryptedVersion,
  MIN_PASSPHRASE_LENGTH, ITERATIONS_V1, ITERATIONS_V2
} from '../js/util/crypto.js';

const STATE = JSON.stringify({
  app: 'brain', schema: 5, exportedAt: '2026-01-01T00:00:00.000Z',
  collections: { task: [{ id: 't1', title: 'Ship it' }] }
});

const b64 = bytes => Buffer.from(bytes).toString('base64');

/**
 * Reproduce a backup exactly as the previous release wrote it, with no length
 * policy. This is what a user's existing .enc file looks like.
 */
async function legacyEncrypt(jsonText, password, { version = 'v2' } = {}) {
  const iterations = version === 'v1' ? ITERATIONS_V1 : ITERATIONS_V2;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const saltB64 = b64(salt);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode(saltB64), iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(jsonText));
  return `brain-enc-${version}.${saltB64}.${b64(iv)}.${b64(new Uint8Array(cipher))}`;
}

test('new backups require the documented minimum passphrase length', async () => {
  assert.equal(MIN_PASSPHRASE_LENGTH, 12);
  for (const weak of ['abcd', 'pass123', 'testpass', 'testpass123', 'a'.repeat(MIN_PASSPHRASE_LENGTH - 1)]) {
    await assert.rejects(
      () => encryptBackup(STATE, weak),
      new RegExp(`at least ${MIN_PASSPHRASE_LENGTH} characters`),
      `${weak.length}-character passphrase must be refused`
    );
  }
  await assert.rejects(() => encryptBackup(STATE, ''), /Password required/);
  await assert.rejects(() => encryptBackup(STATE, null), /Password required/);
});

test('a valid passphrase still produces a v2 backup that round-trips', async () => {
  const password = 'correct horse battery staple';
  const packed = await encryptBackup(STATE, password);
  assert.match(packed, /^brain-enc-v2\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
  assert.equal(packed.split('.').length, 4, 'format is unchanged: tag.salt.iv.cipher');
  assert.equal(Buffer.from(packed.split('.')[1], 'base64').length, 16, 'salt stays 16 bytes');
  assert.equal(Buffer.from(packed.split('.')[2], 'base64').length, 12, 'iv stays 12 bytes');
  assert.equal(await decryptBackup(packed, password), STATE);
  assert.equal(isEncryptedBackup(packed), true);
  assert.equal(encryptedVersion(packed), 'v2');
});

test('a passphrase at exactly the minimum is accepted and code points are counted', async () => {
  const twelve = 'abcdefghijkl';
  assert.equal(twelve.length, MIN_PASSPHRASE_LENGTH);
  const packed = await encryptBackup(STATE, twelve);
  assert.equal(await decryptBackup(packed, twelve), STATE);
  // 11 astral characters are 22 UTF-16 units but only 11 characters.
  const emoji = '🔐'.repeat(MIN_PASSPHRASE_LENGTH - 1);
  assert.equal(emoji.length > MIN_PASSPHRASE_LENGTH, true);
  await assert.rejects(() => encryptBackup(STATE, emoji), /at least 12 characters/);
});

test('existing v1 and v2 backups with short passphrases still decrypt', async () => {
  for (const version of ['v1', 'v2']) {
    for (const password of ['abcd', 'pass123', 'testpass']) {
      const legacy = await legacyEncrypt(STATE, password, { version });
      assert.equal(encryptedVersion(legacy), version);
      assert.equal(
        await decryptBackup(legacy, password), STATE,
        `${version} backup with a ${password.length}-character passphrase must still open`
      );
    }
  }
});

test('wrong passphrases and tampered backups fail closed', async () => {
  const password = 'a-long-enough-passphrase';
  const packed = await encryptBackup(STATE, password);
  const [tag, salt, iv, cipher] = packed.split('.');

  await assert.rejects(() => decryptBackup(packed, 'another-long-passphrase'), /Incorrect password|corrupt/i);
  // Auth tag catches a flipped ciphertext byte and a swapped IV.
  const flipped = b64(Buffer.from(cipher, 'base64').map((byte, index) => index === 0 ? byte ^ 0xff : byte));
  await assert.rejects(() => decryptBackup(`${tag}.${salt}.${iv}.${flipped}`, password), /Incorrect password|corrupt/i);
  const otherIv = b64(new Uint8Array(12).fill(7));
  await assert.rejects(() => decryptBackup(`${tag}.${salt}.${otherIv}.${cipher}`, password), /Incorrect password|corrupt/i);
  // Truncated / malformed structures are rejected before any crypto runs.
  await assert.rejects(() => decryptBackup(`${tag}.${salt}.${iv}`, password), /Corrupt|format/i);
  await assert.rejects(() => decryptBackup(`${tag}.${'!'.repeat(24)}.${iv}.${cipher}`, password), /Corrupt|base64/i);
  await assert.rejects(() => decryptBackup(`${tag}.${b64(new Uint8Array(8))}.${iv}.${cipher}`, password), /Corrupt salt/i);
  await assert.rejects(() => decryptBackup(`${tag}.${salt}.${b64(new Uint8Array(8))}.${cipher}`, password), /Corrupt IV/i);
  await assert.rejects(() => decryptBackup('brain-enc-v9.a.b.c', password), /Unknown backup version/);
  await assert.rejects(() => decryptBackup('{"app":"brain"}', password), /Not an encrypted Brain backup/);
  await assert.rejects(() => decryptBackup(packed, ''), /Password required/);
});

test('plain JSON backups are still recognised as unencrypted', () => {
  assert.equal(isEncryptedBackup(STATE), false);
  assert.equal(isEncryptedBackup('brain-enc-v2.short'), true, 'prefix detection is unchanged');
  assert.equal(encryptedVersion('not-encrypted'), null);
});

test('the backup store surfaces the policy instead of writing a weak file', async () => {
  // exportStateEncrypted is the only production caller of encryptBackup.
  const { Store } = await import('../js/store/store.js');
  const store = new Store();
  await assert.rejects(
    () => store.exportStateEncrypted('short'),
    /Encryption failed: .*at least 12 characters/,
    'a weak passphrase must abort the export, not silently produce a plain/weak backup'
  );
  assert.equal(await store.exportStateEncrypted(null).then(result => result.encrypted), false);
});
