/**
 * Shared IPC types & channel constants — the single source of truth imported by
 * the main process, the preload bridge, and the renderer. No secret material ever
 * appears in these types: credentials cross IPC only once (renderer -> main on
 * add/update) and are never echoed back.
 */
import type { EffortLevel, ProviderId } from './providers';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type AuthType = 'password' | 'key';

/** A saved server profile. Contains NO secret material. */
export type ServerProfile = {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: AuthType;
  createdAt: number;
  /**
   * Projects this server belongs to. Absent/empty = unassigned. A server is
   * usually in one project, but may be in several (user's choice) — hence an
   * array rather than a single id. See {@link Project}.
   */
  projectIds?: string[];
};

/**
 * An in-app project: a local grouping of servers plus per-project "memory"
 * (notes) that gets injected into the agent's context for every chat tagged to
 * the project. Purely local — persisted in easyhost.json, no secret material.
 */
export type Project = {
  id: string;
  name: string;
  /** Optional accent colour (hex) for the sidebar/history tag. */
  color?: string;
  /** Free-form notes auto-injected into the agent's system context. */
  memory?: string;
  createdAt: number;
  updatedAt: number;
};

/** Secret material for a profile — only ever travels renderer -> main. */
export type ServerSecret = {
  password?: string;
  privateKey?: string;
  passphrase?: string;
  /**
   * Reference to a key generated in-app (see keygen.ts). When present, main
   * swaps it for the stashed private key at save time, so the private key never
   * has to travel to the renderer.
   */
  keyRef?: string;
};

/** Public half of an in-app generated key, plus the ref used to save it. */
export type GeneratedKey = { keyRef: string; publicKey: string };

export type ConnStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type AppSettings = {
  /** When true, the agent asks before running any state-changing command. */
  approvalMode: boolean;
  /** Max tool-loop steps per agent run. */
  agentMaxSteps: number;
  /** Monitoring poll interval in ms. */
  pollIntervalMs: number;
  /**
   * Predictive local echo (typeahead): draw typed characters instantly as
   * dimmed predictions before the server confirms them, the way Mosh/Termius do.
   */
  localEcho: boolean;
  /** Active LLM provider. Its API key lives in the encrypted secret store. */
  aiProvider: ProviderId;
  /** Model id sent to the provider (curated pick or user-typed custom id). */
  aiModel: string;
  /** Endpoint base URL — used only when aiProvider is 'openai-compatible'. */
  aiBaseUrl: string;
  /** Reasoning effort, translated to each provider's own knob at run time. */
  aiEffort: EffortLevel;
  /** Extended thinking / reasoning on or off (where the provider supports it). */
  aiThinking: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  approvalMode: false, // full-auto (YOLO) by default, per product decision
  agentMaxSteps: 50,
  pollIntervalMs: 4000,
  localEcho: true,
  aiProvider: 'google',
  aiModel: 'gemini-3.5-flash',
  aiBaseUrl: '',
  aiEffort: 'medium',
  aiThinking: true,
};

/**
 * Per-provider API key presence, for the Settings UI. `stored` = a key is in
 * the encrypted store; `env` = an environment-variable fallback would apply.
 * The key material itself never crosses IPC back to the renderer.
 */
export type AiKeyStatus = Record<ProviderId, { stored: boolean }>;

// ---------------------------------------------------------------------------
// Monitoring
// ---------------------------------------------------------------------------

export type DiskUsage = {
  filesystem: string;
  mount: string;
  usedBytes: number;
  totalBytes: number;
};

export type ProcessInfo = {
  user: string;
  pid: string;
  cpu: number;
  mem: number;
  command: string;
};

export type ServerStats = {
  ts: number;
  cpuPct: number;
  mem: { usedBytes: number; totalBytes: number };
  disks: DiskUsage[];
  net: { rxBps: number; txBps: number };
  uptimeSec: number;
  loadAvg: [number, number, number];
  topProcesses: ProcessInfo[];
};

// ---------------------------------------------------------------------------
// Artifacts (what's deployed / running on a server)
// ---------------------------------------------------------------------------

export type ArtifactKind =
  | 'website'
  | 'container'
  | 'database'
  | 'service'
  | 'backup';

export type ArtifactStatus = 'running' | 'stopped' | 'scheduled' | 'unknown';

