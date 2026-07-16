/**
 * Alert engine — the "only tell me when it matters" layer on top of the existing
 * SSH Monitor. Ported faithfully from Gatus's alert state machine
 * (watchdog/alerting.go): per (server, metric) it keeps consecutive-failure and
 * consecutive-success counters plus a `triggered` flag, so:
 *
 *   - A single spike never alerts — a rule must breach `failureThreshold` times
 *     in a row before firing.
 *   - Exactly one alert per incident (the `triggered` flag dedupes), with an
 *     optional reminder every `reminderMinutes` while it stays broken.
 *   - A "resolved" message is sent once the metric is healthy for
 *     `successThreshold` checks in a row (hysteresis prevents flapping).
 *
 * The engine runs its OWN evaluation loop (independent of the UI's monitor poll)
 * so every rule is checked deterministically each tick, exactly like Gatus
 * evaluating all conditions per health check. It also supervises the background
 * monitors: for each alert-enabled server it keeps a connection + poller alive
 * and retries connecting when a server is down — that reconnect attempt IS the
 * reachability health check.
 *
 * Everything here is main-process only. The bot token is loaded from secrets.ts
 * on demand and never leaves this process.
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import {
  AlertConfig,
  AlertEvent,
  AlertMetric,
  AlertsStatus,
  HttpCheckConfig,
  ServerAlertConfig,
  ServerStats,
  TelegramChatDetectResult,
  TelegramConnectResult,
  TelegramTestResult,
} from '../shared/ipc-types';
import * as store from './store';
import * as secrets from './secrets';
import { ConnectionManager } from './connection-manager';
import { Monitor } from './monitor';
import { escapeHtml, getMe, getUpdates, sendMessage } from './telegram';

const CHECK_INTERVAL_MS = 15_000;
const TOKEN_SECRET_ID = 'telegram-bot-token';
const HTTP_PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// HTTP uptime probes (the `http` / `tls` metrics)
// ---------------------------------------------------------------------------

export type HttpProbeResult = {
  up: boolean;
  status?: number;
  error?: string;
  /** Days until the TLS certificate expires (https URLs, successful probes). */
  certDaysLeft?: number;
};

/** Whole days from `now` until an RFC-ish date string; undefined if unparsable. */
export function daysUntil(dateStr: string, now = Date.now()): number | undefined {
  const t = new Date(dateStr).getTime();
  if (!Number.isFinite(t)) return undefined;
  return Math.floor((t - now) / 86_400_000);
}

/** "example.com" or "example.com/health" — the short name events carry. */
export function httpCheckLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname && u.pathname !== '/' ? `${u.host}${u.pathname}` : u.host;
  } catch {
    return url;
  }
}

/**
 * One GET probe. Healthy = the server answered with a status below 400
 * (redirects count as up — the site is serving). The body is never downloaded:
 * we resolve on the status line and destroy the request. On https the peer
 * certificate's remaining validity rides along for the TLS-expiry rule.
 */
