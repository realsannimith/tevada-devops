import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userDataDir = path.join(os.tmpdir(), 'easyhost-knownhosts-test');

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'easyhost-knownhosts-test') },
}));

import { verifyAndPin, forgetHost, fingerprint } from './knownHosts';

const KEY_A = Buffer.from('ssh-ed25519 AAAA-server-A');
const KEY_B = Buffer.from('ssh-ed25519 AAAA-server-B');

beforeEach(() => fs.rmSync(userDataDir, { recursive: true, force: true }));
afterEach(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

describe('knownHosts host-key pinning (TOFU)', () => {
  it('trusts and pins a key on first connect', () => {
    expect(verifyAndPin('10.0.0.1', 22, KEY_A)).toBe('trusted-new');
  });

  it('trusts the same key on subsequent connects', () => {
    verifyAndPin('10.0.0.1', 22, KEY_A);
    expect(verifyAndPin('10.0.0.1', 22, KEY_A)).toBe('trusted-existing');
  });

  it('flags a changed key as a mismatch (possible MITM / rebuild)', () => {
    verifyAndPin('10.0.0.1', 22, KEY_A);
    expect(verifyAndPin('10.0.0.1', 22, KEY_B)).toBe('mismatch');
  });

  it('scopes pins by host and port', () => {
    verifyAndPin('10.0.0.1', 22, KEY_A);
    // Same key material but a different port is a different host entry.
    expect(verifyAndPin('10.0.0.1', 2222, KEY_A)).toBe('trusted-new');
    expect(verifyAndPin('10.0.0.2', 22, KEY_A)).toBe('trusted-new');
  });

  it('re-trusts a new key after the host is forgotten', () => {
    verifyAndPin('10.0.0.1', 22, KEY_A);
    forgetHost('10.0.0.1', 22);
    expect(verifyAndPin('10.0.0.1', 22, KEY_B)).toBe('trusted-new');
  });

  it('produces a stable fingerprint for the same key', () => {
    expect(fingerprint(KEY_A)).toBe(fingerprint(KEY_A));
    expect(fingerprint(KEY_A)).not.toBe(fingerprint(KEY_B));
  });
});
