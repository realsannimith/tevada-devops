/**
 * Live log follow (main process).
 *
 * Turns a `LogStreamSource` from the renderer into exactly one safe remote
 * command, then hands it to ConnectionManager.openLogStream, which owns the
 * SSH channel and pushes chunks back as `logs:data` events.
 *
 * Everything the renderer sends is untrusted, and these strings are executed by
 * a remote shell — so a source that does not validate produces no command at
 * all. We never quote-and-hope: the log path and the unit/container name are
 * matched against a strict allowlist first, and only then interpolated.
 */
import { ConnectionManager } from './connection-manager';
import type {
  ArtifactRuntime,
  LogStreamOpenResult,
  LogStreamRequest,
  LogStreamSource,
} from '../shared/ipc-types';

/** History replayed before following. Enough to see a whole build, small
 *  enough that opening a panel on a months-old log is not a hang. */
export const DEFAULT_TAIL_LINES = 500;
export const MAX_TAIL_LINES = 5_000;

/** Absolute path, safe charset, no traversal — the only shape the deploy skill
 *  ever writes. Mirrors deployments.ts's SAFE_REMOTE_PATH. */
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** Docker container name, or a systemd unit without the .service suffix.
 *  Mirrors artifacts.ts's isSafeUnitName. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/;

export function isSafeLogPath(p: string): boolean {
  return SAFE_REMOTE_PATH.test(p) && !p.includes('..');
}

export function isSafeName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && SAFE_NAME.test(name);
}

function clampTail(tail: number | undefined): number {
  if (!Number.isFinite(tail) || tail === undefined) return DEFAULT_TAIL_LINES;
  return Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(tail)));
}

/**
 * The remote command for a source, or null if the source fails validation.
 *
 * `tail -n N -f` gives history and follow in one primitive — no "read the file,
 * then watch it" race. `--retry` keeps the follow alive across the log being
 * rotated or recreated, which is exactly what a deploy script does on each run:
 * without it, the panel goes silent the moment a new build starts.
 */
export function buildFollowCommand(
  source: LogStreamSource,
  tail?: number,
): string | null {
  const n = clampTail(tail);

  if (source.kind === 'deploy') {
    if (!isSafeLogPath(source.logPath)) return null;
    // 2>/dev/null: a not-yet-created log should show as empty and then start
    // streaming once the build makes it, not as a "No such file" error line.
    return `tail -n ${n} -F '${source.logPath}' 2>/dev/null`;
  }

  if (!isSafeName(source.name)) return null;
  if (source.runtime === 'container') {
    // --timestamps so the renderer can show per-line times; docker interleaves
    // stdout/stderr, and 2>&1 folds the container's stderr into our stream.
    return `docker logs --timestamps --tail ${n} --follow '${source.name}' 2>&1`;
  }
  // systemd. `sudo -n` is not used here: journalctl for a user-visible unit
  // generally works unprivileged, and a password prompt would hang the stream.
  return `journalctl -u '${source.name}' -n ${n} --follow --no-pager 2>&1`;
}

/** Human-readable version of what we're running, shown under the panel title. */
export function describeSource(source: LogStreamSource): string {
  if (source.kind === 'deploy') return source.logPath;
  return source.runtime === 'container'
    ? `docker logs ${source.name}`
    : `journalctl -u ${source.name}`;
}

let streamCounter = 0;

export async function startLogStream(
  cm: ConnectionManager,
  req: LogStreamRequest,
): Promise<LogStreamOpenResult> {
  const command = buildFollowCommand(req.source, req.tail);
  if (!command) {
    return { ok: false, error: 'Invalid log source.' };
  }
  const streamId = `log_${Date.now()}_${streamCounter++}`;
  try {
    await cm.openLogStream(req.serverId, streamId, command);
    return { ok: true, streamId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type { ArtifactRuntime };
