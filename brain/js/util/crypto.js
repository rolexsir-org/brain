// Encryption helpers for backup — uses Web Crypto where available
// Versioned: brain-enc-v1 used 120k, v2 uses 600k (OWASP ref). Both decryptable.

const PBKDF2_ITERATIONS_V1 = 120000;
const PBKDF2_ITERATIONS_V2 = 600000; // OWASP 2023 reference for PBKDF2-HMAC-SHA256

export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS_V2) {
  const enc = new TextEncoder();
  if (!password || String(password).length < 4) throw new Error('Passphrase too short (min 4 chars)');
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: typeof salt === 'string' ? new TextEncoder().encode(salt) : salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt','decrypt']
  );
}
export const ITERATIONS_V1 = PBKDF2_ITERATIONS_V1;
export const ITERATIONS_V2 = PBKDF2_ITERATIONS_V2;

export async function encryptBackup(jsonText, password, version='v2') {
  if (!crypto || !crypto.subtle || !password) throw new Error('Encryption unavailable or empty password');
  if (String(password).length < 4) throw new Error('Passphrase too short');
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const iterations = version==='v1' ? ITERATIONS_V1 : ITERATIONS_V2;
  // salt is bytes; we store b64 of raw salt, but deriveKey expects string form for PBKDF2 salt param? we pass b64 string directly for determinism
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const saltB64 = b64(salt);
  const key = await deriveKey(password, saltB64, iterations);
  const cipher = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(jsonText));
  const tag = version==='v1' ? 'brain-enc-v1' : 'brain-enc-v2';
  return `${tag}.${saltB64}.${b64(iv)}.${b64(cipher)}`;
}

export async function decryptBackup(packed, password) {
  if (!packed.startsWith('brain-enc-v')) throw new Error('Not an encrypted Brain backup');
  if (!password) throw new Error('Password required');
  const parts = packed.split('.');
  if (parts.length !== 4) throw new Error('Corrupt encrypted backup');
  const ver = parts[0]; // brain-enc-v1 or v2
  const iterations = ver==='brain-enc-v1' ? ITERATIONS_V1 : ver==='brain-enc-v2' ? ITERATIONS_V2 : null;
  if (!iterations) throw new Error('Unknown backup version');
  const salt = parts[1], iv = parts[2], cipher = parts[3];
  // Validate b64 and sizes
  if (salt.length < 10 || iv.length < 10 || cipher.length < 10) throw new Error('Corrupt encrypted backup (truncated)');
  const dec = (s) => {
    try { return Uint8Array.from(atob(s), c=>c.charCodeAt(0)); } catch { throw new Error('Corrupt encrypted backup (invalid base64)'); }
  };
  const saltBytes = dec(salt); if (saltBytes.length !== 16) throw new Error('Corrupt salt');
  const ivBytes = dec(iv); if (ivBytes.length !== 12) throw new Error('Corrupt IV');
  dec(cipher); // validate
  const key = await deriveKey(password, salt, iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv: ivBytes }, key, dec(cipher));
    return new TextDecoder().decode(plain);
  } catch (e) {
    // AES-GCM auth tag failure
    throw new Error('Decryption failed — wrong password or corrupted backup (authentication failed)');
  }
}

export function isEncryptedBackup(text) {
  return typeof text === 'string' && (text.startsWith('brain-enc-v1.') || text.startsWith('brain-enc-v2.'));
}
export function encryptedVersion(text) {
  if (text.startsWith('brain-enc-v2.')) return 'v2';
  if (text.startsWith('brain-enc-v1.')) return 'v1';
  return null;
}
