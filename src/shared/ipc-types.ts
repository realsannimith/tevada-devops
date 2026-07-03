/**
 * Shared IPC types & channel constants — the single source of truth imported by
 * the main process, the preload bridge, and the renderer. No secret material ever
 * appears in these types: credentials cross IPC only once (renderer -> main on
 * add/update) and are never echoed back.
 */

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
};

export const DEFAULT_SETTINGS: AppSettings = {
  approvalMode: false, // full-auto (YOLO) by default, per product decision
  agentMaxSteps: 50,
  pollIntervalMs: 4000,
};

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
  | {
      type: 'tool-start';
      toolCallId: string;
      tool: string;
      args: unknown;
      description?: string;
    }
  | { type: 'tool-log'; toolCallId: string; chunk: string }
  | { type: 'tool-end'; toolCallId: string; result: unknown }
  | {
      type: 'approval-required';
      approvalId: string;
      serverId: string;
      command: string;
      reason: string;
    }
  | { type: 'step'; index: number }
  | { type: 'done'; finalText: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

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
// IPC channel names
// ---------------------------------------------------------------------------

export const IPC = {
  // servers (invoke)
  serversList: 'servers:list',
  serversAdd: 'servers:add',
  serversUpdate: 'servers:update',
  serversRemove: 'servers:remove',
  serversTest: 'servers:test',
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
  agentModel: 'agent:model',
  // settings (invoke)
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  // playbooks (invoke)
  playbooksList: 'playbooks:list',

  // events (main -> renderer)
  evtSshStatus: 'ssh:status',
  evtTermData: 'term:data',
  evtTermExit: 'term:exit',
  evtMonitorStats: 'monitor:stats',
  evtAgentEvent: 'agent:event',
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

// ---------------------------------------------------------------------------
// Invoke request/response shapes
// ---------------------------------------------------------------------------

export type ServerWithStatus = ServerProfile & { status: ConnStatus };

export type OkResult = { ok: true } | { ok: false; error: string };

export type AgentStartRequest = {
  messages: { role: 'user' | 'assistant'; content: string }[];
  serverIds?: string[];
  playbookId?: string;
  playbookValues?: Record<string, string>;
};
