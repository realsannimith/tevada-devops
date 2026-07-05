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
import {
  AlertConfig,
  AlertEvent,
  AlertMetric,
  AlertsStatus,
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

export type RuleState = {
  failures: number;
  successes: number;
  triggered: boolean;
  lastReminderAt: number;
};

export function freshRuleState(): RuleState {
  return { failures: 0, successes: 0, triggered: false, lastReminderAt: 0 };
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
    } finally {
      this.ticking = false;
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
        detail: up ? 'Host is reachable' : 'Host is unreachable (SSH down)',
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
        this.notify(config, input, 'firing', false);
        break;
      case 'remind':
        this.notify(config, input, 'firing', true);
        break;
      case 'resolve':
        this.notify(config, input, 'resolved', false);
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
    const html = renderAlertHtml(event);
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

const METRIC_LABEL: Record<AlertMetric, string> = {
  reachability: 'Reachability',
  cpu: 'CPU',
  memory: 'Memory',
  disk: 'Disk',
  load: 'Load average',
};

/** Build the HTML message body sent to Telegram. */
export function renderAlertHtml(event: AlertEvent): string {
  const icon = event.state === 'resolved' ? '✅' : '🔴';
  const heading = event.state === 'resolved' ? 'Resolved' : reminderOrTriggered(event);
  const label = METRIC_LABEL[event.metric];
  const lines = [
    `${icon} <b>${escapeHtml(event.serverName)}</b> — ${heading}`,
    `${escapeHtml(label)}: ${escapeHtml(event.message)}`,
  ];
  return lines.join('\n');
}

function reminderOrTriggered(event: AlertEvent): string {
  return event.reminder ? 'Still firing' : 'Alert';
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
    await sendMessage(
      token,
      chatId,
      '✅ <b>EASY-HOST</b> — test alert\nTelegram alerts are configured correctly.',
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