/** One deployed thing discovered on a server — a site, container, DB, service or cron backup. */
export type ServerArtifact = {
  id: string;
  kind: ArtifactKind;
  name: string;
  status: ArtifactStatus;
  /** Icon hint: 'postgresql' | 'mysql' | 'mariadb' | 'redis' | 'mongodb' | 'docker' | 'node' | 'nginx' … */
  engine?: string;
  /** One-line description — image, doc root, proxy target, dump command… */
  detail?: string;
  /** Secondary line — uptime, cron schedule, config file path… */
  meta?: string;
  ports?: number[];
  /** True when at least one of `ports` is bound to a non-loopback address
   *  (0.0.0.0 / ::) rather than 127.0.0.1 — i.e. reachable from outside this
   *  server, not just from localhost. Only meaningful when `ports` is set. */
  remoteAccessible?: boolean;
};

export type ArtifactsScanResult =
  | { ok: true; ts: number; artifacts: ServerArtifact[] }
  | { ok: false; error: string };

/** Lifecycle verbs the Artifacts tab can apply to a container or service row. */
export type ArtifactAction = 'start' | 'stop' | 'restart';

/** What actually runs the artifact — decides `docker` vs `systemctl`. Derived
 *  in the renderer from the artifact id prefix ("container:…" / "service:…"). */
export type ArtifactRuntime = 'container' | 'service';

export type ArtifactActionRequest = {
  serverId: string;
  runtime: ArtifactRuntime;
  /** Docker container name, or systemd unit without the .service suffix. */
  name: string;
  action: ArtifactAction;
};

export type ArtifactLogsRequest = {
  serverId: string;
  runtime: ArtifactRuntime;
  name: string;
};

export type ArtifactLogsResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Database credentials — saved by the "Set up a database" wizard (and the
// agent generally) so a generated password isn't lost the moment the chat
// scrolls away. Retrievable later from the matching artifact in the
// Artifacts tab. The password itself never lives in the plain JSON store —
// see main/credentials.ts + main/secrets.ts (OS keychain/keyring).
// ---------------------------------------------------------------------------

/** Non-secret half — safe to list freely; matched against a ServerArtifact by engine + port.
 *
 *  Like Dokploy, a database has two endpoints: an INTERNAL one (`host`, always
 *  reachable from apps on the same server / Docker network — normally
 *  `127.0.0.1`) and, when the DB is opened to the internet, an EXTERNAL one
 *  (`externalHost`, the server's public IP/domain). The port is the same for
 *  both. `externalHost` is absent for local-only databases. */
export type DatabaseCredentialMeta = {
  id: string;
  serverId: string;
  /** 'postgresql' | 'mysql' | 'mariadb' | 'redis' | 'mongodb' — matches ServerArtifact.engine. */
  engine: string;
  /** Internal host — reachable from the server itself / other containers. Normally 127.0.0.1. */
  host: string;
  port: number;
  /** Public host — set only once remote access is enabled. Absent = local-only. */
  externalHost?: string;
  /** Absent for Redis, which has no concept of a named database. */
  database?: string;
  username?: string;
  createdAt: number;
};

/** Full credential, password included — only ever returned by an explicit reveal call.
 *  `connectionString` targets the internal host; `externalConnectionString` the
 *  public host, present only when `externalHost` is set. */
export type DatabaseCredential = DatabaseCredentialMeta & {
  password: string;
  connectionString: string;
  externalConnectionString?: string;
};

/** Renderer -> main: either the agent (after a wizard run) or the user
 *  (typed into the "Save credentials" form on an artifact) saving a password.
 *  A remote host passed in `host` is recorded as the external endpoint (the
 *  internal 127.0.0.1 one is kept automatically); `externalHost` can also be
 *  set explicitly. */
export type SaveDatabaseCredentialRequest = {
  serverId: string;
  engine: string;
  host: string;
  port: number;
  externalHost?: string;
  database?: string;
  username?: string;
  password: string;
};

/** Best-effort guess read back from a live Docker container's own config —
 *  offered as a prefill in the "Save credentials" form, never saved silently. */
export type ContainerCredentialGuess = {
  password: string;
  username?: string;
  database?: string;
};

// ---------------------------------------------------------------------------
// Command execution result
// ---------------------------------------------------------------------------

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
};

