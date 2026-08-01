/**
 * Secret encryption at rest.
 *
 * Two independent schemes, deliberately distinguished by prefix:
 *
 *   enc:   AES-256-GCM under a key derived from this machine + user account. Zero friction
 *          (nothing to type) and it means a leaked, backed-up, or cloud-synced copy of
 *          local_data/ is useless elsewhere. It does NOT protect against someone using your
 *          already-logged-in account — that is documented in the README, not papered over.
 *
 *   encp:  AES-256-GCM under a scrypt-derived key from a user-supplied passphrase. Used only
 *          for export bundles, because the machine key by definition cannot travel.
 *
 * Anything without a known prefix is treated as plaintext and returned as-is, which gives
 * free auto-migration of values written before encryption existed.
 */
import crypto from 'crypto';
import os from 'os';

const MACHINE_PREFIX = 'enc:';
const PASSPHRASE_PREFIX = 'encp:';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

let machineKeyCache = null;

/** SHA256("reqlab-rest:" + hostname + ":" + username) — matches the sibling apps' scheme. */
export function machineKey() {
  if (!machineKeyCache) {
    const material = `reqlab-rest:${os.hostname()}:${os.userInfo().username}`;
    machineKeyCache = crypto.createHash('sha256').update(material).digest();
  }
  return machineKeyCache;
}

function seal(key, plaintext, prefix, extra = Buffer.alloc(0)) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([extra, iv, cipher.getAuthTag(), ciphertext]);
  return prefix + payload.toString('base64');
}

function open(key, payload) {
  // Anything shorter cannot hold an IV plus a full-length tag, so it is malformed by
  // definition — reject before any crypto runs.
  if (payload.length < IV_BYTES + TAG_BYTES) throw new Error('Ciphertext is truncated');

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);

  // authTagLength is pinned on both sides: without it, a shorter-than-expected tag would be
  // accepted, which weakens GCM's forgery resistance.
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/* ---------------------------------------------------------------- *
 * Machine-keyed (at rest, this machine only)
 * ---------------------------------------------------------------- */

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(MACHINE_PREFIX);
}

export function encrypt(plaintext) {
  if (plaintext === '' || plaintext == null) return '';
  if (isEncrypted(plaintext)) return plaintext;
  return seal(machineKey(), plaintext, MACHINE_PREFIX);
}

/**
 * Returns the plaintext. Values without the enc: prefix pass through untouched
 * (plaintext auto-migration). Throws if a prefixed value cannot be decrypted — that means
 * the file came from another machine, and silently returning ciphertext would let it be
 * sent over the wire as if it were a real credential.
 */
export function decrypt(value) {
  if (typeof value !== 'string' || !isEncrypted(value)) return value ?? '';
  const payload = Buffer.from(value.slice(MACHINE_PREFIX.length), 'base64');
  try {
    return open(machineKey(), payload);
  } catch {
    throw new Error(
      'Could not decrypt a stored secret. It was encrypted on a different machine or user ' +
        'account — re-enter it, or import it from an export bundle.',
    );
  }
}

/** True when the value is encrypted but this machine cannot open it. */
export function isForeign(value) {
  if (!isEncrypted(value)) return false;
  try {
    decrypt(value);
    return false;
  } catch {
    return true;
  }
}

/* ---------------------------------------------------------------- *
 * Passphrase-keyed (export bundles, cross-machine)
 * ---------------------------------------------------------------- */

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function passphraseKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, KEY_BYTES, SCRYPT_PARAMS);
}

export function isPassphraseEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PASSPHRASE_PREFIX);
}

export function encryptWithPassphrase(plaintext, passphrase) {
  if (!passphrase) throw new Error('A passphrase is required to encrypt an export bundle.');
  if (plaintext === '' || plaintext == null) return '';
  const salt = crypto.randomBytes(SALT_BYTES);
  return seal(passphraseKey(passphrase, salt), plaintext, PASSPHRASE_PREFIX, salt);
}

export function decryptWithPassphrase(value, passphrase) {
  if (!isPassphraseEncrypted(value)) return value ?? '';
  // Checked before any crypto runs, so a missing passphrase says so plainly instead of
  // surfacing as "wrong passphrase, or the bundle is corrupt".
  if (!passphrase) throw new Error('A passphrase is required to decrypt this export bundle.');
  const payload = Buffer.from(value.slice(PASSPHRASE_PREFIX.length), 'base64');
  const salt = payload.subarray(0, SALT_BYTES);
  try {
    return open(passphraseKey(passphrase, salt), payload.subarray(SALT_BYTES));
  } catch {
    throw new Error('Wrong passphrase, or the export bundle is corrupt.');
  }
}