export function probeHttp(
  url: string,
  timeoutMs = HTTP_PROBE_TIMEOUT_MS,
): Promise<HttpProbeResult> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ up: false, error: 'Invalid URL.' });
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      resolve({ up: false, error: 'Only http(s) URLs are supported.' });
      return;
    }
    let settled = false;
    const done = (result: HttpProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? httpsRequest : httpRequest)(
      u,
      {
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'user-agent': 'TevadaDevOps-uptime/1.0', accept: '*/*' },
      },
      (res) => {
        let certDaysLeft: number | undefined;
        if (isHttps) {
          const cert = (res.socket as TLSSocket).getPeerCertificate?.();
          if (cert && cert.valid_to) certDaysLeft = daysUntil(cert.valid_to);
        }
        const status = res.statusCode ?? 0;
        res.resume();
        done({ up: status > 0 && status < 400, status, certDaysLeft });
        req.destroy();
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No response within ${Math.round(timeoutMs / 1000)}s.`)));
    req.on('error', (err) => done({ up: false, error: err.message }));
    req.end();
  });
}

export type RuleState = {
  failures: number;
  successes: number;
  triggered: boolean;
  lastReminderAt: number;
  /** When the current incident first fired (ms epoch, 0 = never) — lets
   *  reminders say "firing for 30m" and resolves say "recovered after 12m". */
  firedAt: number;
};

export function freshRuleState(): RuleState {
  return {
    failures: 0,
    successes: 0,
    triggered: false,
    lastReminderAt: 0,
    firedAt: 0,
  };
}

/** What a single check advanced the rule to — the only actions that notify. */
export type RuleAction = 'none' | 'fire' | 'remind' | 'resolve';

export type RuleTuning = {
  failureThreshold: number;
  successThreshold: number;
  reminderMinutes: number;
};

/**
 * Pure Gatus-style transition for one rule check. This is the anti-noise core:
 * it decides — from the consecutive counters and the `triggered` flag — whether
 * a check should fire an initial alert, a reminder, a resolve, or stay silent.
 * Mutates and returns `state` (caller owns storage) plus the action taken.
 */
export function stepRule(
  state: RuleState,
  healthy: boolean,
  tuning: RuleTuning,
  now: number,
): RuleAction {
  if (healthy) {
    state.successes++;
    state.failures = 0;
    if (state.triggered && state.successes >= tuning.successThreshold) {
      state.triggered = false;
      return 'resolve';
    }
    return 'none';
  }
  state.failures++;
  state.successes = 0;
  if (state.failures < tuning.failureThreshold) return 'none';
  const sendInitial = !state.triggered;
  const sendReminder =
    state.triggered &&
    tuning.reminderMinutes > 0 &&
    now - state.lastReminderAt >= tuning.reminderMinutes * 60_000;
  if (!sendInitial && !sendReminder) return 'none';
  state.triggered = true;
  state.lastReminderAt = now;
  if (sendInitial) state.firedAt = now;
  return sendInitial ? 'fire' : 'remind';
}

type EvalInput = {
  serverId: string;
  serverName: string;
  metric: AlertMetric;
  healthy: boolean;
  /** Human detail for the alert body, e.g. "Disk /var at 95% (threshold 90%)". */
  detail: string;
  value?: number;
  threshold?: number;
};

export type AlertEngineDeps = {
  cm: ConnectionManager;
  monitor: Monitor;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  getConfig: () => AlertConfig;
  getToken: () => string | undefined;
  getServerName: (serverId: string) => string;
  pollIntervalMs: () => number;
  emit: (event: AlertEvent) => void;
};

export class AlertEngine {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private states = new Map<string, RuleState>();

  constructor(private deps: AlertEngineDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    // Evaluate soon after launch rather than waiting a full interval.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run an evaluation immediately (call after the config changes). */
  reconcile(): void {
    void this.tick();
  }

  /** Currently-firing incidents (rules whose `triggered` flag is set) — used by
   *  the MCP get_alerts tool so external agents can triage without Telegram. */
  snapshot(): { serverId: string; metric: AlertMetric; firedAt: number }[] {
    const incidents: { serverId: string; metric: AlertMetric; firedAt: number }[] = [];
    for (const [key, st] of this.states) {
      if (!st.triggered) continue;
      // Keys are `${serverId}:${metric}` and metrics never contain a colon.
      const sep = key.lastIndexOf(':');
      incidents.push({
        serverId: key.slice(0, sep),
        metric: key.slice(sep + 1) as AlertMetric,
        firedAt: st.firedAt,
      });
    }
    return incidents;
  }

  /** Forget a server's counters and stop supervising it. */
  clearServer(serverId: string): void {
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(`${serverId}:`)) this.states.delete(key);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const config = this.deps.getConfig();
      const token = this.deps.getToken();
      // No delivery channel configured → don't track anything, so enabling
      // Telegram later starts from a clean slate (no phantom "already firing").
      if (!token || !config.chatId) {
        this.states.clear();
        return;
      }
      for (const sc of config.servers) {
        if (!sc.enabled) {
          this.clearServer(sc.serverId);
          continue;
        }
        await this.checkServer(sc, config);
      }
      for (const hc of config.httpChecks ?? []) {
        if (!hc.enabled) {
          this.clearServer(hc.id); // same `${id}:` key prefix as server rules
          continue;
        }
        await this.checkHttp(hc, config);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** One URL check: reachability/status via `http`, cert validity via `tls`. */
  private async checkHttp(hc: HttpCheckConfig, config: AlertConfig): Promise<void> {
    const probe = await probeHttp(hc.url);
    const label = httpCheckLabel(hc.url);
    this.evaluate(config, {
      serverId: hc.id,
      serverName: label,
      metric: 'http',
      healthy: probe.up,
      detail: probe.up
        ? `${hc.url} is responding (HTTP ${probe.status})`
        : probe.error
          ? `${hc.url} failed: ${probe.error}`
          : `${hc.url} returned HTTP ${probe.status}`,
      value: probe.status,
    });
    // Only judged on a successful https probe — a down site should fire ONE
    // incident (http), not drag a phantom TLS alert along with it.
    if (
      hc.tlsExpiryDays != null &&
      probe.up &&
      probe.certDaysLeft !== undefined
    ) {
      this.evaluate(config, {
        serverId: hc.id,
        serverName: label,
        metric: 'tls',
        healthy: probe.certDaysLeft > hc.tlsExpiryDays,
        detail: `TLS certificate for ${label} expires in ${probe.certDaysLeft} day${probe.certDaysLeft === 1 ? '' : 's'} (threshold ${hc.tlsExpiryDays})`,
        value: probe.certDaysLeft,
        threshold: hc.tlsExpiryDays,
      });
    }
  }

  private async checkServer(sc: ServerAlertConfig, config: AlertConfig): Promise<void> {
    const serverId = sc.serverId;
    const name = this.deps.getServerName(serverId);

    // Reachability: connected already, or a fresh connect attempt succeeds.
    let up = this.deps.cm.getStatus(serverId) === 'connected';
    if (!up) {
      const res = await this.deps.connect(serverId);
      up = !!res.ok;
    }
    if (up) {
      // Keep a background poller alive so resource stats stay fresh.
      this.deps.monitor.start(serverId, this.deps.pollIntervalMs());
    }

    if (sc.reachability) {
      this.evaluate(config, {
        serverId,
        serverName: name,
        metric: 'reachability',
        healthy: up,
        detail: up ? 'SSH connection restored' : 'SSH connection failed',
      });
    }

    if (!up) return; // can't read resource metrics from a host that's down

    const stats = this.deps.monitor.getLatest(serverId);
    const fresh =
      stats && Date.now() - stats.ts <= this.deps.pollIntervalMs() * 3 + 5_000;
    if (!stats || !fresh) return; // no sample yet this session — try next tick

    this.evaluateResourceRules(config, serverId, name, sc, stats);
  }

  private evaluateResourceRules(
    config: AlertConfig,
    serverId: string,
    name: string,
    sc: ServerAlertConfig,
    stats: ServerStats,
  ): void {
    const th = sc.thresholds;

    if (th.cpu != null) {
      const v = Math.round(stats.cpuPct);
      this.evaluate(config, {
        serverId,
        serverName: name,
        metric: 'cpu',
        healthy: v <= th.cpu,
        detail: `CPU at ${v}% (threshold ${th.cpu}%)`,
        value: v,
        threshold: th.cpu,
      });
    }

    if (th.memory != null && stats.mem.totalBytes > 0) {
      const v = Math.round((stats.mem.usedBytes / stats.mem.totalBytes) * 100);
      this.evaluate(config, {
        serverId,
        serverName: name,
        metric: 'memory',
        healthy: v <= th.memory,
        detail: `Memory at ${v}% (threshold ${th.memory}%)`,
        value: v,
        threshold: th.memory,
      });
    }

    if (th.disk != null) {
      const worst = worstDisk(stats);
      if (worst) {
        this.evaluate(config, {
          serverId,
          serverName: name,
          metric: 'disk',
          healthy: worst.pct <= th.disk,
          detail: `Disk ${worst.mount} at ${worst.pct}% (threshold ${th.disk}%)`,
          value: worst.pct,
          threshold: th.disk,
        });
      }
    }

    if (th.load != null) {
      const v = stats.loadAvg[0];
      this.evaluate(config, {
        serverId,
        serverName: name,
        metric: 'load',
        healthy: v <= th.load,
        detail: `Load average (1m) ${v.toFixed(2)} (threshold ${th.load})`,
        value: v,
        threshold: th.load,
      });
    }
  }

  /**
   * The Gatus state machine for one rule check. Sends Telegram + emits an
   * AlertEvent only on a real transition (fire / reminder / resolve).
   */
  private evaluate(config: AlertConfig, input: EvalInput): void {
    const key = `${input.serverId}:${input.metric}`;
    const st = this.states.get(key) ?? freshRuleState();
    const action = stepRule(st, input.healthy, config, Date.now());
    this.states.set(key, st);
    switch (action) {
      case 'fire':
        this.notify(config, input, 'firing', false, st.firedAt);
        break;
      case 'remind':
        this.notify(config, input, 'firing', true, st.firedAt);
        break;
      case 'resolve':
        this.notify(config, input, 'resolved', false, st.firedAt);
        break;
      default:
        break;
    }
  }

  private notify(
    config: AlertConfig,
    input: EvalInput,
    state: 'firing' | 'resolved',
    reminder: boolean,
    firedAt: number,
  ): void {
    const event: AlertEvent = {
      serverId: input.serverId,
      serverName: input.serverName,
      metric: input.metric,
      state,
      message: input.detail,
      value: input.value,
      threshold: input.threshold,
      reminder,
      ts: Date.now(),
    };
    this.deps.emit(event);

    const token = this.deps.getToken();
    if (!token || !config.chatId) return;
    const html = renderAlertHtml(event, firedAt);
    void sendMessage(token, config.chatId, html).catch((err) => {
      console.error('[alerts] failed to send Telegram message:', err);
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function worstDisk(stats: ServerStats): { mount: string; pct: number } | null {
  let worst: { mount: string; pct: number } | null = null;
  for (const d of stats.disks) {
    if (d.totalBytes <= 0) continue;
    const pct = Math.round((d.usedBytes / d.totalBytes) * 100);
    if (!worst || pct > worst.pct) worst = { mount: d.mount, pct };
  }
  return worst;
}

/** Render-style event names — what happened, in plain words, per metric. */
const METRIC_TITLES: Record<AlertMetric, { firing: string; resolved: string }> = {
  reachability: { firing: 'Server unreachable', resolved: 'Server back online' },
  cpu: { firing: 'High CPU usage', resolved: 'CPU back to normal' },
  memory: { firing: 'High memory usage', resolved: 'Memory back to normal' },
  disk: { firing: 'Disk almost full', resolved: 'Disk usage back to normal' },
  load: { firing: 'High load average', resolved: 'Load back to normal' },
  http: { firing: 'Website down', resolved: 'Website back up' },
  tls: { firing: 'TLS certificate expiring', resolved: 'TLS certificate renewed' },
};

/** "Jul 6, 1:24 AM" — the readable stamp every notification footer carries. */
export function formatAlertTime(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Compact incident duration: "45s", "12m", "1h 5m", "2d 3h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * Build the HTML message sent to Telegram. One standard shape for every
 * notification (Render.com-style event feed):
 *
 *   <icon> <b>Event title</b>          🔴 High memory usage
 *   <b>subject</b> · detail            E · Memory at 95% (threshold 90%)
 *   <i>context · readable time</i>     firing for 30m · Jul 6, 1:24 AM
 */
export function renderAlertHtml(event: AlertEvent, firedAt = 0): string {
  const titles = METRIC_TITLES[event.metric];
  const icon = event.state === 'resolved' ? '✅' : '🔴';
  const title = event.state === 'resolved' ? titles.resolved : titles.firing;

  const footer: string[] = [];
  if (event.reminder) {
    footer.push(
      firedAt > 0
        ? `still firing · ${formatDuration(event.ts - firedAt)} so far`
        : 'still firing',
    );
  } else if (event.state === 'resolved' && firedAt > 0) {
    footer.push(`recovered after ${formatDuration(event.ts - firedAt)}`);
  }
  footer.push(formatAlertTime(event.ts));

  return [
    `${icon} <b>${escapeHtml(title)}</b>`,
    `<b>${escapeHtml(event.serverName)}</b> · ${escapeHtml(event.message)}`,
    `<i>${escapeHtml(footer.join(' · '))}</i>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Service layer (IPC-facing) — token exchange & storage stay in main.
// ---------------------------------------------------------------------------

export function loadToken(): string | undefined {
  return secrets.loadRawSecret(TOKEN_SECRET_ID);
}

export function getAlertsStatus(): AlertsStatus {
  return { hasToken: !!loadToken(), config: store.getAlertConfig() };
}

/** Validate a bot token via getMe, then persist it (encrypted) + the bot's name. */
export async function connectToken(token: string): Promise<TelegramConnectResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, error: 'Paste your bot token first.' };
  try {
    const me = await getMe(trimmed);
    secrets.saveRawSecret(TOKEN_SECRET_ID, trimmed);
    store.setAlertConfig({ botUsername: me.username, botName: me.name });
    return { ok: true, botUsername: me.username, botName: me.name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Forget the bot token and clear the chat/bot metadata (keeps server toggles). */
export function disconnect(): AlertsStatus {
  secrets.deleteRawSecret(TOKEN_SECRET_ID);
  store.setAlertConfig({ chatId: null, botUsername: undefined, botName: undefined });
  return getAlertsStatus();
}

export async function detectChat(): Promise<TelegramChatDetectResult> {
  const token = loadToken();
  if (!token) return { ok: false, error: 'Connect a bot token first.' };
  try {
    const chats = await getUpdates(token);
    if (chats.length === 0) {
      return {
        ok: false,
        error:
          'No chats found. Open Telegram, send your bot any message, then try again.',
      };
    }
    return { ok: true, chats };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTest(): Promise<TelegramTestResult> {
  const token = loadToken();
  const { chatId } = store.getAlertConfig();
  if (!token) return { ok: false, error: 'Connect a bot token first.' };
  if (!chatId) return { ok: false, error: 'Pick a chat first.' };
  try {
    // Same 3-line shape as real alerts, so the test previews the actual style.
    await sendMessage(
      token,
      chatId,
      [
        '🔔 <b>Test notification</b>',
        '<b>Tevada DevOps</b> · Telegram alerts are configured correctly.',
        `<i>${escapeHtml(formatAlertTime(Date.now()))}</i>`,
      ].join('\n'),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