// ---------------------------------------------------------------------------
// Agent streaming events (main -> renderer, wrapped as { runId, event })
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'text-delta'; text: string }
  /** A chunk of the model's thinking stream (extended thinking / reasoning
   *  summaries) — rendered live in a collapsible "Thinking" card. */
  | { type: 'reasoning-delta'; text: string }
  /** One thinking block finished; a later block appends as a new paragraph. */
  | { type: 'reasoning-end' }
  | {
      type: 'tool-start';
      toolCallId: string;
      tool: string;
      args: unknown;
      description?: string;
    }
  | { type: 'tool-log'; toolCallId: string; chunk: string }
  | { type: 'tool-end'; toolCallId: string; result: unknown }
  /** The agent's task checklist changed (updateTodos tool) — carries the full
   *  current list, which replaces whatever the transcript showed before. */
  | { type: 'todos'; todos: TodoItem[] }
  /** Steer messages that arrived after the run's last step (couldn't be
   *  injected). The renderer resends them as a fresh turn so they're not lost. */
  | { type: 'steer-unconsumed'; items: SteerItem[] }
  | {
      type: 'approval-required';
      approvalId: string;
      serverId: string;
      command: string;
      reason: string;
    }
  /** The agent asked the user to fill in a form; the run pauses until they
   *  submit or cancel it. Carries the full spec so the renderer can draw it. */
  | { type: 'form-required'; form: AgentFormSpec }
  | { type: 'step'; index: number }
  | { type: 'usage'; totalTokens: number }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

// ---------------------------------------------------------------------------
// Persisted chat history
// ---------------------------------------------------------------------------

/** A file/image the user attached to a message. Images go to the model as
 *  vision input; text files are inlined into the prompt so the agent can read
 *  (and deploy) them. */
export type ChatAttachment = {
  id: string;
  name: string;
  /** MIME type, e.g. 'image/png' or 'text/yaml'. */
  mediaType: string;
  kind: 'image' | 'text';
  /** Byte size of the original file. */
  size: number;
  /** Images only: 'data:<mime>;base64,…'. Absent for text files. */
  dataUrl?: string;
  /** Text files only: the (capped) file contents. Absent for images. */
  text?: string;
};

/** Composer attachment limits, enforced in the renderer before a file is added. */
export const ATTACHMENT_LIMITS = {
  maxCount: 5,
  maxImageBytes: 5 * 1024 * 1024, // 5 MB
  maxTextBytes: 128 * 1024, // 128 KB
} as const;

/**
 * How a user message was dispatched relative to a running agent turn:
 * 'queue' waits for the current run to finish; 'steer' is injected into the
 * live run to redirect it mid-flight. Absent = a normal send (no run active).
 */
export type TurnDispatchMode = 'queue' | 'steer';

export type ChatTextHistoryItem = {
  kind: 'text';
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Files/images the user attached to this message (user turns only). */
  attachments?: ChatAttachment[];
  /** Set to 'steer' when this user message was injected mid-run — drives the
   *  "Steering" chip in the transcript. */
  dispatchMode?: TurnDispatchMode;
};

/**
 * The model's thinking stream for one turn (extended thinking / reasoning
 * summaries — Anthropic, Codex, Gemini). Rendered as a quiet collapsible
 * "Thinking" card ahead of the answer, Codex/Claude-Code style, and persisted
 * so reopening the conversation still shows how the model reasoned. Never sent
 * back to the model (feedToMessages only forwards 'text' items).
 */
export type ChatReasoningHistoryItem = {
  kind: 'reasoning';
  id: string;
  content: string;
};

export type ChatToolHistoryItem = {
  kind: 'tool';
  toolCallId: string;
  tool: string;
  description?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  status: 'running' | 'done';
};

/** One entry in the agent's task checklist (the `updateTodos` tool). */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  text: string;
  status: TodoStatus;
};

/**
 * The agent's live task list, rendered as a single evolving checklist card in
 * the transcript. There is at most one per session — `updateTodos` replaces the
 * whole list each call, so the reducer updates this item in place rather than
 * appending a new one, and the user watches boxes tick off as work completes.
 */
export type ChatTodoHistoryItem = {
  kind: 'todos';
  id: string;
  todos: TodoItem[];
};

