/**
 * Tiny JSON persistence for server profiles and app settings.
 *
 * Lives at `<userData>/easyhost.json`. Writes are atomic (temp file + rename) so
 * a crash mid-write can't corrupt the store. Secret material is NOT stored here —
 * see secrets.ts (safeStorage-encrypted blobs).
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  AlertConfig,
  AppSettings,
  ChatHistoryItem,
  ChatSession,
  ChatSessionKind,
  ChatSessionStatus,
  DatabaseCredentialMeta,
  DEFAULT_ALERT_CONFIG,
  DEFAULT_ALERT_THRESHOLDS,
  DEFAULT_SETTINGS,
  GithubAccount,
  ServerAlertConfig,
  ServerProfile,
} from '../shared/ipc-types';

/** Legacy (pre-sessions) persisted shape — kept only so `read()` can migrate it. */
type LegacyChatHistory = {
  items: ChatHistoryItem[];
  targetServerId?: string | null;
  updatedAt: number;
};

type StoreData = {
  servers: ServerProfile[];
  settings: AppSettings;
  chatSessions: ChatSession[];
  activeChatSessionId: string | null;
  /** Metadata only — passwords live encrypted in secrets.ts, see main/credentials.ts. */
  dbCredentials: DatabaseCredentialMeta[];
  /** Connected GitHub account metadata (the token itself is in secrets.ts). */
  github?: GithubAccount;
  /** Telegram alerting config (the bot token itself is in secrets.ts). */
  alerts?: AlertConfig;
};

const EMPTY: StoreData = {
  servers: [],
  settings: { ...DEFAULT_SETTINGS },
  chatSessions: [],
  activeChatSessionId: null,
  dbCredentials: [],
};

function storePath(): string {
  return path.join(app.getPath('userData'), 'easyhost.json');
}

function read(): StoreData {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreData> & {
      chatHistory?: LegacyChatHistory;
    };
    const sessions = Array.isArray(parsed.chatSessions)
      ? parsed.chatSessions.map(normalizeChatSession).filter((s): s is ChatSession => s !== null)
      : migrateLegacyChatHistory(parsed.chatHistory);
    return {
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      chatSessions: sessions,
      activeChatSessionId:
        typeof parsed.activeChatSessionId === 'string'
          ? parsed.activeChatSessionId
          : (sessions[0]?.id ?? null),
      dbCredentials: Array.isArray(parsed.dbCredentials)
        ? parsed.dbCredentials.map(normalizeDbCredentialMeta).filter(
            (c): c is DatabaseCredentialMeta => c !== null,
          )
        : [],
      github: parsed.github,
      alerts: parsed.alerts ? normalizeAlertConfig(parsed.alerts) : undefined,
    };
  } catch {
    return { ...EMPTY, settings: { ...DEFAULT_SETTINGS }, chatSessions: [], dbCredentials: [] };
  }
}

function normalizeAlertConfig(value: unknown): AlertConfig {
  const r = (value && typeof value === 'object' ? value : {}) as Partial<AlertConfig>;
  const servers = Array.isArray(r.servers)
    ? r.servers
        .map(normalizeServerAlertConfig)
        .filter((s): s is ServerAlertConfig => s !== null)
    : [];
  return {
    chatId: typeof r.chatId === 'string' ? r.chatId : null,
    botUsername: typeof r.botUsername === 'string' ? r.botUsername : undefined,
    botName: typeof r.botName === 'string' ? r.botName : undefined,
    failureThreshold:
      typeof r.failureThreshold === 'number' && r.failureThreshold >= 1
        ? Math.floor(r.failureThreshold)
        : DEFAULT_ALERT_CONFIG.failureThreshold,
    successThreshold:
      typeof r.successThreshold === 'number' && r.successThreshold >= 1
        ? Math.floor(r.successThreshold)
        : DEFAULT_ALERT_CONFIG.successThreshold,
    reminderMinutes:
      typeof r.reminderMinutes === 'number' && r.reminderMinutes >= 0
        ? Math.floor(r.reminderMinutes)
        : DEFAULT_ALERT_CONFIG.reminderMinutes,
    servers,
  };
}

function normalizeServerAlertConfig(value: unknown): ServerAlertConfig | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<ServerAlertConfig>;
  if (typeof r.serverId !== 'string') return null;
  const t = (r.thresholds ?? {}) as Partial<AlertThresholdsShape>;
  const num = (v: unknown, fallback: number | null): number | null =>
    v === null ? null : typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    serverId: r.serverId,
    enabled: r.enabled === true,
    reachability: r.reachability !== false, // default on
    thresholds: {
      cpu: num(t.cpu, DEFAULT_ALERT_THRESHOLDS.cpu),
      memory: num(t.memory, DEFAULT_ALERT_THRESHOLDS.memory),
      disk: num(t.disk, DEFAULT_ALERT_THRESHOLDS.disk),
      load: num(t.load, DEFAULT_ALERT_THRESHOLDS.load),
    },
  };
}

