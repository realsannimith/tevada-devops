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
  AiKeyStatus,
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
  CodexAuthEvent,
  CodexStatus,
  ContainerCredentialGuess,
  DatabaseCredential,
  DatabaseCredentialMeta,
  DbColumnsResult,
  DbEditorTarget,
  DbGraphResult,
  DbRunResult,
  DbSelectResult,
  DbTablesResult,
  DbUpdateResult,
  DeployLogResult,
  LogDataEvent,
  LogExitEvent,
  LogStreamOpenResult,
  LogStreamRequest,
  DeploymentsResult,
  EnvFileReadResult,
  OkResult,
  GeneratedKey,
  GoogleDriveAuthEvent,
  GoogleDriveRestoreResult,
  GoogleDriveStatus,
  GoogleDriveSyncResult,
  GithubAuthEvent,
  GithubCloneResult,
  GithubDeviceFlowStart,
  GithubInstallationsResult,
  GithubReposResult,
  GithubStatus,
  IPC,
  McpInstallClient,
  McpInstallResult,
  McpStatus,
  UpdateState,
  MonitorStatsEvent,
  PlaybookMeta,
  TemplateDeployEvent,
  TemplateListRequest,
  TemplateListResult,
  Project,
  SaveDatabaseCredentialRequest,
  ServerAlertConfig,
  ServerProfile,
  ServerSecret,
  ServerWithStatus,
  SftpListResult,
  SftpPathResult,
  SftpReadResult,
  SftpTransferResult,
  SshStatusEvent,
  TunnelState,
  SteerItem,
  TelegramChatDetectResult,
  TelegramConnectResult,
  TelegramTestResult,
  TermDataEvent,
  TermExitEvent,
} from './shared/ipc-types';
import { ProviderId } from './shared/providers';

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

  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projectsList),
    add: (
      project: Pick<Project, 'name' | 'color' | 'memory'>,
    ): Promise<Project> => ipcRenderer.invoke(IPC.projectsAdd, { project }),
    update: (
      id: string,
      patch: Partial<Omit<Project, 'id' | 'createdAt'>>,
    ): Promise<Project | null> =>
      ipcRenderer.invoke(IPC.projectsUpdate, { id, patch }),
    remove: (projectId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.projectsRemove, { projectId }),
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

  sftp: {
    home: (serverId: string): Promise<SftpPathResult> =>
      ipcRenderer.invoke(IPC.sftpHome, { serverId }),
    list: (serverId: string, path: string): Promise<SftpListResult> =>
      ipcRenderer.invoke(IPC.sftpList, { serverId, path }),
    mkdir: (serverId: string, path: string): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.sftpMkdir, { serverId, path }),
    rename: (serverId: string, from: string, to: string): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.sftpRename, { serverId, from, to }),
    remove: (serverId: string, path: string, isDir: boolean): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.sftpDelete, { serverId, path, isDir }),
    read: (serverId: string, path: string): Promise<SftpReadResult> =>
      ipcRenderer.invoke(IPC.sftpRead, { serverId, path }),
    write: (serverId: string, path: string, content: string): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.sftpWrite, { serverId, path, content }),
    download: (
      serverId: string,
      path: string,
      name: string,
    ): Promise<SftpTransferResult> =>
      ipcRenderer.invoke(IPC.sftpDownload, { serverId, path, name }),
    upload: (serverId: string, dir: string): Promise<SftpTransferResult> =>
      ipcRenderer.invoke(IPC.sftpUpload, { serverId, dir }),
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
    respondForm: (
      formId: string,
      values: Record<string, string> | null,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.agentRespondForm, { formId, values }),
    steer: (
      runId: string,
      items: SteerItem[],
    ): Promise<{ accepted: boolean }> =>
      ipcRenderer.invoke(IPC.agentSteer, { runId, items }),
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
    rename: (id: string, title: string): Promise<ChatHistoryState> =>
      ipcRenderer.invoke(IPC.chatHistoryRename, id, title),
    setProject: (id: string, projectId: string | null): Promise<ChatHistoryState> =>
      ipcRenderer.invoke(IPC.chatHistorySetProject, id, projectId),
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

  ai: {
    keyStatus: (): Promise<AiKeyStatus> => ipcRenderer.invoke(IPC.aiKeyStatus),
    setKey: (provider: ProviderId, key: string): Promise<AiKeyStatus> =>
      ipcRenderer.invoke(IPC.aiKeySet, { provider, key }),
    clearKey: (provider: ProviderId): Promise<AiKeyStatus> =>
      ipcRenderer.invoke(IPC.aiKeyClear, { provider }),
  },

  codex: {
    status: (): Promise<CodexStatus> => ipcRenderer.invoke(IPC.codexStatus),
    login: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.codexLogin),
    cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.codexCancel),
    logout: (): Promise<CodexStatus> => ipcRenderer.invoke(IPC.codexLogout),
    onAuthEvent: (cb: (e: CodexAuthEvent) => void) =>
      on<CodexAuthEvent>(IPC.evtCodexAuth, cb),
  },

  playbooks: {
    list: (): Promise<PlaybookMeta[]> => ipcRenderer.invoke(IPC.playbooksList),
  },

  templates: {
    list: (request?: TemplateListRequest): Promise<TemplateListResult> =>
      ipcRenderer.invoke(IPC.templatesList, request),
    deploy: (
      deployId: string,
      serverId: string,
      templateId: string,
    ): Promise<{ deployId: string }> =>
      ipcRenderer.invoke(IPC.templatesDeploy, { deployId, serverId, templateId }),
    cancelDeploy: (deployId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.templatesDeployCancel, { deployId }),
    onDeployEvent: (cb: (e: TemplateDeployEvent) => void) =>
      on<TemplateDeployEvent>(IPC.evtTemplateDeploy, cb),
  },

  artifacts: {
    scan: (serverId: string): Promise<ArtifactsScanResult> =>
      ipcRenderer.invoke(IPC.artifactsScan, { serverId }),
    action: (req: ArtifactActionRequest): Promise<OkResult> =>
      ipcRenderer.invoke(IPC.artifactsAction, req),
    logs: (req: ArtifactLogsRequest): Promise<ArtifactLogsResult> =>
      ipcRenderer.invoke(IPC.artifactsLogs, req),
  },

  // Live log follow. open() resolves with a streamId; every chunk for that
  // stream then arrives on onData until close() or onExit. Used by both the
  // Deploys tab (build logs) and the Artifacts tab (container/unit logs).
  logs: {
    open: (req: LogStreamRequest): Promise<LogStreamOpenResult> =>
      ipcRenderer.invoke(IPC.logsOpen, req),
    close: (serverId: string, streamId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.logsClose, { serverId, streamId }),
    onData: (cb: (e: LogDataEvent) => void) => on<LogDataEvent>(IPC.evtLogData, cb),
    onExit: (cb: (e: LogExitEvent) => void) => on<LogExitEvent>(IPC.evtLogExit, cb),
  },

  // SSH tunnels (local port forwards). save() upserts a config; start()/stop()
  // control the local listener. Full state pushes arrive on onState.
  tunnels: {
    list: (): Promise<TunnelState[]> => ipcRenderer.invoke(IPC.tunnelsList),
    save: (input: {
      id?: string;
      serverId: string;
      name?: string;
      localPort: number;
      remoteHost: string;
      remotePort: number;
    }): Promise<OkResult> => ipcRenderer.invoke(IPC.tunnelsSave, input),
    remove: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.tunnelsRemove, { id }),
    start: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.tunnelsStart, { id }),
    stop: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.tunnelsStop, { id }),
    onState: (cb: (states: TunnelState[]) => void) =>
      on<TunnelState[]>(IPC.evtTunnelState, cb),
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

  // Lightweight database editor (the in-app DB IDE). Every call targets a saved
  // credential by id; the main process runs psql/mysql over SSH to answer.
  db: {
    tables: (target: DbEditorTarget): Promise<DbTablesResult> =>
      ipcRenderer.invoke(IPC.dbTables, { target }),
    columns: (
      target: DbEditorTarget,
      schema: string,
      table: string,
    ): Promise<DbColumnsResult> =>
      ipcRenderer.invoke(IPC.dbColumns, { target, schema, table }),
    select: (
      target: DbEditorTarget,
      schema: string,
      table: string,
      opts?: {
        limit?: number;
        offset?: number;
        orderBy?: { column: string; dir: 'asc' | 'desc' };
      },
    ): Promise<DbSelectResult> =>
      ipcRenderer.invoke(IPC.dbSelect, { target, schema, table, ...opts }),
    query: (target: DbEditorTarget, sql: string): Promise<DbRunResult> =>
      ipcRenderer.invoke(IPC.dbQuery, { target, sql }),
    graph: (target: DbEditorTarget): Promise<DbGraphResult> =>
      ipcRenderer.invoke(IPC.dbGraph, { target }),
    updateCell: (
      target: DbEditorTarget,
      schema: string,
      table: string,
      pk: { column: string; value: string | null }[],
      column: string,
      value: string | null,
    ): Promise<DbUpdateResult> =>
      ipcRenderer.invoke(IPC.dbUpdateCell, { target, schema, table, pk, column, value }),
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

  googleDrive: {
    status: (): Promise<GoogleDriveStatus> =>
      ipcRenderer.invoke(IPC.googleDriveStatus),
    login: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.googleDriveLogin),
    cancel: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.googleDriveCancel),
    disconnect: (): Promise<GoogleDriveStatus> =>
      ipcRenderer.invoke(IPC.googleDriveDisconnect),
    syncNow: (): Promise<GoogleDriveSyncResult> =>
      ipcRenderer.invoke(IPC.googleDriveSyncNow),
    restore: (): Promise<GoogleDriveRestoreResult> =>
      ipcRenderer.invoke(IPC.googleDriveRestore),
    keepLocal: (): Promise<GoogleDriveSyncResult> =>
      ipcRenderer.invoke(IPC.googleDriveKeepLocal),
    onAuthEvent: (cb: (e: GoogleDriveAuthEvent) => void) =>
      on<GoogleDriveAuthEvent>(IPC.evtGoogleDriveAuth, cb),
    onStatusChange: (cb: (s: GoogleDriveStatus) => void) =>
      on<GoogleDriveStatus>(IPC.evtGoogleDriveStatus, cb),
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

  mcp: {
    status: (): Promise<McpStatus> => ipcRenderer.invoke(IPC.mcpStatus),
    start: (port?: number): Promise<McpStatus> =>
      ipcRenderer.invoke(IPC.mcpStart, { port }),
    stop: (): Promise<McpStatus> => ipcRenderer.invoke(IPC.mcpStop),
    install: (client: McpInstallClient): Promise<McpInstallResult> =>
      ipcRenderer.invoke(IPC.mcpInstall, { client }),
    onStatus: (cb: (s: McpStatus) => void) =>
      on<McpStatus>(IPC.evtMcpStatus, cb),
  },
  updates: {
    state: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateState),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateCheck),
    install: (): Promise<UpdateState> => ipcRenderer.invoke(IPC.updateInstall),
    openReleases: (): Promise<void> => ipcRenderer.invoke(IPC.updateOpenReleases),
    onState: (cb: (s: UpdateState) => void) =>
      on<UpdateState>(IPC.evtUpdateState, cb),
  },
};

contextBridge.exposeInMainWorld('easyhost', easyhost);

export type EasyHostAPI = typeof easyhost;