// ---------------------------------------------------------------------------
// Agent-requested forms (generative UI) — the agent can render an interactive
// form in the chat and wait for the user to fill it in, instead of asking for
// each value in plain text. First use: configuring a custom domain for a
// deployed service (requestDomainSetup tool).
// ---------------------------------------------------------------------------

export type FormFieldType = 'text' | 'number' | 'select' | 'toggle' | 'password';

export type FormField = {
  key: string;
  label: string;
  type: FormFieldType;
  placeholder?: string;
  /** Options for a 'select' field. */
  options?: string[];
  required?: boolean;
  /** Prefilled value. Toggles use 'true' / 'false'. */
  defaultValue?: string;
  /** One-line hint shown under the field. */
  help?: string;
};

/** An in-form DNS setup guide — renders a live A-record table + steps so the
 *  user can point their domain at this server before finishing. */
export type DnsGuideConfig = {
  /** The IP the DNS A-record should point at (this server's public IP). */
  serverIp: string;
  /** Which form field holds the domain (default 'domain'); the record NAME is
   *  computed live from its value. */
  domainField?: string;
  /** Which toggle field enables the www. variant (default 'www'). */
  wwwField?: string;
};

/** The spec the agent (via a tool) hands the renderer to draw a form. */
export type AgentFormSpec = {
  formId: string;
  title: string;
  description?: string;
  submitLabel?: string;
  fields: FormField[];
  /** When set, the form shows a live DNS setup guide (domain forms). */
  dnsGuide?: DnsGuideConfig;
};

/**
 * One form in the transcript. Starts 'pending' (interactive); once the user
 * submits or cancels it becomes a read-only record carrying their `values`, so
 * reopening the conversation shows what was entered.
 */
export type ChatFormHistoryItem = {
  kind: 'form';
  formId: string;
  title: string;
  description?: string;
  submitLabel?: string;
  fields: FormField[];
  status: 'pending' | 'submitted' | 'cancelled';
  /** Submitted values, keyed by field.key (toggles as 'true'/'false'). */
  values?: Record<string, string>;
  /** Present on domain forms — drives the in-form DNS setup guide. */
  dnsGuide?: DnsGuideConfig;
};

export type ChatHistoryItem =
  | ChatTextHistoryItem
  | ChatReasoningHistoryItem
  | ChatToolHistoryItem
  | ChatTodoHistoryItem
  | ChatFormHistoryItem;

/** Sessions record both free-form agent chats and wizard (playbook) runs. */
export type ChatSessionKind = 'chat' | 'wizard';

/**
 * Lifecycle of the agent run behind a session. `running` is only ever true
 * while the app is alive — on startup any leftover `running` is downgraded to
 * `interrupted` so a crash can't leave a session spinning forever.
 */
export type ChatSessionStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'cancelled'
  | 'interrupted';

/**
 * One saved conversation. Multiple sessions can exist at once (like FCode's
 * thread list) — "New chat" starts a fresh session without discarding the
 * previous one, and the sidebar lists every session that has at least one
 * message. Sessions are kept forever: nothing is trimmed automatically, only
 * an explicit user delete removes one.
 */