type AlertThresholdsShape = {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  load: number | null;
};

function normalizeDbCredentialMeta(value: unknown): DatabaseCredentialMeta | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<DatabaseCredentialMeta>;
  if (
    typeof r.id !== 'string' ||
    typeof r.serverId !== 'string' ||
    typeof r.engine !== 'string' ||
    typeof r.host !== 'string' ||
    typeof r.port !== 'number'
  ) {
    return null;
  }
  return {
    id: r.id,
    serverId: r.serverId,
    engine: r.engine,
    host: r.host,
    port: r.port,
    externalHost: typeof r.externalHost === 'string' ? r.externalHost : undefined,
    database: typeof r.database === 'string' ? r.database : undefined,
    username: typeof r.username === 'string' ? r.username : undefined,
    createdAt:
      typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
        ? r.createdAt
        : Date.now(),
  };
}

function write(data: StoreData): void {
  const target = storePath();
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

/** One-time upgrade path: the pre-sessions store kept a single chat transcript. */
function migrateLegacyChatHistory(legacy: LegacyChatHistory | undefined): ChatSession[] {
  if (!legacy || !Array.isArray(legacy.items) || legacy.items.length === 0) return [];
  const items = legacy.items.filter(isChatHistoryItem);
  if (items.length === 0) return [];
  const updatedAt =
    typeof legacy.updatedAt === 'number' && Number.isFinite(legacy.updatedAt)
      ? legacy.updatedAt
      : Date.now();
  return [
    {
      id: `migrated_${updatedAt}`,
      items,
      targetServerId:
        typeof legacy.targetServerId === 'string' ? legacy.targetServerId : null,
      createdAt: updatedAt,
      updatedAt,
    },
  ];
}

const SESSION_KINDS: ChatSessionKind[] = ['chat', 'wizard'];
const SESSION_STATUSES: ChatSessionStatus[] = [
  'running',
  'done',
  'error',
  'cancelled',
  'interrupted',
];

function normalizeChatSession(value: unknown): ChatSession | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ChatSession>;
  if (typeof record.id !== 'string' || record.id.length === 0) return null;
  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? record.updatedAt
      : Date.now();
  return {
    id: record.id,
    kind: SESSION_KINDS.includes(record.kind as ChatSessionKind)
      ? record.kind
      : undefined,
    title: typeof record.title === 'string' ? record.title : undefined,
    playbookId:
      typeof record.playbookId === 'string' ? record.playbookId : undefined,
    status: SESSION_STATUSES.includes(record.status as ChatSessionStatus)
      ? record.status
      : undefined,
    pinned: record.pinned === true ? true : undefined,
    items: Array.isArray(record.items)
      ? record.items.filter(isChatHistoryItem)
      : [],
    targetServerId:
      typeof record.targetServerId === 'string' ? record.targetServerId : null,
    createdAt:
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : updatedAt,
    updatedAt,
  };
}

function isChatHistoryItem(value: unknown): value is ChatHistoryItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ChatHistoryItem>;
  if (item.kind === 'text') {
    return (
      typeof item.id === 'string' &&
      (item.role === 'user' || item.role === 'assistant') &&
      typeof item.content === 'string'
    );
  }
  if (item.kind === 'tool') {
    return (
      typeof item.toolCallId === 'string' &&
      typeof item.tool === 'string' &&
      (item.status === 'running' || item.status === 'done')
    );
  }
  if (item.kind === 'todos') {
    return (
      typeof item.id === 'string' &&
      Array.isArray(item.todos) &&
      item.todos.every(
        (t) =>
          t &&
          typeof t.text === 'string' &&
          (t.status === 'pending' ||
            t.status === 'in_progress' ||
            t.status === 'completed'),
      )
    );
  }
  return false;
}

// --- servers ---------------------------------------------------------------

export function listServers(): ServerProfile[] {
  return read().servers;
}

export function getServer(id: string): ServerProfile | undefined {
  return read().servers.find((s) => s.id === id);
}

export function addServer(profile: ServerProfile): ServerProfile {
  const data = read();
  data.servers.push(profile);
  write(data);
  return profile;
}

