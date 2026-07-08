/**
 * Minimal structured logger for the main process. In a packaged build there is
 * no attached terminal, so `console.*` output is invisible and a crash leaves
 * nothing to diagnose. This writes JSON lines to `<userData>/logs/main.log`
 * (rotated at ~5 MB, one prior file kept) and installs global handlers so an
 * uncaught exception / unhandled rejection is captured instead of vanishing.
 *
 * Dependency-free on purpose (no electron-log): one small file, no new supply
 * chain. Every log also tees to the console so `bun run dev` is unchanged.
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

let stream: fs.WriteStream | null = null;
let logFilePath = '';

function logsDir(): string {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rotateIfNeeded(file: string): void {
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      fs.renameSync(file, `${file}.1`); // keep exactly one prior log
    }
  } catch {
    /* no existing file — nothing to rotate */
  }
}

function ensureStream(): fs.WriteStream | null {
  if (stream) return stream;
  try {
    logFilePath = path.join(logsDir(), 'main.log');
    rotateIfNeeded(logFilePath);
    stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    return stream;
  } catch {
    return null; // logging must never throw into a caller
  }
}

type Level = 'info' | 'warn' | 'error';

function write(level: Level, msg: string, meta?: unknown): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (meta !== undefined) record.meta = meta;
  try {
    ensureStream()?.write(JSON.stringify(record) + '\n');
  } catch {
    /* ignore — never let logging break the app */
  }
  const tee = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  tee(`[${level}] ${msg}`, meta ?? '');
}

export const logger = {
  info: (msg: string, meta?: unknown) => write('info', msg, meta),
  warn: (msg: string, meta?: unknown) => write('warn', msg, meta),
  error: (msg: string, meta?: unknown) => write('error', msg, meta),
  /** Absolute path of the current log file (empty until the first write). */
  filePath: (): string => logFilePath,
};

/**
 * Capture otherwise-fatal errors to the log. Deliberately does NOT exit: for a
 * desktop app, tearing down the whole window on a stray rejection is worse UX
 * than logging it and staying up. The record is what makes a shipped-user crash
 * diagnosable at all.
 */
export function installCrashHandlers(): void {
  process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', {
      message: err?.message,
      stack: err?.stack,
    });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', {
      message: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });
}
