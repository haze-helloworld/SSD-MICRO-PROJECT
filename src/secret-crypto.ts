import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * The encryption key is derived from the provided secret via SHA-256.
 * Output is formatted as base64(IV [12 bytes] + AuthTag [16 bytes] + Ciphertext).
 */
export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Decrypts a base64 string formatted as IV [12 bytes] + AuthTag [16 bytes] + Ciphertext using AES-256-GCM.
 */
export function decryptSecret(encryptedBase64: string, secret: string): string {
  const key = deriveKey(secret);
  const buf = Buffer.from(encryptedBase64, 'base64');
  if (buf.length < 28) {
    throw new Error('Invalid encrypted payload length');
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
