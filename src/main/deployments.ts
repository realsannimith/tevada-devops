/**
 * GitHub auto-deploy support: the server-side notification helper and the
 * readers behind the Deploys tab.
 *
 * The contract with the github-auto-deploy skill:
 *  - /usr/local/bin/easyhost-notify  — installed HERE (never by the agent).
 *    The redeploy script calls it on every transition; it appends a JSON line
 *    to /var/log/easyhost/deploy-events.jsonl and, when
 *    /etc/easyhost/telegram.env exists, mirrors ok/failed/rollback/test to
 *    Telegram. It must never fail the calling deploy script.
 *  - /etc/easyhost/telegram.env — bot token + chat id, root-only (600). It is
 *    provisioned straight from the app's encrypted secret store over SFTP so
 *    the token never enters the agent's LLM context or the renderer. Putting
 *    it on the server is what lets deploy notifications fire even while this
 *    app is closed (the deploy runs from cron, not from us).
 *  - /etc/easyhost/deploys/<app>.json — one registry file per automated
 *    deployment, written by the agent (no secrets in it).
 *
 * Reads are one combined exec (same single-round-trip pattern as artifacts.ts)
 * plus pure, unit-testable parsers.
 */
import { ConnectionManager } from './connection-manager';
import {
  DeployEvent,
  DeployLogResult,
  DeploymentInfo,
  DeploymentsResult,
  EnvFileReadResult,
  OkResult,
} from '../shared/ipc-types';

export const NOTIFY_HELPER_PATH = '/usr/local/bin/easyhost-notify';
export const TELEGRAM_ENV_PATH = '/etc/easyhost/telegram.env';
export const DEPLOYS_REGISTRY_DIR = '/etc/easyhost/deploys';
export const DEPLOY_EVENTS_PATH = '/var/log/easyhost/deploy-events.jsonl';

/** How many recent event lines to pull per listing (covers weeks of deploys). */
const EVENTS_TAIL_LINES = 400;
/** Events kept per app in the response — the UI shows a short history. */
const EVENTS_PER_APP = 30;
const LOG_TAIL_LINES = 200;

// ---------------------------------------------------------------------------
// The helper script installed on servers
// ---------------------------------------------------------------------------

/**
 * `easyhost-notify <app> <status> <message>`. Statuses are an open set; only
 * ok/failed/rollback/error/test are mirrored to Telegram (start would double
 * the noise of every successful deploy). Written for busybox-ish portability:
 * no bashisms beyond what the deploy scripts already assume.
 */
export const NOTIFY_HELPER_SCRIPT = `#!/bin/bash
# Installed by Tevada DevOps — deploy event recorder + Telegram notifier.
# Usage: easyhost-notify <app> <status> <message>
# Appends events to ${DEPLOY_EVENTS_PATH} (shown in the app's
# Deploys tab) and mirrors ok/failed/rollback/error/test to Telegram when
# ${TELEGRAM_ENV_PATH} is configured. Always exits 0: a lost
# notification must never break a deploy.
APP="\${1:-unknown}"; STATUS="\${2:-info}"; MSG="\${3:-}"
umask 022
mkdir -p /var/log/easyhost 2>/dev/null || true
TS=$(date -Is)
esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' | tr -d '\\n\\r' | tr '\\t' ' '; }
printf '{"ts":"%s","app":"%s","status":"%s","message":"%s"}\\n' \\
  "$TS" "$(esc "$APP")" "$(esc "$STATUS")" "$(esc "$MSG")" \\
  >> ${DEPLOY_EVENTS_PATH} 2>/dev/null || true

case "$STATUS" in ok|failed|rollback|error|test) ;; *) exit 0 ;; esac
[ -f ${TELEGRAM_ENV_PATH} ] || exit 0
. ${TELEGRAM_ENV_PATH} 2>/dev/null || exit 0
[ -n "\${EASYHOST_TG_TOKEN:-}" ] && [ -n "\${EASYHOST_TG_CHAT_ID:-}" ] || exit 0

case "$STATUS" in
  ok)       ICON="✅"; TITLE="Deploy succeeded" ;;
  failed)   ICON="🔴"; TITLE="Deploy failed" ;;
  rollback) ICON="↩️"; TITLE="Rolled back" ;;
  test)     ICON="🔔"; TITLE="Deploy notifications enabled" ;;
  *)        ICON="⚠️"; TITLE="Deploy $STATUS" ;;
esac
hesc() { printf '%s' "$1" | sed -e 's/&/\\&amp;/g' -e 's/</\\&lt;/g' -e 's/>/\\&gt;/g'; }
# Same 3-line shape as the app's monitoring alerts (title / subject · detail /
# muted footer). WHEN is the server's local time, human-readable — the JSONL
# above keeps the ISO stamp the app parses.
WHEN=$(date '+%b %-d, %-I:%M %p' 2>/dev/null || date)
BODY="<b>$(hesc "$APP")</b>"
[ -n "$MSG" ] && BODY="$BODY · $(hesc "$MSG")"
TEXT="$ICON <b>$TITLE</b>
$BODY
<i>$(hostname) · $WHEN</i>"
curl -fsS --max-time 10 "https://api.telegram.org/bot\${EASYHOST_TG_TOKEN}/sendMessage" \\
  -d chat_id="\${EASYHOST_TG_CHAT_ID}" \\
  --data-urlencode text="$TEXT" \\
  -d parse_mode=HTML -d disable_web_page_preview=true >/dev/null 2>&1 || true
exit 0
`;

