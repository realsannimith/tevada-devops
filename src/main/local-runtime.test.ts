import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localExec, localReadFile, localWriteFile } from './local-runtime';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'easyhost-local-'));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('localExec', () => {
  it('runs a command and returns stdout + exit code', async () => {
    const res = await localExec('echo hello && exit 3');
    expect(res.stdout.trim()).toBe('hello');
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  it('captures stderr', async () => {
    const res = await localExec('echo oops 1>&2');
    expect(res.stderr.trim()).toBe('oops');
    expect(res.exitCode).toBe(0);
  });

  it('caps output and flags truncation', async () => {
    const res = await localExec('yes x | head -c 100000', {
      maxOutputBytes: 1024,
    });
    expect(res.stdout.length).toBeLessThanOrEqual(1024);
    expect(res.truncated).toBe(true);
  });

  it('kills on timeout and flags it', async () => {
    const res = await localExec('sleep 5', { timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
  }, 10_000);
});

describe('local file io', () => {
  it('writes (creating parents) and reads back', async () => {
    const file = path.join(tmpDir, 'nested', 'dir', 'note.txt');
    await localWriteFile(file, 'local content');
    const read = await localReadFile(file);
    expect(read.content).toBe('local content');
    expect(read.truncated).toBe(false);
  });

  it('flags truncation on large reads', async () => {
    const file = path.join(tmpDir, 'big.txt');
    await localWriteFile(file, 'a'.repeat(5000));
    const read = await localReadFile(file, 1000);
    expect(read.content.length).toBe(1000);
    expect(read.truncated).toBe(true);
  });
});
