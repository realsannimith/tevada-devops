/**
 * SSH host-key pinning (trust-on-first-use). ssh2 does NOT verify a server's
 * host key unless we supply a hostVerifier — without one the app would send the
 * user's SSH password / key auth to any machine answering on the address, with
 * no MITM detection. This module records the fingerprint of each host's key on
 * the first successful connection and rejects a later connection whose key has
 * changed (the classic "REMOTE HOST IDENTIFICATION HAS CHANGED" case).
 *
 * Stored as `<userData>/known-hosts.json`: { "host:port": "<sha256-b64>" }.
 * Fingerprints are not secret, so this is plain JSON (not safeStorage).
 */
import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type HostKeyResult = 'trusted-existing' | 'trusted-new' | 'mismatch';

function filePath(): string {
  return path.join(app.getPath('userData'), 'known-hosts.json');
}

function load(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function save(map: Record<string, string>): void {
  const target = filePath();
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function hostId(host: string, port: number): string {
  return `${host}:${port}`;
}

export function fingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64');
}

/**
 * Verify a presented host key against the pinned one, pinning it on first sight.
 * - No record yet → pin it and trust (TOFU).
 * - Matches the pinned fingerprint → trust.
 * - Differs → mismatch (caller must reject the connection).
 */
export function verifyAndPin(
  host: string,
  port: number,
  key: Buffer,
): HostKeyResult {
  const map = load();
  const id = hostId(host, port);
  const fp = fingerprint(key);
  const known = map[id];
  if (!known) {
    map[id] = fp;
    save(map);
    return 'trusted-new';
  }
  return known === fp ? 'trusted-existing' : 'mismatch';
}

/** Drop a pinned key (e.g. the server was deleted, or deliberately rebuilt so
 *  the user wants to re-trust the new key on the next connect). */
export function forgetHost(host: string, port: number): void {
  const map = load();
  if (map[hostId(host, port)] !== undefined) {
    delete map[hostId(host, port)];
    save(map);
  }
}
