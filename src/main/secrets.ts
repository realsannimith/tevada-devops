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

function secretsDir(): string {
  const dir = path.join(app.getPath('userData'), 'secrets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function secretPath(serverId: string): string {
  return path.join(secretsDir(), `${serverId}.bin`);
}

/** True when the OS provides a real encryption backend (keychain/keyring). */
export function secretsAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function saveSecret(serverId: string, secret: ServerSecret): void {
  if (!secretsAvailable()) {
    throw new Error(
      'OS secure storage is unavailable — cannot store credentials safely. ' +
        'On Linux, ensure a keyring (gnome-keyring / kwallet) is running.',
    );
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(secret));
  const tmp = `${secretPath(serverId)}.tmp`;
  fs.writeFileSync(tmp, encrypted);
  fs.renameSync(tmp, secretPath(serverId));
}

export function loadSecret(serverId: string): ServerSecret | undefined {
  try {
    const buf = fs.readFileSync(secretPath(serverId));
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json) as ServerSecret;
  } catch {
    return undefined;
  }
}

export function deleteSecret(serverId: string): void {
  try {
    fs.unlinkSync(secretPath(serverId));
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
  const encrypted = safeStorage.encryptString(value);
  const tmp = `${secretPath(id)}.tmp`;
  fs.writeFileSync(tmp, encrypted);
  fs.renameSync(tmp, secretPath(id));
}

export function loadRawSecret(id: string): string | undefined {
  try {
    return safeStorage.decryptString(fs.readFileSync(secretPath(id)));
  } catch {
    return undefined;
  }
}

export function deleteRawSecret(id: string): void {
  try {
    fs.unlinkSync(secretPath(id));
  } catch {
    /* already gone */
  }
}
