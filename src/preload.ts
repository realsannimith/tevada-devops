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
  AlertEvent,
  AlertsStatus,
  AppSettings,
  ArtifactActionRequest,
  ArtifactLogsRequest,
  ArtifactLogsResult,
  ArtifactsScanResult,
  ChatHistoryChangedEvent,
  ChatHistoryState,
  ChatSession,
  ContainerCredentialGuess,
  DatabaseCredential,
  DatabaseCredentialMeta,
  DeployLogResult,
  DeploymentsResult,
  EnvFileReadResult,
  OkResult,
  GeneratedKey,
  GithubAuthEvent,
  GithubCloneResult,
  GithubDeviceFlowStart,
  GithubInstallationsResult,
  GithubReposResult,
  GithubStatus,
  IPC,
  MonitorStatsEvent,
  PlaybookMeta,
  SaveDatabaseCredentialRequest,
  ServerAlertConfig,
  ServerProfile,
  ServerSecret,
  ServerWithStatus,
  SshStatusEvent,
  TelegramChatDetectResult,
  TelegramConnectResult,
  TelegramTestResult,
  TermDataEvent,
  TermExitEvent,
} from './shared/ipc-types';

type AlertConfigPatch = Partial<{
  chatId: string | null;
  failureThreshold: number;
  successThreshold: number;
  reminderMinutes: number;
}>;

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

  chatHistory: {
    list: (): Promise<ChatHistoryState> => ipcRenderer.invoke(IPC.chatHistoryList),
    upsert: (session: ChatSession): Promise<ChatHistoryState> =>
      ipcRenderer.invoke(IPC.chatHistoryUpsert, session),
    setActive: (id: string | null): Promise<ChatHistoryState> =>
      ipcRenderer.invoke(IPC.chatHistorySetActive, id),
    setPinned: (id: string, pinned: boolean): Promise<ChatHistoryState> =>
      ipcRenderer.invoke(IPC.chatHistorySetPinned, id, pinned),
    delete: (id: string): Promise<ChatHistoryState> =>
      ipcRenderer.invoke(IPC.chatHistoryDelete, id),
    onChanged: (cb: (state: ChatHistoryChangedEvent) => void) =>
      on<ChatHistoryChangedEvent>(IPC.evtChatHistory, cb),
  },

  settings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (patch: Partial<AppSettings>): Promise<AppSettings> =>
      ipcRenderer.invoke(IPC.settingsSet, patch),
  },

  playbooks: {
    list: (): Promise<PlaybookMeta[]> => ipcRenderer.invoke(IPC.playbooksList),
  },

  artifacts: {
    scan: (serverId: string): Promise<ArtifactsScanResult> =>
      ipcRenderer.invoke(IPC.artifactsScan, { serverId }),
    action: (req: ArtifactActionRequest): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.artifactsAction, req),
    logs: (req: ArtifactLogsRequest): Promise<ArtifactLogsResult> =>
      ipcRenderer.invoke(IPC.artifactsLogs, req),
  },

  deploys: {
    list: (serverId: string): Promise<DeploymentsResult> =>
      ipcRenderer.invoke(IPC.deploysList, { serverId }),
    log: (serverId: string, logPath: string): Promise<DeployLogResult> =>
      ipcRenderer.invoke(IPC.deploysLog, { serverId, logPath }),
    envRead: (serverId: string, envPath: string): Promise<EnvFileReadResult> =>
      ipcRenderer.invoke(IPC.deploysEnvRead, { serverId, envPath }),
    envWrite: (
      serverId: string,
      envPath: string,
      content: string,
    ): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.deploysEnvWrite, { serverId, envPath, content }),
    redeploy: (serverId: string, scriptPath: string): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.deploysRedeploy, { serverId, scriptPath }),
  },

  credentials: {
    list: (serverId: string): Promise<DatabaseCredentialMeta[]> =>
      ipcRenderer.invoke(IPC.credentialsList, { serverId }),
    save: (
      input: SaveDatabaseCredentialRequest,
    ): Promise<DatabaseCredentialMeta> =>
      ipcRenderer.invoke(IPC.credentialsSave, input),
    reveal: (id: string): Promise<DatabaseCredential | null> =>
      ipcRenderer.invoke(IPC.credentialsReveal, { id }),
    delete: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.credentialsDelete, { id }),
    recoverFromContainer: (
      serverId: string,
      containerName: string,
      engine: string,
    ): Promise<ContainerCredentialGuess | null> =>
      ipcRenderer.invoke(IPC.credentialsRecoverFromContainer, {
        serverId,
        containerName,
        engine,
      }),
  },

  github: {
    status: (): Promise<GithubStatus> => ipcRenderer.invoke(IPC.githubStatus),
    startDeviceFlow: (): Promise<GithubDeviceFlowStart> =>
      ipcRenderer.invoke(IPC.githubDeviceStart),
    cancelDeviceFlow: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.githubDeviceCancel),
    connectWithToken: (token: string): Promise<GithubStatus> =>
      ipcRenderer.invoke(IPC.githubConnectToken, { token }),
    disconnect: (): Promise<GithubStatus> =>
      ipcRenderer.invoke(IPC.githubDisconnect),
    repos: (): Promise<GithubReposResult> => ipcRenderer.invoke(IPC.githubRepos),
    installations: (): Promise<GithubInstallationsResult> =>
      ipcRenderer.invoke(IPC.githubInstallations),
    openInstall: (installationId?: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.githubOpenInstall, { installationId }),
    authorizeServer: (serverId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.githubAuthorizeServer, { serverId }),
    deauthorizeServer: (serverId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.githubDeauthorizeServer, { serverId }),
    clone: (
      serverId: string,
      repoFullName: string,
      destPath?: string,
    ): Promise<GithubCloneResult> =>
      ipcRenderer.invoke(IPC.githubClone, { serverId, repoFullName, destPath }),
    onAuthEvent: (cb: (e: GithubAuthEvent) => void) =>
      on<GithubAuthEvent>(IPC.evtGithubAuth, cb),
  },

  alerts: {
    status: (): Promise<AlertsStatus> => ipcRenderer.invoke(IPC.alertsStatus),
    connectToken: (token: string): Promise<TelegramConnectResult> =>
      ipcRenderer.invoke(IPC.alertsConnectToken, { token }),
    disconnect: (): Promise<AlertsStatus> =>
      ipcRenderer.invoke(IPC.alertsDisconnect),
    detectChat: (): Promise<TelegramChatDetectResult> =>
      ipcRenderer.invoke(IPC.alertsDetectChat),
    setChat: (chatId: string | null): Promise<AlertsStatus> =>
      ipcRenderer.invoke(IPC.alertsSetChat, { chatId }),
    test: (): Promise<TelegramTestResult> => ipcRenderer.invoke(IPC.alertsTest),
    setConfig: (patch: AlertConfigPatch): Promise<AlertsStatus> =>
      ipcRenderer.invoke(IPC.alertsSetConfig, patch),
    setServer: (config: ServerAlertConfig): Promise<AlertsStatus> =>
      ipcRenderer.invoke(IPC.alertsSetServer, config),
    onEvent: (cb: (e: AlertEvent) => void) =>
      on<AlertEvent>(IPC.evtAlert, cb),
  },
};

contextBridge.exposeInMainWorld('easyhost', easyhost);

export type EasyHostAPI = typeof easyhost;