export type ChatSession = {
  id: string;
  /** Missing on pre-status sessions — treat as 'chat'. */
  kind?: ChatSessionKind;
  /** Explicit title (wizard runs); chats derive theirs from the first message. */
  title?: string;
  /** Which playbook produced this session (wizard runs only). */
  playbookId?: string;
  status?: ChatSessionStatus;
  /** Pinned sessions sort to the top of History and survive background re-saves. */
  pinned?: boolean;
  /** Total model tokens reported by the session's last run — shown at the end
   *  of the transcript once the stream has finished. */
  tokens?: number;
  items: ChatHistoryItem[];
  targetServerId?: string | null;
  /**
   * Project this chat is tagged to (null/absent = no project). Scopes the chat
   * in History and hard-limits the agent to the project's servers. See
   * {@link Project}.
   */
  projectId?: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Full persisted chat state: every saved session plus which one is active. */
export type ChatHistoryState = {
  sessions: ChatSession[];
  activeSessionId: string | null;
};

// ---------------------------------------------------------------------------
// Playbooks (wizards)
// ---------------------------------------------------------------------------

export type PlaybookInput = {
  key: string;
  label: string;
  type: 'text' | 'select' | 'path';
  options?: string[];
  placeholder?: string;
  required?: boolean;
};

/** Playbook metadata sent to the renderer (buildPrompt stays in main). */
export type PlaybookMeta = {
  id: string;
  title: string;
  description: string;
  inputs: PlaybookInput[];
};

// ---------------------------------------------------------------------------
// GitHub account connection
// ---------------------------------------------------------------------------

/**
 * The connected GitHub account. Contains NO token material — the OAuth/PAT
 * token (and, for GitHub App connections, the refresh token) lives in the
 * encrypted secret store and never crosses IPC.
 */
export type GithubAccount = {
  login: string;
  name?: string;
  avatarUrl?: string;
  /** Granted OAuth scopes reported by GitHub (informational; empty for GitHub Apps). */
  scopes?: string;
  connectedAt: number;
  /** 'app' = GitHub App device flow (repo access via installations). */
  method: 'device' | 'token' | 'app';
  /** Servers the user authorized to clone with their GitHub credentials. */
  authorizedServerIds: string[];
  /** GitHub App only: when the user access token expires (ms epoch).
   *  Undefined = non-expiring token (app has token expiration disabled). */
  tokenExpiresAt?: number;
  /** GitHub App only: set when the token expired and the refresh failed —
   *  the user has to reconnect. */
  needsReauth?: boolean;
  /** GitHub App only: the app's slug, learned from the first installation
   *  (used to build the install URL when GITHUB_APP_SLUG isn't set). */
  appSlug?: string;
  /** GitHub App only: last fetched installations (cache for instant UI). */
  installations?: GithubInstallation[];
};

/**
 * One installation of our GitHub App on a user/org account. This is where the
 * user chose "All repositories" or "Only select repositories".
 */
export type GithubInstallation = {
  id: number;
  /** The user or organization the app is installed on. */
  accountLogin: string;
  accountType?: 'User' | 'Organization';
  accountAvatarUrl?: string;
  repositorySelection: 'all' | 'selected';
  /** Total repos this installation grants (from the repositories endpoint). */
  repoCount?: number;
  /** GitHub settings page where the user edits this installation's repo access. */
  htmlUrl?: string;
};

export type GithubStatus = {
  connected: boolean;
  account?: GithubAccount;
  /** Device flow needs GITHUB_CLIENT_ID in .env; PAT paste always works. */
  deviceFlowAvailable: boolean;
  /** True when GITHUB_CLIENT_ID is a GitHub App client id ("Iv…"). */
  githubApp: boolean;
  /** Set when GITHUB_APP_SLUG (or a cached installation) gives us an install URL. */
  installUrl?: string;
};

export type GithubInstallationsResult =
  | { ok: true; installations: GithubInstallation[] }
  | { ok: false; error: string };

export type GithubDeviceFlowStart =
  | { ok: true; userCode: string; verificationUri: string; expiresIn: number }
  | { ok: false; error: string };

/** Pushed over evtGithubAuth while a device-flow authorization is pending. */
export type GithubAuthEvent =
  | { phase: 'pending' }
  | { phase: 'success'; account: GithubAccount }
  | { phase: 'error'; error: string };

// ---------------------------------------------------------------------------
// Codex (ChatGPT subscription) account — the OAuth tokens live encrypted in
// secrets.ts; only this non-secret metadata is stored/shown. See main/codexAuth.ts.
// ---------------------------------------------------------------------------

export type CodexAccount = {
  /** ChatGPT account email from the id_token, when present. */
  email?: string;
  /** ChatGPT account id (sent as the chatgpt-account-id header on model calls). */
  accountId?: string;
  /** Raw plan slug from the id_token (free|plus|pro|team|business|enterprise|edu|…). */
  planType?: string;
  /** Human label for the plan, e.g. "ChatGPT Plus". */
  planLabel?: string;
  connectedAt: number;
  /** Set when the refresh token expired — the user must sign in again. */
  needsReauth?: boolean;
};

export type CodexStatus = {
  connected: boolean;
  account?: CodexAccount;
  /** False when OS secure storage is unavailable (login can't be stored). */
  secretsAvailable: boolean;
};

/** Pushed over evtCodexAuth while a ChatGPT sign-in is in progress. */
export type CodexAuthEvent =
  | { phase: 'pending' }
  | { phase: 'success'; account: CodexAccount }
  | { phase: 'error'; error: string };

export type GithubRepo = {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  description?: string;
  pushedAt?: string;
};

export type GithubReposResult =
  | { ok: true; repos: GithubRepo[] }
  | { ok: false; error: string };

export type GithubCloneResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Google Drive app-data sync
// ---------------------------------------------------------------------------

export type GoogleDriveAccount = {
  email: string;
  name?: string;
  picture?: string;
  connectedAt: number;
  accessTokenExpiresAt?: number;
  lastSyncedAt?: number;
  lastSyncBytes?: number;
  lastSyncFileCount?: number;
  lastSyncHash?: string;
  syncError?: string;
  needsReauth?: boolean;
};

export type GoogleDriveStatus = {
  connected: boolean;
  account?: GoogleDriveAccount;
  clientConfigured: boolean;
  secretsAvailable: boolean;
  syncInProgress: boolean;
  /**
   * True right after connecting when a backup already exists on Drive and the
   * user hasn't chosen restore-vs-overwrite yet. Auto-sync is suppressed while
   * this is set so a reconnect can't clobber the cloud backup.
   */
  remoteBackupPending?: boolean;
  restoreInProgress?: boolean;
};

export type GoogleDriveRestoreResult =
  | { ok: true; fileCount: number; bytes: number }
  | { ok: false; error: string };

export type GoogleDriveAuthEvent =
  | { phase: 'pending' }
  | { phase: 'success'; account: GoogleDriveAccount }
  | { phase: 'error'; error: string };

export type GoogleDriveSyncResult =
  | {
      ok: true;
      skipped?: boolean;
      lastSyncedAt?: number;
      bytes?: number;
      fileCount?: number;
    }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// GitHub auto-deploys (Deploys tab)
//
// The github-auto-deploy skill registers every automated deployment in
// /etc/easyhost/deploys/<app>.json on the server, and the redeploy script
// reports transitions through /usr/local/bin/easyhost-notify, which appends
// them to /var/log/easyhost/deploy-events.jsonl (and mirrors ok/failed/rollback
// to Telegram when configured). main/deployments.ts reads both files over SSH.
// ---------------------------------------------------------------------------

/** One line of /var/log/easyhost/deploy-events.jsonl, parsed. */
export type DeployEvent = {
  /** ms epoch (parsed from the ISO timestamp the helper wrote). */
  ts: number;
  app: string;
  /** 'start' | 'ok' | 'failed' | 'rollback' | 'test' — open set, script-defined. */
  status: string;
  message: string;
};

/** One registered auto-deployment (/etc/easyhost/deploys/<app>.json). */
export type DeploymentInfo = {
  app: string;
  /** "owner/repo" when deployed from GitHub. */
  repo?: string;
  branch?: string;
  /** Checkout directory on the server, e.g. /opt/<app>. */
  dir?: string;
  port?: number;
  /** The redeploy script the cron entry runs. */
  script?: string;
  /** Plain-text build/deploy log, e.g. /var/log/<app>-deploy.log. */
  log?: string;
  /** The project's env file (docker --env-file), e.g. /opt/<app>/.env —
   *  editable from the Deploys tab. */
  envFile?: string;
  /** ms epoch, when the automation was set up. */
  createdAt?: number;
  /** Most recent event for this app (also first in `events`). */
  lastEvent?: DeployEvent;
  /** Recent events for this app, newest first. */
  events: DeployEvent[];
};

export type DeploymentsResult =
  | { ok: true; ts: number; deployments: DeploymentInfo[] }
  | { ok: false; error: string };

export type DeployLogResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

/** Raw env-file content. `exists:false` (with empty content) means the file
 *  isn't on disk yet — saving will create it. Values are secrets: they cross
 *  IPC only on this explicit read, same policy as credentialsReveal. */
export type EnvFileReadResult =
  | { ok: true; exists: boolean; content: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Telegram alerting
// ---------------------------------------------------------------------------

/** Which signal a rule watches. `reachability` is driven by SSH connectivity. */
export type AlertMetric = 'reachability' | 'cpu' | 'memory' | 'disk' | 'load';

/**
 * Per-server thresholds. `null` disables that rule. cpu/memory/disk are percent
 * (0–100); load is the absolute 1-minute load average. Defaults favour signal
 * over noise: alert on memory/disk exhaustion, stay quiet on transient CPU.
 */
export type AlertThresholds = {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  load: number | null;
};

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  cpu: null, // transient spikes are normal — off by default
  memory: 90,
  disk: 90,
  load: null,
};

export type ServerAlertConfig = {
  serverId: string;
  enabled: boolean;
  /** Alert when the host stops responding over SSH (your app/server is down). */
  reachability: boolean;
  thresholds: AlertThresholds;
};

/**
 * Global alerting configuration. NON-secret — the bot token lives encrypted in
 * secrets.ts and never appears here or crosses IPC.
 */
export type AlertConfig = {
  chatId: string | null;
  /** Informational, from Telegram getMe. */
  botUsername?: string;
  botName?: string;
  /** Consecutive breaches before an alert fires (anti-noise). */
  failureThreshold: number;
  /** Consecutive healthy checks before an incident is marked resolved. */
  successThreshold: number;
  /** Re-remind interval while an incident is ongoing, in minutes (0 = never). */
  reminderMinutes: number;
  servers: ServerAlertConfig[];
};

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  chatId: null,
  failureThreshold: 3,
  successThreshold: 2,
  reminderMinutes: 30,
  servers: [],
};

