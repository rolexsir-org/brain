// Encryption helpers for backup — uses Web Crypto where available, with
// graceful fallback warning when not available (e.g. insecure context).

export async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 120000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt','decrypt']
  );
}

export async function encryptBackup(jsonText, password) {
  if (!crypto || !crypto.subtle || !password) throw new Error('Encryption unavailable or empty password');
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, btoa(String.fromCharCode(...salt)));
  const cipher = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, enc.encode(jsonText));
  // pack as: brain-enc-v1.<salt_b64>.<iv_b64>.<cipher_b64>
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `brain-enc-v1.${b64(salt)}.${b64(iv)}.${b64(cipher)}`;
}

export async function decryptBackup(packed, password) {
  if (!packed.startsWith('brain-enc-v1.')) throw new Error('Not an encrypted Brain backup');
  if (!password) throw new Error('Password required');
  const parts = packed.split('.');
  if (parts.length !== 4) throw new Error('Corrupt encrypted backup');
  const salt = parts[1], iv = parts[2], cipher = parts[3];
  const dec = (s) => Uint8Array.from(atob(s), c=>c.charCodeAt(0));
  const key = await deriveKey(password, salt);
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv: dec(iv) }, key, dec(cipher));
  return new TextDecoder().decode(plain);
}

export function isEncryptedBackup(text) {
  return typeof text === 'string' && text.startsWith('brain-enc-v1.');
}
