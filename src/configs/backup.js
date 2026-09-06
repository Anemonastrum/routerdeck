import crypto from 'node:crypto';
import { exportConfiguration, restoreConfiguration } from '../db/index.js';

const FORMAT = 'routerdeck-config-backup-v1';

function deriveKey(password, salt) {
  return crypto.scryptSync(String(password), salt, 32);
}

function effectivePassword(password, mode) {
  if (mode === 'app-secret') return process.env.APP_SECRET || '';
  const value = String(password || '');
  if (!value) throw new Error('Backup password is required for this backup');
  return value;
}

export function createConfigurationBackup(password = '') {
  const usePassword = Boolean(String(password || ''));
  const mode = usePassword ? 'password' : 'app-secret';
  const secret = usePassword ? String(password) : String(process.env.APP_SECRET || '');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(exportConfiguration()), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    format: FORMAT,
    version: 1,
    mode,
    createdAt: Date.now(),
    salt: salt.toString('base64url'),
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    payload: encrypted.toString('base64url'),
  };
}

export function restoreConfigurationBackup(backup, password = '') {
  if (!backup || backup.format !== FORMAT || Number(backup.version) !== 1) {
    throw new Error('This is not a supported RouterDeck configuration backup');
  }

  const secret = effectivePassword(password, backup.mode);

  // Stage 1 — decrypt. Any failure here (wrong password, tampered payload,
  // malformed envelope) maps to one friendly message. We deliberately do NOT
  // classify the error by message text: OpenSSL/GCM wording varies across
  // Node versions, so a regex approach leaks raw errors like
  // "Unsupported state or unable to authenticate data".
  let decrypted;
  try {
    const salt = Buffer.from(String(backup.salt || ''), 'base64url');
    const iv = Buffer.from(String(backup.iv || ''), 'base64url');
    const tag = Buffer.from(String(backup.tag || ''), 'base64url');
    const encrypted = Buffer.from(String(backup.payload || ''), 'base64url');
    const key = deriveKey(secret, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Could not decrypt or restore this backup. Check the backup password and APP_SECRET.');
  }

  // Stage 2 — parse the envelope (GCM already authenticates the bytes, so a
  // parse failure means a corrupt payload, not a wrong password).
  let config;
  try {
    config = JSON.parse(decrypted);
  } catch {
    throw new Error('Could not decrypt or restore this backup. Check the backup password and APP_SECRET.');
  }

  // Stage 3 — restore. Validation errors (bad format/types, duplicate
  // gateways) pass through untouched so the user sees the precise reason.
  return restoreConfiguration(config);
}
