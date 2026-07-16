/**
 * Log line parsing for the live log panel.
 *
 * A follow stream arrives as raw byte chunks that split at arbitrary points —
 * frequently mid-line. Everything here works on whole lines, so the caller is
 * responsible for holding back a trailing partial line until its newline shows
 * up (see LogStreamPanel's `carry`).
 *
 * `docker logs --timestamps` prefixes each line with an RFC3339 timestamp;
 * `tail -f` on a build log does not. Both go through the same parser, which is
 * why the timestamp is optional.
 */
import { FancyAnsi } from 'fancy-ansi';

/** One converter, module-level: it compiles its escape-sequence tables once. */
const ansi = new FancyAnsi();

export type LogLevel = 'error' | 'warning' | 'success' | 'debug' | 'info';

export type LogLine = {
  /** Monotonic id — line content repeats, so it can't be the React key. */
  id: number;
  /** The timestamp as it appeared, if the source emitted one. */
  rawTimestamp: string | null;
  timestamp: Date | null;
  /** The line with any leading timestamp stripped. Still contains ANSI codes. */
  message: string;
  level: LogLevel;
};

/** Leading RFC3339 (docker) or "YYYY-MM-DD HH:mm:ss(.SSS) UTC" (journald-ish). */
const TIMESTAMP_RE =
  /^(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? UTC)\s+(?<message>[\s\S]*)$/;

/** ANSI SGR/CSI codes, so level detection sees the text and not the colour. */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * Classify a line for the level badge and row tint. Pure content sniffing —
 * build tools have no structured level field, so this is a heuristic and is
 * allowed to be wrong; it colours the log, it never gates behaviour.
 *
 * Order matters and is first-match-wins: an explicit `[error]`-style tag beats
 * a stray "failed" inside a success line, and the ✅/❌ markers our deploy
 * scripts print are checked before the generic word matches.
 */
export function getLogLevel(rawMessage: string): LogLevel {
  const message = stripAnsi(rawMessage);

  // An HTTP status code is the most reliable signal there is — trust it first.
  const status = message.match(/\bstatus(?:Code)?["']?\s*[:=]\s*["']?(\d{3})\b/i);
  if (status) {
    const code = Number(status[1]);
    if (code >= 500) return 'error';
    if (code >= 400) return 'warning';
    if (code >= 200 && code < 300) return 'success';
    return 'info';
  }

  const m = message.toLowerCase();

  // Explicit markers our own deploy scripts emit.
  if (/[✅✓]|\bdeploy(ed|ment)? (succeeded|complete)/.test(message)) return 'success';
  if (/[❌✗]/.test(message)) return 'error';
  if (/[⚠]/.test(message)) return 'warning';

  // Explicit level tags: [error], ERROR:, error -
  if (/\[(error|err|fatal|crit(ical)?)\]|(^|\s)(error|fatal)s?\s*[:\-—]/.test(m))
    return 'error';
  if (/\[(warn|warning)\]|(^|\s)warn(ing)?s?\s*[:\-—]/.test(m)) return 'warning';
  if (/\[(debug|trace)\]|(^|\s)debug\s*[:\-—]/.test(m)) return 'debug';
  if (/\[(info|log)\]|(^|\s)info(rmation)?\s*[:\-—]/.test(m)) return 'info';

  // Unprefixed content. Errors before warnings before successes, because a
  // failure line often also contains the word it was trying to succeed at.
  if (
    /\b(exception|traceback|segfault|panic|fatal|failed|failure|cannot|could not|unable to|refused|denied|not found|no such file)\b/.test(
      m,
    ) ||
    /^\s*at\s+[\w.$]+\s*\(.+:\d+:\d+\)/.test(message) // JS stack frame
  )
    return 'error';
  if (/\b(warn(ing)?|deprecated|obsolete|retrying|skipped)\b/.test(m))
    return 'warning';
  if (
    /\b(success(ful(ly)?)?|completed|complete|done|ready|healthy|passed|up to date)\b/.test(
      m,
    ) ||
    /\b(listening|running|serving)\s+(on|at)\b/.test(m)
  )
    return 'success';

  return 'info';
}

let lineCounter = 0;

/** Parse whole lines into structured rows. Blank lines are dropped. */
export function parseLogLines(lines: string[]): LogLine[] {
  const out: LogLine[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.trim()) continue;

    const match = trimmed.match(TIMESTAMP_RE);
    const rawTimestamp = match?.groups?.timestamp ?? null;
    const message = (match?.groups?.message ?? trimmed).trimEnd();
    if (!message.trim()) continue;

    let timestamp: Date | null = null;
    if (rawTimestamp) {
      const d = new Date(rawTimestamp.replace(' UTC', 'Z'));
      timestamp = Number.isNaN(d.getTime()) ? null : d;
    }

    out.push({
      id: lineCounter++,
      rawTimestamp,
      timestamp,
      message,
      level: getLogLevel(message),
    });
  }
  return out;
}

/**
 * Reassemble whole lines from a stream of arbitrarily-split chunks.
 *
 * A chunk boundary is not a line boundary: `tail -f` can hand us "Step 3/8 : RU"
 * and "N npm ci\n" as two chunks. Feeding those to the parser directly would
 * render two corrupt lines, so the trailing fragment is held back until its
 * newline arrives.
 */
export function createLineAssembler() {
  let carry = '';
  return {
    /** Consume a chunk, returning only the lines that are now complete. */
    push(chunk: string): LogLine[] {
      const parts = (carry + chunk).split('\n');
      // The final element has no newline after it yet — it may be a partial
      // line, or '' when the chunk ended exactly on a newline. Either way it
      // is not complete, so it carries over.
      carry = parts.pop() ?? '';
      return parseLogLines(parts);
    },
    /** Emit any held-back fragment. Call when the stream ends — the last line
     *  of a log often has no trailing newline. */
    flush(): LogLine[] {
      const rest = carry;
      carry = '';
      return rest.trim() ? parseLogLines([rest]) : [];
    },
  };
}

/** ANSI colour codes → HTML. The payload is escaped by fancy-ansi. */
export function ansiToHtml(message: string): string {
  return ansi.toHtml(message);
}

/** Plain text for the download / copy actions — no ANSI, no markup. */
export function logLinesToText(lines: LogLine[]): string {
  return lines
    .map((l) =>
      l.rawTimestamp
        ? `${l.rawTimestamp} ${stripAnsi(l.message)}`
        : stripAnsi(l.message),
    )
    .join('\n');
}