export type ProvisionResult = {
  ok: boolean;
  /** True when the Telegram env file is in place on the server. */
  telegramConfigured: boolean;
  error?: string;
};

/**
 * Install/refresh the notify helper on a server, and provision the Telegram
 * env file when the app has a bot token + chat configured. Safe to re-run —
 * both writes are overwrites. Called by the agent's setupDeployNotifications
 * tool; the telegram material comes from main's secret store, not the model.
 */
export async function provisionDeployNotifications(
  cm: ConnectionManager,
  serverId: string,
  telegram: { token: string; chatId: string } | undefined,
): Promise<ProvisionResult> {
  try {
    const tmp = `/tmp/easyhost-notify-${Date.now()}`;
    await cm.sftpWriteFile(serverId, tmp, NOTIFY_HELPER_SCRIPT);
    const install = await cm.exec(
      serverId,
      `sudo mkdir -p ${DEPLOYS_REGISTRY_DIR} /var/log/easyhost` +
        ` && sudo mv ${tmp} ${NOTIFY_HELPER_PATH}` +
        ` && sudo chmod 755 ${NOTIFY_HELPER_PATH}`,
      { timeoutMs: 30_000 },
    );
    if (install.exitCode !== 0) {
      return {
        ok: false,
        telegramConfigured: false,
        error:
          install.stderr.trim() ||
          'Installing the notify helper failed (is sudo available?).',
      };
    }

    if (!telegram) return { ok: true, telegramConfigured: false };

    const envTmp = `/tmp/easyhost-tg-${Date.now()}`;
    await cm.sftpWriteFile(
      serverId,
      envTmp,
      `EASYHOST_TG_TOKEN=${telegram.token}\nEASYHOST_TG_CHAT_ID=${telegram.chatId}\n`,
    );
    const env = await cm.exec(
      serverId,
      `sudo mv ${envTmp} ${TELEGRAM_ENV_PATH}` +
        ` && sudo chown root:root ${TELEGRAM_ENV_PATH}` +
        ` && sudo chmod 600 ${TELEGRAM_ENV_PATH}`,
      { timeoutMs: 30_000 },
    );
    if (env.exitCode !== 0) {
      return {
        ok: true,
        telegramConfigured: false,
        error: `Helper installed, but writing the Telegram config failed: ${env.stderr.trim()}`,
      };
    }
    return { ok: true, telegramConfigured: true };
  } catch (err) {
    return {
      ok: false,
      telegramConfigured: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Pure parsers (unit-testable)
// ---------------------------------------------------------------------------

const SEP = '===EH-DEP===';
const FILE_MARK = '@@FILE ';

/** Parse the registry section: "@@FILE <path>" markers followed by the file's
 *  JSON (possibly pretty-printed — the whole chunk is parsed at once). */
export function parseRegistry(block: string): DeploymentInfo[] {
  const out: DeploymentInfo[] = [];
  const chunks = block.split(FILE_MARK).slice(1); // before the first marker: noise
  for (const chunk of chunks) {
    const nl = chunk.indexOf('\n');
    if (nl < 0) continue;
    const body = chunk.slice(nl + 1).trim();
    if (!body) continue;
    try {
      const raw = JSON.parse(body) as Record<string, unknown>;
      if (typeof raw.app !== 'string' || !raw.app) continue;
      const createdAt =
        typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : NaN;
      out.push({
        app: raw.app,
        repo: typeof raw.repo === 'string' ? raw.repo : undefined,
        branch: typeof raw.branch === 'string' ? raw.branch : undefined,
        dir: typeof raw.dir === 'string' ? raw.dir : undefined,
        port: typeof raw.port === 'number' ? raw.port : undefined,
        script: typeof raw.script === 'string' ? raw.script : undefined,
        log: typeof raw.log === 'string' ? raw.log : undefined,
        envFile: typeof raw.envFile === 'string' ? raw.envFile : undefined,
        createdAt: Number.isFinite(createdAt) ? createdAt : undefined,
        events: [],
      });
    } catch {
      // Malformed registry file — skip it rather than failing the listing.
    }
  }
  return out;
}

/** Parse deploy-events.jsonl lines (newest last on disk → newest FIRST out). */
export function parseEvents(block: string): DeployEvent[] {
  const out: DeployEvent[] = [];
  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof raw.app !== 'string' || typeof raw.status !== 'string') continue;
      const ts = typeof raw.ts === 'string' ? Date.parse(raw.ts) : NaN;
      out.push({
        ts: Number.isFinite(ts) ? ts : 0,
        app: raw.app,
        status: raw.status,
        message: typeof raw.message === 'string' ? raw.message : '',
      });
    } catch {
      // A torn/corrupt line (e.g. concurrent append) — skip it.
    }
  }
  return out.reverse();
}

