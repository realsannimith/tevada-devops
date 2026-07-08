/**
 * Credential storage backed by Electron `safeStorage` (macOS Keychain on Mac,
 * libsecret/kwallet on Linux, DPAPI on Windows).
 *
 * Secrets are encrypted to opaque binary blobs at `<userData>/secrets/<id>.bin`.
 * They are only ever decrypted in the main process and NEVER cross IPC back to
 * the renderer. All functions must be called after `app.whenReady()`.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ServerSecret } from '../shared/ipc-types';

const SAFE_STORAGE_APP_NAME_FALLBACKS = [
  'Electron',
  'Tevada DevOps (Dev)',
  'Tevada DevOps',
  'easy-host',
  'tevada-devops',
];

function secretsDir(): string {
  const dir = path.join(app.getPath('userData'), 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function secretPath(serverId: string): string {
  return path.join(secretsDir(), `${serverId}.bin`);
}

const writeListeners = new Set<(id: string) => void>();

export function onWrite(listener: (id: string) => void): () => void {
  writeListeners.add(listener);
  return () => writeListeners.delete(listener);
}

function notifyWrite(id: string): void {
  for (const listener of writeListeners) {
    try {
      listener(id);
    } catch (error) {
      console.warn('[secrets] write listener failed', {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** True when the OS provides a real encryption backend (keychain/keyring). */
export function secretsAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function safeStorageAppNames(): string[] {
  return Array.from(new Set([app.getName(), ...SAFE_STORAGE_APP_NAME_FALLBACKS]));
}

function withAppName<T>(name: string, fn: () => T): T {
  const currentName = app.getName();
  if (currentName === name) return fn();
  try {
    app.setName(name);
    return fn();
  } finally {
    app.setName(currentName);
  }
}

function encryptString(value: string): Buffer {
  return safeStorage.encryptString(value);
}

function decryptString(buf: Buffer): string {
  let lastError: unknown;
  for (const name of safeStorageAppNames()) {
    try {
      return withAppName(name, () => safeStorage.decryptString(buf));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export function saveSecret(serverId: string, secret: ServerSecret): void {
  if (!secretsAvailable()) {
    throw new Error(
      'OS secure storage is unavailable — cannot store credentials safely. ' +
        'On Linux, ensure a keyring (gnome-keyring / kwallet) is running.',
    );
  }
  const encrypted = encryptString(JSON.stringify(secret));
  const tmp = `${secretPath(serverId)}.tmp`;
  fs.writeFileSync(tmp, encrypted);
  fs.renameSync(tmp, secretPath(serverId));
  notifyWrite(serverId);
}

export function loadSecret(serverId: string): ServerSecret | undefined {
  try {
    const buf = fs.readFileSync(secretPath(serverId));
    const json = decryptString(buf);
    return JSON.parse(json) as ServerSecret;
  } catch (error) {
    console.warn('[secrets] failed to decrypt server secret', {
      serverId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function deleteSecret(serverId: string): void {
  try {
    fs.unlinkSync(secretPath(serverId));
    notifyWrite(serverId);
  } catch {
    /* already gone */
  }
}

// --- raw string secrets (non-server credentials, e.g. the GitHub token) -----

export function saveRawSecret(id: string, value: string): void {
  if (!secretsAvailable()) {
    throw new Error(
      'OS secure storage is unavailable — cannot store credentials safely. ' +
        'On Linux, ensure a keyring (gnome-keyring / kwallet) is running.',
    );
  }
  const encrypted = encryptString(value);
  const tmp = `${secretPath(id)}.tmp`;
  fs.writeFileSync(tmp, encrypted);
  fs.renameSync(tmp, secretPath(id));
  notifyWrite(id);
}

/** Whether a raw secret blob exists, without decrypting (no warn spam). */
export function hasRawSecret(id: string): boolean {
  return fs.existsSync(secretPath(id));
}

export function loadRawSecret(id: string): string | undefined {
  try {
    return decryptString(fs.readFileSync(secretPath(id)));
  } catch (error) {
    console.warn('[secrets] failed to decrypt raw secret', {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function deleteRawSecret(id: string): void {
  try {
    fs.unlinkSync(secretPath(id));
    notifyWrite(id);
  } catch {
    /* already gone */
  }
}
