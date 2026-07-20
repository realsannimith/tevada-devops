/**
 * Local agent runtime — the "This Mac" target. Implements the same three
 * operations the agent tools use on remote servers (exec, write file, read
 * file), but against the user's own machine via child_process + fs. Gated by
 * the `agentLocalEnabled` setting; the same command blacklist and approval
 * flow apply as for remote targets (tools.ts checks them before calling here).
 *
 * Semantics mirror ConnectionManager: exec resolves (never rejects) with
 * {stdout, stderr, exitCode, truncated, timedOut}, output is capped, and the
 * abort signal kills the process tree.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ExecResult } from '../shared/ipc-types';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 16 * 1024;

export type LocalExecOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

/** Run a shell command locally, from the user's home directory. */
export function localExec(
  command: string,
  opts: LocalExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn('/bin/bash', ['-lc', command], {
      cwd: os.homedir(),
      env: process.env,
      // Own process group so a timeout/abort can kill the whole tree, not just
      // the shell (matches closing the SSH channel remotely).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode, truncated, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const onAbort = () => killTree();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (target: 'out' | 'err') => (chunk: Buffer) => {
      const current = target === 'out' ? stdout : stderr;
      if (current.length >= maxOut) {
        truncated = true;
        return;
      }
      const next = current + chunk.toString('utf8');
      const capped = next.length > maxOut ? next.slice(0, maxOut) : next;
      if (next.length > maxOut) truncated = true;
      if (target === 'out') stdout = capped;
      else stderr = capped;
    };

    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.on('error', (err) => {
      stderr = stderr || err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Expand a leading ~ the way a shell would — the model often writes ~/paths. */
function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export async function localWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const abs = path.resolve(os.homedir(), expandHome(filePath));
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

export async function localReadFile(
  filePath: string,
  maxBytes = 64 * 1024,
): Promise<{ content: string; truncated: boolean }> {
  const abs = path.resolve(os.homedir(), expandHome(filePath));
  const buf = await readFile(abs);
  const truncated = buf.length > maxBytes;
  return {
    content: buf.subarray(0, maxBytes).toString('utf8'),
    truncated,
  };
}

/** The synthetic ServerWithStatus-shaped row for listServers / the UI. */
export function localServerEntry() {
  return {
    name: 'This Mac',
    host: 'localhost',
    username: os.userInfo().username,
    status: 'connected' as const,
  };
}