/**
 * Join registry entries with their events. Apps that only appear in the
 * events file (registry file deleted by hand) still get a synthesized row so
 * their history isn't invisible.
 */
export function assembleDeployments(
  registry: DeploymentInfo[],
  events: DeployEvent[],
): DeploymentInfo[] {
  const byApp = new Map<string, DeploymentInfo>();
  for (const d of registry) byApp.set(d.app, d);
  for (const e of events) {
    let d = byApp.get(e.app);
    if (!d) {
      d = { app: e.app, events: [] };
      byApp.set(e.app, d);
    }
    if (d.events.length < EVENTS_PER_APP) d.events.push(e);
    if (!d.lastEvent) d.lastEvent = e;
  }
  // Most recently active first; registered-but-never-deployed apps last.
  return [...byApp.values()].sort(
    (a, b) => (b.lastEvent?.ts ?? b.createdAt ?? 0) - (a.lastEvent?.ts ?? a.createdAt ?? 0),
  );
}

// ---------------------------------------------------------------------------
// SSH readers
// ---------------------------------------------------------------------------

const LIST_PROBE = [
  `for f in ${DEPLOYS_REGISTRY_DIR}/*.json; do [ -f "$f" ] && { echo "${FILE_MARK.trim()} $f"; cat "$f"; echo; }; done 2>/dev/null`,
  `echo ${SEP}`,
  `tail -n ${EVENTS_TAIL_LINES} ${DEPLOY_EVENTS_PATH} 2>/dev/null`,
].join('; ');

