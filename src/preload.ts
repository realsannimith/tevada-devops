/**
 * Preload bridge. Exposes a single, safe `window.easyhost` API to the renderer.
 * The renderer never sees the API key, the AI SDK, ssh2, or any secret material —
 * it only sends structured requests and subscribes to event streams over IPC.
 *
 * Every `onX(cb)` returns an unsubscribe function.
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  AgentEventEnvelope,
  AgentStartRequest,
  AppSettings,
  GeneratedKey,
  IPC,
  MonitorStatsEvent,
  PlaybookMeta,
  ServerProfile,
  ServerSecret,
  ServerWithStatus,
  SshStatusEvent,
  TermDataEvent,
  TermExitEvent,
} from './shared/ipc-types';

type Unsubscribe = () => void;

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

type NewProfile = Omit<ServerProfile, 'id' | 'createdAt'>;

const easyhost = {
  servers: {
    list: (): Promise<ServerWithStatus[]> =>
      ipcRenderer.invoke(IPC.serversList),
    add: (profile: NewProfile, secret: ServerSecret): Promise<ServerWithStatus> =>
      ipcRenderer.invoke(IPC.serversAdd, { profile, secret }),
    update: (
      id: string,
      profile: Partial<NewProfile>,
      secret?: ServerSecret,
    ): Promise<ServerWithStatus | null> =>
      ipcRenderer.invoke(IPC.serversUpdate, { id, profile, secret }),
    remove: (serverId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.serversRemove, { serverId }),
    test: (
      profile: NewProfile,
      secret: ServerSecret,
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.serversTest, { profile, secret }),
  },

  keys: {
    generate: (comment?: string): Promise<GeneratedKey> =>
      ipcRenderer.invoke(IPC.keysGenerate, { comment }),
  },

  ssh: {
    connect: (serverId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.sshConnect, { serverId }),
    disconnect: (serverId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.sshDisconnect, { serverId }),
    onStatus: (cb: (e: SshStatusEvent) => void) =>
      on<SshStatusEvent>(IPC.evtSshStatus, cb),
  },

  term: {
    open: (
      serverId: string,
      cols: number,
      rows: number,
    ): Promise<{ sessionId: string }> =>
      ipcRenderer.invoke(IPC.termOpen, { serverId, cols, rows }),
    close: (serverId: string, sessionId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.termClose, { serverId, sessionId }),
    input: (serverId: string, sessionId: string, data: string): void =>
      ipcRenderer.send(IPC.termInput, { serverId, sessionId, data }),
    resize: (
      serverId: string,
      sessionId: string,
      cols: number,
      rows: number,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.termResize, { serverId, sessionId, cols, rows }),
    onData: (cb: (e: TermDataEvent) => void) =>
      on<TermDataEvent>(IPC.evtTermData, cb),
    onExit: (cb: (e: TermExitEvent) => void) =>
      on<TermExitEvent>(IPC.evtTermExit, cb),
  },

  monitor: {
    start: (serverId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.monitorStart, { serverId }),
    stop: (serverId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.monitorStop, { serverId }),
    onStats: (cb: (e: MonitorStatsEvent) => void) =>
      on<MonitorStatsEvent>(IPC.evtMonitorStats, cb),
  },

  agent: {
    start: (req: AgentStartRequest): Promise<{ runId: string }> =>
      ipcRenderer.invoke(IPC.agentStart, req),
    cancel: (runId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.agentCancel, { runId }),
    approve: (approvalId: string, approved: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.agentApprove, { approvalId, approved }),
    model: (): Promise<string> => ipcRenderer.invoke(IPC.agentModel),
    onEvent: (cb: (e: AgentEventEnvelope) => void) =>
      on<AgentEventEnvelope>(IPC.evtAgentEvent, cb),
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
  },

  playbooks: {
    list: (): Promise<PlaybookMeta[]> => ipcRenderer.invoke(IPC.playbooksList),
  },
};

contextBridge.exposeInMainWorld('easyhost', easyhost);

export type EasyHostAPI = typeof easyhost;
