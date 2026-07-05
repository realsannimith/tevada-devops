/**
 * Env-file (.env) parsing + editing for the Deploys tab's Environment editor.
 *
 * Values are treated as OPAQUE raw text after the first `=` — no quote
 * stripping, no unescaping. Docker's --env-file passes lines verbatim (quotes
 * become part of the value there), while dotenv libraries strip them; the only
 * behavior that is correct for both is to show and write back exactly what is
 * in the file. Comments, blank lines and unrecognized lines are preserved
 * by applyEnvEdits so a hand-written file survives an in-app edit.
 */

export type EnvEntry = { key: string; value: string };

/** KEY=VALUE with optional `export ` prefix; key charset per POSIX. */
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

/** Unique keys in first-seen order; on duplicate keys the LAST value wins
 *  (what docker --env-file and most dotenv loaders effectively do). */
export function parseEnvFile(content: string): EnvEntry[] {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const m = ENV_LINE.exec(line);
    if (!m) continue;
    if (!values.has(m[1])) order.push(m[1]);
    values.set(m[1], m[2]);
  }
  return order.map((key) => ({ key, value: values.get(key) ?? '' }));
}

/**
 * Rebuild the file with `entries` as the complete new variable set:
 *  - a line whose key is still present is rewritten in place (first
 *    occurrence; later duplicates of the same key are dropped),
 *  - lines whose keys were removed are dropped,
 *  - brand-new keys are appended at the end,
 *  - everything that is not a KEY=VALUE line is kept verbatim.
 */
export function applyEnvEdits(original: string, entries: EnvEntry[]): string {
  const wanted = new Map(entries.map((e) => [e.key, e.value]));
  const written = new Set<string>();
  const out: string[] = [];

  // Trailing newline handling: split/join round-trips everything else.
  for (const line of original.split('\n')) {
    const m = ENV_LINE.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[1];
    if (!wanted.has(key) || written.has(key)) continue; // removed or duplicate
    out.push(`${key}=${wanted.get(key)}`);
    written.add(key);
  }

  // Drop trailing empty lines so appends don't leave gaps, then append news.
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const e of entries) {
    if (!written.has(e.key)) out.push(`${e.key}=${e.value}`);
  }
  return out.join('\n') + '\n';
}

/** A key the editor will accept (matches what the parser can read back). */
export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