export async function listDeployments(
  cm: ConnectionManager,
  serverId: string,
): Promise<DeploymentsResult> {
  try {
    const res = await cm.exec(serverId, LIST_PROBE, {
      timeoutMs: 20_000,
      maxOutputBytes: 512 * 1024,
    });
    const [registryBlock = '', eventsBlock = ''] = res.stdout.split(SEP);
    return {
      ok: true,
      ts: Date.now(),
      deployments: assembleDeployments(
        parseRegistry(registryBlock),
        parseEvents(eventsBlock),
      ),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Absolute path, safe charset, no traversal — the only shape we ever wrote. */
const SAFE_REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;

function isSafeRemotePath(p: string): boolean {
  return SAFE_REMOTE_PATH.test(p) && !p.includes('..');
}

export async function readDeployLog(
  cm: ConnectionManager,
  serverId: string,
  logPath: string,
): Promise<DeployLogResult> {
  if (!isSafeRemotePath(logPath)) {
    return { ok: false, error: 'Invalid log path.' };
  }
  try {
    const res = await cm.exec(
      serverId,
      `tail -n ${LOG_TAIL_LINES} '${logPath}' 2>/dev/null || sudo -n tail -n ${LOG_TAIL_LINES} '${logPath}' 2>/dev/null`,
      { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 },
    );
    if (res.exitCode !== 0 && !res.stdout.trim()) {
      return { ok: false, error: 'Could not read the log (no file yet, or no permission).' };
    }
    return { ok: true, content: res.stdout };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Env file editing (the Deploys tab's "Environment" section)
// ---------------------------------------------------------------------------

/**
 * Read a project's env file. The file is root-owned 600 by convention
 * (docker-deploy writes it that way), so a plain cat is tried first and
 * passwordless sudo second. A missing file is NOT an error — the editor
 * offers to create it on save.
 */
export async function readEnvFile(
  cm: ConnectionManager,
  serverId: string,
  envPath: string,
): Promise<EnvFileReadResult> {
  if (!isSafeRemotePath(envPath)) return { ok: false, error: 'Invalid env file path.' };
  try {
    const exists = await cm.exec(
      serverId,
      `test -e '${envPath}' || sudo -n test -e '${envPath}'`,
      { timeoutMs: 15_000 },
    );
    if (exists.exitCode !== 0) return { ok: true, exists: false, content: '' };
    const res = await cm.exec(
      serverId,
      `cat '${envPath}' 2>/dev/null || sudo -n cat '${envPath}' 2>/dev/null`,
      { timeoutMs: 15_000, maxOutputBytes: 128 * 1024 },
    );
    if (res.exitCode !== 0) {
      return { ok: false, error: 'The env file exists but could not be read (permissions).' };
    }
    return { ok: true, exists: true, content: res.stdout };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Write a project's env file (staged over SFTP, moved with sudo, kept 600). */
export async function writeEnvFile(
  cm: ConnectionManager,
  serverId: string,
  envPath: string,
  content: string,
): Promise<OkResult> {
  if (!isSafeRemotePath(envPath)) return { ok: false, error: 'Invalid env file path.' };
  try {
    const tmp = `/tmp/easyhost-env-${Date.now()}`;
    await cm.sftpWriteFile(serverId, tmp, content);
    const res = await cm.exec(
      serverId,
      `sudo mv ${tmp} '${envPath}' && sudo chown root:root '${envPath}' && sudo chmod 600 '${envPath}'`,
      { timeoutMs: 30_000 },
    );
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.trim() || 'Writing the env file failed.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Redeploy scripts registered by the skill live here and only here. */
const SAFE_DEPLOY_SCRIPT = /^\/usr\/local\/bin\/[A-Za-z0-9._-]+-deploy\.sh$/;

/**
 * Kick the app's own redeploy script with --force (skip the "already up to
 * date" early-exit) so env changes apply through the exact same
 * build → health-check → rollback path as a push. Detached with nohup:
 * builds can take minutes and execs are serialized per server, so holding the
 * channel would starve monitoring. Progress is visible where deploys always
 * are — the events feed and the deploy log. The script's flock makes an
 * overlap with the cron tick harmless.
 */
export async function forceRedeploy(
  cm: ConnectionManager,
  serverId: string,
  scriptPath: string,
): Promise<OkResult> {
  if (!SAFE_DEPLOY_SCRIPT.test(scriptPath)) {
    return { ok: false, error: 'Invalid deploy script path.' };
  }
  try {
    const res = await cm.exec(
      serverId,
      `sudo test -x '${scriptPath}' && sudo sh -c 'nohup ${scriptPath} --force >/dev/null 2>&1 &'`,
      { timeoutMs: 20_000 },
    );
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr.trim() || 'Could not start the redeploy script.',
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
