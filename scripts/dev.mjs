#!/usr/bin/env node
/**
 * Dev launcher with optional isolated runtime home (same pattern as FCode's
 * `electron:dev --home-dir ./.fcode/electron-dev`).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const homeArgIndex = process.argv.indexOf('--home-dir');
const homeDir = homeArgIndex >= 0 ? process.argv[homeArgIndex + 1] : undefined;

const env = { ...process.env };
if (homeDir) {
  env.EASYHOST_HOME = path.resolve(rootDir, homeDir);
}

const child = spawn('electron-forge', ['start'], {
  cwd: rootDir,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error('[easy-host-dev] Failed to start electron-forge', error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