/** Alerting state surfaced to the renderer (no token material). */
export type AlertsStatus = {
  hasToken: boolean;
  config: AlertConfig;
};

/** A fired or resolved alert, pushed to the renderer for a live activity log. */
export type AlertEvent = {
  serverId: string;
  serverName: string;
  metric: AlertMetric;
  state: 'firing' | 'resolved';
  message: string;
  value?: number;
  threshold?: number;
  reminder?: boolean;
  ts: number;
};

export type TelegramConnectResult =
  | { ok: true; botUsername?: string; botName?: string }
  | { ok: false; error: string };

export type TelegramTestResult = { ok: true } | { ok: false; error: string };

export type TelegramChatDetectResult =
  | { ok: true; chats: { id: string; title: string }[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// IPC channel names
// ---------------------------------------------------------------------------

export const IPC = {
  // servers (invoke)
  serversList: 'servers:list',
  serversAdd: 'servers:add',
  serversUpdate: 'servers:update',
  serversRemove: 'servers:remove',
  serversTest: 'servers:test',
  // projects (invoke) — local server grouping + per-project agent memory
  projectsList: 'projects:list',
  projectsAdd: 'projects:add',
  projectsUpdate: 'projects:update',
  projectsRemove: 'projects:remove',
  // keys (invoke)
  keysGenerate: 'keys:generate',
  // ssh (invoke)
  sshConnect: 'ssh:connect',
  sshDisconnect: 'ssh:disconnect',
  // terminal (invoke + send)
  termOpen: 'term:open',
  termClose: 'term:close',
  termResize: 'term:resize',
  termInput: 'term:input',
  // monitor (invoke)
  monitorStart: 'monitor:start',
  monitorStop: 'monitor:stop',
  // agent (invoke)
  agentStart: 'agent:start',
  agentCancel: 'agent:cancel',
  agentApprove: 'agent:approve',
  agentRespondForm: 'agent:respond-form',
  agentSteer: 'agent:steer',
  agentModel: 'agent:model',
  // chat history (invoke) — session-based, mirrors FCode's thread list
  chatHistoryList: 'chat-history:list',
  chatHistoryUpsert: 'chat-history:upsert',
  chatHistorySetActive: 'chat-history:set-active',
  chatHistorySetPinned: 'chat-history:set-pinned',
  chatHistoryRename: 'chat-history:rename',
  chatHistoryDelete: 'chat-history:delete',
  // settings (invoke)
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // ai provider keys (invoke) — key travels renderer -> main once, never back
  aiKeySet: 'ai:key-set',
  aiKeyClear: 'ai:key-clear',
  aiKeyStatus: 'ai:key-status',
  // codex (ChatGPT subscription) sign-in (invoke) — tokens never cross back
  codexStatus: 'codex:status',
  codexLogin: 'codex:login',
  codexCancel: 'codex:cancel',
  codexLogout: 'codex:logout',
  // playbooks (invoke)
  playbooksList: 'playbooks:list',
  // artifacts (invoke)
  artifactsScan: 'artifacts:scan',
  artifactsAction: 'artifacts:action',
  artifactsLogs: 'artifacts:logs',
  // github auto-deploys (invoke)
  deploysList: 'deploys:list',
  deploysLog: 'deploys:log',
  deploysEnvRead: 'deploys:env-read',
  deploysEnvWrite: 'deploys:env-write',
  deploysRedeploy: 'deploys:redeploy',
  // database credentials (invoke) — saved by the setup-database wizard, or
  // manually by the user from the Artifacts tab
  credentialsList: 'credentials:list',
  credentialsSave: 'credentials:save',
  credentialsReveal: 'credentials:reveal',
  credentialsDelete: 'credentials:delete',
  credentialsRecoverFromContainer: 'credentials:recover-from-container',
  // github (invoke)
  githubStatus: 'github:status',
  githubDeviceStart: 'github:device-start',
  githubDeviceCancel: 'github:device-cancel',
  githubConnectToken: 'github:connect-token',
  githubDisconnect: 'github:disconnect',
  githubRepos: 'github:repos',
  githubInstallations: 'github:installations',
  githubOpenInstall: 'github:open-install',
  githubAuthorizeServer: 'github:authorize-server',
  githubDeauthorizeServer: 'github:deauthorize-server',
  githubClone: 'github:clone',
  // google drive app-data sync (invoke)
  googleDriveStatus: 'google-drive:status',
  googleDriveLogin: 'google-drive:login',
  googleDriveCancel: 'google-drive:cancel',
  googleDriveDisconnect: 'google-drive:disconnect',
  googleDriveSyncNow: 'google-drive:sync-now',
  googleDriveRestore: 'google-drive:restore',
  googleDriveKeepLocal: 'google-drive:keep-local',
  // alerts / telegram (invoke)
  alertsStatus: 'alerts:status',
  alertsConnectToken: 'alerts:connect-token',
  alertsDisconnect: 'alerts:disconnect',
  alertsDetectChat: 'alerts:detect-chat',
  alertsSetChat: 'alerts:set-chat',
  alertsTest: 'alerts:test',
  alertsSetConfig: 'alerts:set-config',
  alertsSetServer: 'alerts:set-server',

  // events (main -> renderer)
  evtSshStatus: 'ssh:status',
  evtTermData: 'term:data',
  evtTermExit: 'term:exit',
  evtMonitorStats: 'monitor:stats',
  evtAgentEvent: 'agent:event',
  evtGithubAuth: 'github:auth-event',
  evtGoogleDriveAuth: 'google-drive:auth-event',
  evtGoogleDriveStatus: 'google-drive:status-changed',
  evtCodexAuth: 'codex:auth-event',
  evtChatHistory: 'chat-history:changed',
  evtAlert: 'alerts:event',
} as const;

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export type SshStatusEvent = {
  serverId: string;
  status: ConnStatus;
  error?: string;
};
export type TermDataEvent = { sessionId: string; data: string };
export type TermExitEvent = { sessionId: string };
export type MonitorStatsEvent = { serverId: string; stats: ServerStats };
export type AgentEventEnvelope = { runId: string; event: AgentEvent };
/** Pushed whenever the persisted chat history changes (upsert, switch, or delete). */
export type ChatHistoryChangedEvent = ChatHistoryState;

// ---------------------------------------------------------------------------
// Invoke request/response shapes
// ---------------------------------------------------------------------------

export type ServerWithStatus = ServerProfile & { status: ConnStatus };

export type OkResult = { ok: true } | { ok: false; error: string };

/** One steer message injected into a running agent turn (text + attachments). */
export type SteerItem = {
  text: string;
  attachments?: ChatAttachment[];
};

export type AgentStartRequest = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  serverIds?: string[];
  /** Project this chat is tagged to. Hard-scopes the run to the project's
   *  servers and injects the project's memory into the system prompt. */
  projectId?: string | null;
  playbookId?: string;
  playbookValues?: Record<string, string>;
  /** Files/images attached to the final user message — applied to the last
   *  user turn as multimodal content when the model is called. */
  attachments?: ChatAttachment[];
  /** The open session's current task list, sent on a follow-up turn so the
   *  agent continues the same plan instead of forgetting earlier tasks — the
   *  transcript only replays text messages, not todo items. */
  todos?: TodoItem[];
};