export function updateServer(
  id: string,
  patch: Partial<Omit<ServerProfile, 'id' | 'createdAt'>>,
): ServerProfile | undefined {
  const data = read();
  const idx = data.servers.findIndex((s) => s.id === id);
  if (idx === -1) return undefined;
  data.servers[idx] = { ...data.servers[idx], ...patch };
  write(data);
  return data.servers[idx];
}

export function removeServer(id: string): void {
  const data = read();
  data.servers = data.servers.filter((s) => s.id !== id);
  write(data);
}

// --- database credentials (metadata only) -----------------------------------

export function listDbCredentials(serverId: string): DatabaseCredentialMeta[] {
  return read()
    .dbCredentials.filter((c) => c.serverId === serverId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getDbCredential(id: string): DatabaseCredentialMeta | undefined {
  return read().dbCredentials.find((c) => c.id === id);
}

/** Upserts by (serverId, engine, port): re-running the wizard on the same
 *  instance replaces the stale entry instead of accumulating duplicates. */
export function saveDbCredential(
  input: Omit<DatabaseCredentialMeta, 'id' | 'createdAt'>,
): DatabaseCredentialMeta {
  const data = read();
  const existing = data.dbCredentials.find(
    (c) =>
      c.serverId === input.serverId &&
      c.engine === input.engine &&
      c.port === input.port,
  );
  const meta: DatabaseCredentialMeta = {
    ...input,
    // Preserve a previously-attached external host when a later save (e.g. the
    // user re-recording the password) doesn't carry one of its own.
    externalHost: input.externalHost ?? existing?.externalHost,
    id: existing?.id ?? `dbcred_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  if (existing) {
    data.dbCredentials[data.dbCredentials.indexOf(existing)] = meta;
  } else {
    data.dbCredentials.push(meta);
  }
  write(data);
  return meta;
}

/** Called after the enable-db-remote-access wizard succeeds: the password and
 *  the internal host are untouched — we just ATTACH the server's public host as
 *  the external endpoint (Dokploy-style), so "Credentials" shows both the local
 *  and the now-working remote address. No-ops if nothing was saved for this
 *  database yet. */
export function setDbCredentialExternalHost(
  serverId: string,
  engine: string,
  port: number,
  externalHost: string,
): DatabaseCredentialMeta | undefined {
  const data = read();
  const existing = data.dbCredentials.find(
    (c) => c.serverId === serverId && c.engine === engine && c.port === port,
  );
  if (!existing || existing.externalHost === externalHost) return existing;
  const updated: DatabaseCredentialMeta = { ...existing, externalHost };
  data.dbCredentials[data.dbCredentials.indexOf(existing)] = updated;
  write(data);
  return updated;
}

export function removeDbCredential(id: string): void {
  const data = read();
  data.dbCredentials = data.dbCredentials.filter((c) => c.id !== id);
  write(data);
}

/** Removes every credential for a server (called when the server itself is
 *  removed) and returns them so the caller can also clear their encrypted
 *  passwords out of secrets.ts. */
export function removeDbCredentialsForServer(serverId: string): DatabaseCredentialMeta[] {
  const data = read();
  const removed = data.dbCredentials.filter((c) => c.serverId === serverId);
  data.dbCredentials = data.dbCredentials.filter((c) => c.serverId !== serverId);
  write(data);
  return removed;
}

// --- settings --------------------------------------------------------------

export function getSettings(): AppSettings {
  return read().settings;
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const data = read();
  data.settings = { ...data.settings, ...patch };
  write(data);
  return data.settings;
}

// --- chat history (sessions) ------------------------------------------------

export type ChatHistoryState = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

function sortedByRecency(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
}

function chatState(data: StoreData): ChatHistoryState {
  return {
    sessions: sortedByRecency(data.chatSessions),
    activeSessionId: data.activeChatSessionId,
  };
}

export function getChatState(): ChatHistoryState {
  return chatState(read());
}

/**
 * Insert or update a session (keyed by id). Sessions are never trimmed — only
 * an explicit delete removes one.
 *
 * Deliberately does NOT touch activeChatSessionId: background runs keep saving
 * their sessions while the user is viewing (or drafting) another conversation,
 * and those writes must not hijack which one is open. The renderer moves the
 * pointer explicitly via setActiveChatSession.
 */
/** True when two sessions carry the same user-visible content. Used so a
 *  no-op re-save keeps its History position (see upsertChatSession). */
function sameSessionContent(a: ChatSession, b: ChatSession): boolean {
  return (
    a.title === b.title &&
    (a.kind ?? 'chat') === (b.kind ?? 'chat') &&
    a.status === b.status &&
    a.playbookId === b.playbookId &&
    (a.targetServerId ?? null) === (b.targetServerId ?? null) &&
    JSON.stringify(a.items) === JSON.stringify(b.items)
  );
}

export function upsertChatSession(session: ChatSession): ChatHistoryState {
  const data = read();
  const normalized = normalizeChatSession({
    ...session,
    updatedAt: session.updatedAt || Date.now(),
  })!;
  const idx = data.chatSessions.findIndex((s) => s.id === normalized.id);
  if (idx === -1) {
    normalized.createdAt = normalized.createdAt || normalized.updatedAt;
    data.chatSessions.push(normalized);
  } else {
    const prev = data.chatSessions[idx];
    const next = {
      ...normalized,
      createdAt: prev.createdAt,
      // The pinned flag is owned by setChatSessionPinned, not the ChatPanel's
      // debounced saves — preserve it so a background re-save can't unpin a row.
      pinned: normalized.pinned ?? prev.pinned,
    };
    // Reopening a conversation re-saves it verbatim (the ChatPanel's
    // normalize-after-load pass). Identical content is not activity: keep the
    // old timestamp, or History reorders itself on every click.
    if (sameSessionContent(prev, next)) next.updatedAt = prev.updatedAt;
    data.chatSessions[idx] = next;
  }
  write(data);
  return chatState(data);
}

/** Pins/unpins a session so it sticks to the top of History. */
export function setChatSessionPinned(id: string, pinned: boolean): ChatHistoryState {
  const data = read();
  const session = data.chatSessions.find((s) => s.id === id);
  if (session) {
    session.pinned = pinned ? true : undefined;
    write(data);
  }
  return chatState(data);
}

/** Switches the active session pointer without touching any session's content. */
export function setActiveChatSession(id: string | null): ChatHistoryState {
  const data = read();
  data.activeChatSessionId = id;
  write(data);
  return chatState(data);
}

export function deleteChatSession(id: string): ChatHistoryState {
  const data = read();
  data.chatSessions = data.chatSessions.filter((s) => s.id !== id);
  if (data.activeChatSessionId === id) {
    // The active pointer always refers to a *chat* session (the one open in
    // the ChatPanel), so skip wizard runs when picking a fallback.
    data.activeChatSessionId =
      sortedByRecency(data.chatSessions).find(
        (s) => (s.kind ?? 'chat') === 'chat',
      )?.id ?? null;
  }
  write(data);
  return chatState(data);
}

/**
 * Startup/reload recovery: any session persisted mid-run can no longer be
 * running (runs die with the renderer), so downgrade it to 'interrupted'
 * instead of showing a spinner forever.
 */
export function markInterruptedChatSessions(): ChatHistoryState {
  const data = read();
  let changed = false;
  for (const session of data.chatSessions) {
    if (session.status === 'running') {
      session.status = 'interrupted';
      changed = true;
    }
  }
  if (changed) write(data);
  return chatState(data);
}

// --- github account ----------------------------------------------------------

export function getGithubAccount(): GithubAccount | undefined {
  return read().github;
}

export function setGithubAccount(account: GithubAccount | undefined): void {
  const data = read();
  data.github = account;
  write(data);
}

// --- telegram alerting -------------------------------------------------------

export function getAlertConfig(): AlertConfig {
  const data = read();
  return data.alerts ?? { ...DEFAULT_ALERT_CONFIG, servers: [] };
}

/** Patch the global alert fields (chat, thresholds, reminder, bot info). */
export function setAlertConfig(
  patch: Partial<Omit<AlertConfig, 'servers'>>,
): AlertConfig {
  const data = read();
  const current = data.alerts ?? { ...DEFAULT_ALERT_CONFIG, servers: [] };
  data.alerts = { ...current, ...patch };
  write(data);
  return data.alerts;
}

/** Upsert one server's alert config (enable/disable, thresholds, reachability). */
export function setServerAlertConfig(sc: ServerAlertConfig): AlertConfig {
  const data = read();
  const current = data.alerts ?? { ...DEFAULT_ALERT_CONFIG, servers: [] };
  const normalized = normalizeServerAlertConfig(sc)!;
  const idx = current.servers.findIndex((s) => s.serverId === normalized.serverId);
  if (idx === -1) current.servers.push(normalized);
  else current.servers[idx] = normalized;
  data.alerts = current;
  write(data);
  return data.alerts;
}

/** Drop a server's alert config (called when the server itself is removed). */
export function removeServerAlertConfig(serverId: string): void {
  const data = read();
  if (!data.alerts) return;
  data.alerts.servers = data.alerts.servers.filter((s) => s.serverId !== serverId);
  write(data);
}
