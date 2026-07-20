/**
 * Registers every ipcMain handler and wires the store, secrets, connection
 * manager, monitor and agent together. Called once after app.whenReady().
 */
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import {
  AgentEvent,
  AgentStartRequest,
  AlertConfig,
  AppSettings,
  McpInstallClient,
  ArtifactActionRequest,
  ArtifactLogsRequest,
  ChatSession,
  IPC,
  LOCAL_SERVER_ID,
  LogStreamRequest,
  Project,
  SteerItem,
  SaveDatabaseCredentialRequest,
  DbEditorTarget,
  ServerAlertConfig,
  ServerProfile,
  ServerSecret,
  ServerWithStatus,
  TemplateDeployRequest,
  TemplateListRequest,
  TemplateMeta,
} from '../shared/ipc-types';
import * as store from './store';
import * as secrets from './secrets';
import * as credentials from './credentials';
import * as dbQuery from './db-query';
import * as github from './github';
import * as googleDriveSync from './googleDriveSync';
import * as alerts from './alerts';
import { AlertEngine } from './alerts';
import * as deployments from './deployments';
import { startLogStream } from './logStream';
import { TunnelManager, validateTunnelInput } from './tunnels';
import { ConnectionManager, posixJoin, type ExecOptions } from './connection-manager';
import {
  localExec,
  localReadFile,
  localServerEntry,
  localWriteFile,
} from './local-runtime';
import * as knownHosts from './knownHosts';
import { Monitor } from './monitor';
import {
  readArtifactLogs,
  runArtifactAction,
  scanArtifacts,
} from './artifacts';
import {
  buildProjectContext,
  buildWorkspaceContext,
  cancelAgentRun,
  cancelAllRuns,
  startAgentRun,
  steerAgentRun,
} from '../agent/agent';
import * as aiKeys from './aiKeys';
import * as codexAuth from './codexAuth';
import { TevadaMcpServer } from './mcpServer';
import { installMcpClient } from './mcpInstall';
import { AppUpdater } from './updater';
import { isProviderId, ProviderId } from '../shared/providers';
import { AgentToolContext } from '../agent/tools';
import { loadSkills } from '../agent/skills';
import { buildModelMessages } from '../agent/attachments';
import {
  databaseWizardTarget,
  DatabaseWizardTarget,
  getPlaybook,
  playbookMeta,
} from '../agent/playbooks';
import { consumePendingKey, peekPendingKey, generateKeyPair } from './keygen';
import {
  buildTemplatePrompt,
  fetchTemplateFiles,
  generateHash,
  listTemplatePage,
  listTemplates,
  processTemplate,
} from './templates';
import { TemplateDeployManager } from './template-deploy';

let runCounter = 0;
let sessionCounter = 0;
let approvalCounter = 0;
let formCounter = 0;

// Pending approval promises, keyed by approvalId. The runId is tracked so a
// cancelled run can resolve (deny) any approval it was blocked on, instead of
// leaking the resolver and suspending the tool's async frame forever.
const pendingApprovals = new Map<
  string,
  { runId: string; resolve: (approved: boolean) => void }
>();
// Pending form promises, keyed by formId — resolved with the user's values
// (or null on cancel/run-cancel) when they submit the in-chat form.
const pendingForms = new Map<
  string,
  { runId: string; resolve: (values: Record<string, string> | null) => void }
>();

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  // Sessions saved mid-run in a previous app life can't still be running.
  store.markInterruptedChatSessions();

  const cm = new ConnectionManager({
    onStatus: (serverId, status, error) =>
      send(IPC.evtSshStatus, { serverId, status, error }),
    onShellData: (sessionId, data) =>
      send(IPC.evtTermData, { sessionId, data }),
    onShellExit: (sessionId) => send(IPC.evtTermExit, { sessionId }),
    onLogData: (streamId, chunk) => send(IPC.evtLogData, { streamId, chunk }),
    onLogExit: (streamId, error) => send(IPC.evtLogExit, { streamId, error }),
  });

  const monitor = new Monitor(cm, (serverId, stats) =>
    send(IPC.evtMonitorStats, { serverId, stats }),
  );

  const withStatus = (p: ServerProfile): ServerWithStatus => ({
    ...p,
    status: cm.getStatus(p.id),
  });

  /**
   * Swap an in-app keyRef for the stashed private key (kept out of the renderer).
   * `consume` defaults to true (used when saving); Test connection passes false so
   * the generated key survives the test and is still there to save afterwards.
   */
  const resolveSecret = (secret: ServerSecret, consume = true): ServerSecret => {
    if (!secret.keyRef) return secret;
    const privateKey = consume
      ? consumePendingKey(secret.keyRef)
      : peekPendingKey(secret.keyRef);
    const rest = { ...secret };
    delete rest.keyRef;
    return { ...rest, privateKey: privateKey ?? secret.privateKey };
  };

  /** Load the stored secret and connect. Shared by ssh:connect and the agent. */
  const connectServer = async (serverId: string) => {
    const profile = store.getServer(serverId);
    const fail = (error: string) => {
      console.warn('[ssh] connect failed', { serverId, error });
      send(IPC.evtSshStatus, { serverId, status: 'error', error });
      return { ok: false, error };
    };
    if (!profile) return fail('Unknown server.');
    const secret = secrets.loadSecret(serverId);
    if (!secret) {
      return fail(
        'Saved credentials could not be read. Re-enter the password or SSH key for this server.',
      );
    }
    const result = await cm.connect(profile, secret);
    if (!result.ok) {
      console.warn('[ssh] connect failed', {
        serverId,
        host: profile.host,
        error: result.error,
      });
    }
    return result;
  };

  // SSH tunnels: local listeners forwarding through the managed connections.
  const tunnels = new TunnelManager({
    cm,
    connect: connectServer,
    listConfigs: () => store.listTunnels(),
    emit: (states) => send(IPC.evtTunnelState, states),
  });

  // Dokploy-style deterministic template deploys (no AI in the loop).
  const templateDeploys = new TemplateDeployManager({
    cm,
    connect: connectServer,
    getServer: (id) => store.getServer(id),
    send: (event) => send(IPC.evtTemplateDeploy, event),
  });

  // Let github.ts re-push rotated GitHub App tokens to authorized servers in
  // the background (it never owns SSH connections itself).
  github.bindRuntime({ cm, connect: connectServer });
  const stopGoogleDriveAutoSync = googleDriveSync.startAutoSync();

  // Background alert engine: supervises connections + pollers for alert-enabled
  // servers and delivers Telegram alerts. Runs for the whole app lifetime,
  // independent of which view is open (see alerts.ts).
  const alertEngine = new AlertEngine({
    cm,
    monitor,
    connect: connectServer,
    getConfig: () => store.getAlertConfig(),
    getToken: () => alerts.loadToken(),
    getServerName: (id) => store.getServer(id)?.name ?? id,
    pollIntervalMs: () => store.getSettings().pollIntervalMs,
    emit: (event) => send(IPC.evtAlert, event),
  });
  alertEngine.start();

  // --- servers -------------------------------------------------------------

  ipcMain.handle(IPC.serversList, () => store.listServers().map(withStatus));

  ipcMain.handle(
    IPC.serversAdd,
    (_e, arg: { profile: Omit<ServerProfile, 'id' | 'createdAt'>; secret: ServerSecret }) => {
      const id = `srv_${Date.now()}_${Math.floor(runCounter++)}`;
      const profile: ServerProfile = {
        ...arg.profile,
        id,
        createdAt: Date.now(),
      };
      secrets.saveSecret(id, resolveSecret(arg.secret));
      store.addServer(profile);
      return withStatus(profile);
    },
  );

  ipcMain.handle(
    IPC.serversUpdate,
    (
      _e,
      arg: {
        id: string;
        profile: Partial<Omit<ServerProfile, 'id' | 'createdAt'>>;
        secret?: ServerSecret;
      },
    ) => {
      const updated = store.updateServer(arg.id, arg.profile);
      if (arg.secret) secrets.saveSecret(arg.id, resolveSecret(arg.secret));
      return updated ? withStatus(updated) : null;
    },
  );

  ipcMain.handle(IPC.serversRemove, (_e, arg: { serverId: string }) => {
    // Forget the pinned host key too, so re-adding a rebuilt server at the same
    // address trusts its new key on first connect instead of hard-failing.
    const removed = store.getServer(arg.serverId);
    tunnels.stopForServer(arg.serverId);
    store.removeTunnelsForServer(arg.serverId);
    cm.disconnect(arg.serverId);
    monitor.stop(arg.serverId);
    secrets.deleteSecret(arg.serverId);
    credentials.deleteDatabaseCredentialsForServer(arg.serverId);
    store.removeServerAlertConfig(arg.serverId);
    alertEngine.clearServer(arg.serverId);
    store.removeServer(arg.serverId);
    if (removed) knownHosts.forgetHost(removed.host, removed.port);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.serversTest,
    async (
      _e,
      arg: { profile: Omit<ServerProfile, 'id' | 'createdAt'>; secret: ServerSecret },
    ) => {
      const profile: ServerProfile = {
        ...arg.profile,
        id: 'test',
        createdAt: Date.now(),
      };
      return cm.testConnection(profile, resolveSecret(arg.secret, false));
    },
  );

  // --- projects ------------------------------------------------------------

  ipcMain.handle(IPC.projectsList, () => store.listProjects());

  ipcMain.handle(
    IPC.projectsAdd,
    (_e, arg: { project: Pick<Project, 'name' | 'color' | 'memory'> }) => {
      const now = Date.now();
      const project: Project = {
        id: `prj_${now}_${Math.floor(runCounter++)}`,
        name: arg.project.name,
        color: arg.project.color,
        memory: arg.project.memory,
        createdAt: now,
        updatedAt: now,
      };
      return store.addProject(project);
    },
  );

  ipcMain.handle(
    IPC.projectsUpdate,
    (
      _e,
      arg: { id: string; patch: Partial<Omit<Project, 'id' | 'createdAt'>> },
    ) => store.updateProject(arg.id, arg.patch) ?? null,
  );

  ipcMain.handle(IPC.projectsRemove, (_e, arg: { projectId: string }) => {
    store.removeProject(arg.projectId);
    return { ok: true };
  });

  // --- keys ----------------------------------------------------------------

  ipcMain.handle(IPC.keysGenerate, (_e, arg: { comment?: string }) =>
    generateKeyPair(arg?.comment ?? 'tevada-devops'),
  );

  // --- ssh -----------------------------------------------------------------

  ipcMain.handle(IPC.sshConnect, (_e, arg: { serverId: string }) =>
    connectServer(arg.serverId),
  );

  ipcMain.handle(IPC.sshDisconnect, (_e, arg: { serverId: string }) => {
    monitor.stop(arg.serverId);
    cm.disconnect(arg.serverId);
    return { ok: true };
  });

  // --- terminal ------------------------------------------------------------

  ipcMain.handle(
    IPC.termOpen,
    async (_e, arg: { serverId: string; cols: number; rows: number }) => {
      const sessionId = `sess_${Date.now()}_${sessionCounter++}`;
      await cm.openShell(arg.serverId, sessionId, {
        cols: arg.cols,
        rows: arg.rows,
      });
      return { sessionId };
    },
  );

  ipcMain.handle(
    IPC.termClose,
    (_e, arg: { serverId: string; sessionId: string }) => {
      cm.closeShell(arg.serverId, arg.sessionId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.termResize,
    (
      _e,
      arg: { serverId: string; sessionId: string; cols: number; rows: number },
    ) => {
      cm.resizeShell(arg.serverId, arg.sessionId, arg.cols, arg.rows);
      return { ok: true };
    },
  );

  ipcMain.on(
    IPC.termInput,
    (_e, arg: { serverId: string; sessionId: string; data: string }) => {
      cm.writeShell(arg.serverId, arg.sessionId, arg.data);
    },
  );

  // --- sftp file browser (Files tab) ---------------------------------------
  // Surfaces the same lazily-opened SFTP session the agent uses. Uploads and
  // downloads pick the local path through the OS-native dialog (main-only), so
  // the renderer never touches the filesystem directly. All remote paths are
  // POSIX regardless of the desktop platform.

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  ipcMain.handle(IPC.sftpHome, async (_e, arg: { serverId: string }) => {
    try {
      return { ok: true as const, path: await cm.sftpRealpath(arg.serverId, '.') };
    } catch (e) {
      return { ok: false as const, error: errMsg(e) };
    }
  });

  ipcMain.handle(
    IPC.sftpList,
    async (_e, arg: { serverId: string; path: string }) => {
      try {
        const { path, entries } = await cm.sftpList(arg.serverId, arg.path);
        return { ok: true as const, path, entries };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.sftpMkdir,
    async (_e, arg: { serverId: string; path: string }) => {
      try {
        await cm.sftpMkdir(arg.serverId, arg.path);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.sftpRename,
    async (_e, arg: { serverId: string; from: string; to: string }) => {
      try {
        await cm.sftpRename(arg.serverId, arg.from, arg.to);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.sftpDelete,
    async (_e, arg: { serverId: string; path: string; isDir: boolean }) => {
      try {
        await cm.sftpDelete(arg.serverId, arg.path, arg.isDir);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  // Read cap for the built-in text editor. Files above this are opened
  // truncated (read-only in the UI) so we never pull a huge/binary blob into
  // the renderer.
  const SFTP_EDIT_MAX_BYTES = 512 * 1024;

  ipcMain.handle(
    IPC.sftpRead,
    async (_e, arg: { serverId: string; path: string }) => {
      try {
        const res = await cm.sftpReadFile(arg.serverId, arg.path, SFTP_EDIT_MAX_BYTES);
        return { ok: true as const, ...res };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.sftpWrite,
    async (_e, arg: { serverId: string; path: string; content: string }) => {
      try {
        await cm.sftpWriteFile(arg.serverId, arg.path, arg.content);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.sftpDownload,
    async (_e, arg: { serverId: string; path: string; name: string }) => {
      const win = getWindow();
      const opts = { defaultPath: arg.name };
      const res = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) {
        return { ok: true as const, canceled: true, count: 0 };
      }
      try {
        await cm.sftpFastGet(arg.serverId, arg.path, res.filePath);
        return { ok: true as const, count: 1 };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  ipcMain.handle(
    IPC.sftpUpload,
    async (_e, arg: { serverId: string; dir: string }) => {
      const win = getWindow();
      const opts = {
        properties: ['openFile', 'multiSelections'] as Array<
          'openFile' | 'multiSelections'
        >,
      };
      const res = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (res.canceled || res.filePaths.length === 0) {
        return { ok: true as const, canceled: true, count: 0 };
      }
      try {
        let count = 0;
        for (const local of res.filePaths) {
          await cm.sftpFastPut(
            arg.serverId,
            local,
            posixJoin(arg.dir, basename(local)),
          );
          count++;
        }
        return { ok: true as const, count };
      } catch (e) {
        return { ok: false as const, error: errMsg(e) };
      }
    },
  );

  // --- monitor -------------------------------------------------------------

  ipcMain.handle(IPC.monitorStart, (_e, arg: { serverId: string }) => {
    monitor.start(arg.serverId, store.getSettings().pollIntervalMs);
    return { ok: true };
  });

  ipcMain.handle(IPC.monitorStop, (_e, arg: { serverId: string }) => {
    monitor.stop(arg.serverId);
    return { ok: true };
  });

  // --- agent ---------------------------------------------------------------

  ipcMain.handle(IPC.agentStart, async (_e, arg: AgentStartRequest) => {
    const runId = `run_${Date.now()}_${runCounter++}`;
    const settings = store.getSettings();

    // Safety net for the setup-database wizard: the model is instructed to
    // call saveDatabaseCredential itself, but LLM tool compliance isn't
    // guaranteed. If it generates exactly one password during the run and
    // never saves a credential explicitly, we save it ourselves once the run
    // ends, using the connection details the wizard's own form already fixed
    // (engine/port/database/username) — nothing here is guessed.
    let explicitCredentialSaved = false;
    let generatedPasswords: string[] = [];
    let autoSaveTarget: DatabaseWizardTarget | undefined;
    let autoSaveServerId: string | undefined;
    // enable-db-remote-access never touches the password or the internal host —
    // on success it just attaches the server's public IP as the external
    // endpoint, so both local and remote addresses show under Credentials.
    let externalHostTarget: { serverId: string; engine: string; port: number } | undefined;
    let sawErrorDuringRun = false;

    const maybeAutoSaveDatabaseCredential = () => {
      if (
        explicitCredentialSaved ||
        !autoSaveTarget ||
        !autoSaveServerId ||
        generatedPasswords.length !== 1
      ) {
        return;
      }
      explicitCredentialSaved = true; // guard: 'done' can still be followed by other terminal events
      const server = store.getServer(autoSaveServerId);
      credentials.saveDatabaseCredential({
        serverId: autoSaveServerId,
        engine: autoSaveTarget.engine,
        host: '127.0.0.1',
        externalHost: autoSaveTarget.remote ? server?.host : undefined,
        port: autoSaveTarget.port,
        database: autoSaveTarget.database,
        username: autoSaveTarget.username,
        password: generatedPasswords[0],
      });
    };

    const maybeAttachExternalHost = () => {
      if (!externalHostTarget || sawErrorDuringRun) return;
      const server = store.getServer(externalHostTarget.serverId);
      if (!server) return;
      credentials.setDatabaseCredentialExternalHost(
        externalHostTarget.serverId,
        externalHostTarget.engine,
        externalHostTarget.port,
        server.host,
      );
    };

    const emit = (event: AgentEvent) => {
      send(IPC.evtAgentEvent, { runId, event });
      if (event.type === 'error') sawErrorDuringRun = true;
      if (event.type === 'done' || event.type === 'error' || event.type === 'cancelled') {
        maybeAutoSaveDatabaseCredential();
      }
      if (event.type === 'done') maybeAttachExternalHost();
    };

    // Project scoping: a chat tagged to a project may only see/operate on that
    // project's servers, and the project's memory is injected into the prompt.
    const project = arg.projectId ? store.getProject(arg.projectId) : undefined;
    const allowedServerIds = project
      ? new Set(store.listServerIdsForProject(project.id))
      : undefined;
    const projectContext = project
      ? buildProjectContext({
          name: project.name,
          memory: project.memory,
          serverNames: store
            .listServers()
            .filter((s) => allowedServerIds!.has(s.id))
            .map((s) => s.name),
        })
      : buildWorkspaceContext({
          projects: store.listProjects().map((p) => {
            const memberIds = new Set(store.listServerIdsForProject(p.id));
            return {
              name: p.name,
              memory: p.memory,
              serverNames: store
                .listServers()
                .filter((s) => memberIds.has(s.id))
                .map((s) => s.name),
            };
          }),
          unassignedServerNames: store
            .listServers()
            .filter((s) => !s.projectIds || s.projectIds.length === 0)
            .map((s) => s.name),
        });

    // "This Mac" target: routes the local-mac pseudo server to the local
    // runtime (child_process + fs); everything else stays on SSH. Only exists
    // when the user enabled it in Settings, and never inside a project scope.
    const localAllowed = settings.agentLocalEnabled === true && !project;
    const agentRuntime = {
      exec: (serverId: string, command: string, opts?: ExecOptions) =>
        serverId === LOCAL_SERVER_ID
          ? localAllowed
            ? localExec(command, opts)
            : Promise.reject(
                new Error('Running on this Mac is disabled in Settings.'),
              )
          : cm.exec(serverId, command, opts),
      sftpWriteFile: (serverId: string, filePath: string, content: string) =>
        serverId === LOCAL_SERVER_ID
          ? localAllowed
            ? localWriteFile(filePath, content)
            : Promise.reject(
                new Error('Running on this Mac is disabled in Settings.'),
              )
          : cm.sftpWriteFile(serverId, filePath, content),
      sftpReadFile: (serverId: string, filePath: string, maxBytes?: number) =>
        serverId === LOCAL_SERVER_ID
          ? localAllowed
            ? localReadFile(filePath, maxBytes)
            : Promise.reject(
                new Error('Running on this Mac is disabled in Settings.'),
              )
          : cm.sftpReadFile(serverId, filePath, maxBytes),
    };
    const localRow: ServerWithStatus | null = localAllowed
      ? {
          id: LOCAL_SERVER_ID,
          port: 0,
          authType: 'password',
          createdAt: 0,
          ...localServerEntry(),
        }
      : null;
    const localTargetContext = localAllowed
      ? '\n\nA special target "This Mac" (serverId "local-mac") is available: it is the user\'s OWN computer (macOS), and commands on it run locally, not over SSH. When targeting it: use macOS tooling (brew, launchctl, ~/Library paths — not apt/systemctl), NEVER use sudo (there is no interactive password prompt; if root is truly required, give the user that one command to run themselves), and be conservative — this is the user\'s personal machine, not a disposable server. Only touch it when the user explicitly asks for their Mac/local machine.'
      : '';

    const toolContext: AgentToolContext = {
      cm: agentRuntime,
      approvalMode: settings.approvalMode,
      allowedServerIds,
      listServers: () => [
        ...store
          .listServers()
          .filter((s) => !allowedServerIds || allowedServerIds.has(s.id))
          .map(withStatus),
        ...(localRow ? [localRow] : []),
      ],
      connect: (serverId) =>
        serverId === LOCAL_SERVER_ID && localAllowed
          ? Promise.resolve({ ok: true })
          : connectServer(serverId),
      getStats: (serverId) => monitor.getLatest(serverId),
      emit,
      requestApproval: (serverId, command, reason) =>
        new Promise<boolean>((resolve) => {
          const approvalId = `appr_${Date.now()}_${approvalCounter++}`;
          pendingApprovals.set(approvalId, { runId, resolve });
          emit({
            type: 'approval-required',
            approvalId,
            serverId,
            command,
            reason,
          });
        }),
      requestForm: (spec) =>
        new Promise<Record<string, string> | null>((resolve) => {
          const formId = `form_${Date.now()}_${formCounter++}`;
          pendingForms.set(formId, { runId, resolve });
          emit({ type: 'form-required', form: { ...spec, formId } });
        }),
      saveDatabaseCredential: (input) => {
        explicitCredentialSaved = true;
        return credentials.saveDatabaseCredential(input);
      },
      onPasswordGenerated: (password) => {
        generatedPasswords = [...generatedPasswords, password];
      },
      listGithubRepos: () => github.listRepos(),
      githubAuthorizedServerIds: () =>
        store.getGithubAccount()?.authorizedServerIds ?? [],
      setupDeployNotifications: (serverId) => {
        // Token + chat come straight from the alert config here in main; the
        // agent only ever sees ok/telegramConfigured.
        const token = alerts.loadToken();
        const chatId = store.getAlertConfig().chatId;
        return deployments.provisionDeployNotifications(
          cm,
          serverId,
          token && chatId ? { token, chatId } : undefined,
        );
      },
      writeS3Credentials: async ({ serverId, purpose, values }) => {
        // Secret access keys go main -> server directly (root-only, mode 600),
        // never back through the model. Same trust boundary as the Telegram
        // token above.
        const conn = await connectServer(serverId);
        if (!conn.ok) return { ok: false, error: conn.error ?? 'connect failed' };
        const envPath = `/etc/easyhost/s3-${
          purpose === 'backups' ? 'backups' : 'uploads'
        }.env`;
        const content =
          [
            `AWS_ACCESS_KEY_ID=${values.accessKeyId ?? ''}`,
            `AWS_SECRET_ACCESS_KEY=${values.secretAccessKey ?? ''}`,
            `AWS_DEFAULT_REGION=${values.region || 'us-east-1'}`,
            `S3_BUCKET=${values.bucket ?? ''}`,
            `S3_ENDPOINT=${values.endpoint ?? ''}`,
          ].join('\n') + '\n';
        const tmp = `/tmp/easyhost-s3-${Date.now()}.env`;
        try {
          await cm.sftpWriteFile(serverId, tmp, content);
          const res = await cm.exec(
            serverId,
            `sudo mkdir -p /etc/easyhost && sudo mv ${tmp} ${envPath} && sudo chmod 600 ${envPath} && sudo chown root:root ${envPath} && echo done`,
            { timeoutMs: 30000 },
          );
          if (res.exitCode !== 0) {
            void cm.exec(serverId, `rm -f ${tmp}`, { timeoutMs: 5000 }).catch(
              (): void => {},
            );
            return {
              ok: false,
              error: res.stderr?.trim() || 'failed to write credentials file',
            };
          }
          return { ok: true, envPath };
        } catch (err) {
          void cm.exec(serverId, `rm -f ${tmp}`, { timeoutMs: 5000 }).catch(
            (): void => {},
          );
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    };

    // Build the seed messages. A playbook run turns answers into a prompt.
    let messages: { role: 'user' | 'assistant'; content: string }[] =
      arg.messages;
    if (arg.playbookId) {
      const pb = getPlaybook(arg.playbookId);
      const serverId = arg.serverIds?.[0];
      const serverName = serverId
        ? store.getServer(serverId)?.name ?? serverId
        : 'the target server';
      if (pb) {
        messages = [
          {
            role: 'user',
            content: pb.buildPrompt(arg.playbookValues ?? {}, serverName),
          },
        ];
      }
      if (arg.playbookId === 'setup-database' && serverId) {
        autoSaveServerId = serverId;
        autoSaveTarget = databaseWizardTarget(arg.playbookValues ?? {});
      }
      if (arg.playbookId === 'enable-db-remote-access' && serverId) {
        const values = arg.playbookValues ?? {};
        const target = databaseWizardTarget(values);
        const port = Number(values.port) || target.port;
        if (port) {
          externalHostTarget = { serverId, engine: target.engine, port };
        }
      }
    } else if (arg.templateId) {
      // App template deploy: fetch the blueprint, expand its variables
      // (secrets, sslip.io domains) against the target server, and seed the
      // run with one self-contained deploy prompt.
      const serverId = arg.serverIds?.[0];
      const server = serverId ? store.getServer(serverId) : undefined;
      const serverName = server?.name ?? serverId ?? 'the target server';
      // sslip.io domains only make sense for a raw IP; for a hostname the
      // generated name is just a label the agent treats as a suggestion.
      const serverIp =
        server && /^[0-9a-fA-F.:]+$/.test(server.host) ? server.host : '';
      const files = await fetchTemplateFiles(arg.templateId);
      const catalog = await listTemplates().catch((): TemplateMeta[] => []);
      const meta = catalog.find((t) => t.id === arg.templateId) ?? {
        id: arg.templateId,
        name: arg.templateId,
        version: 'latest',
        description: '',
        links: {},
        tags: [],
      };
      const appName = `${arg.templateId}-${generateHash(6)}`;
      const processed = processTemplate(files.config, {
        serverIp,
        projectName: arg.templateId,
      });
      messages = [
        {
          role: 'user',
          content: buildTemplatePrompt({
            meta,
            files,
            processed,
            appName,
            serverName,
          }),
        },
      ];
    }

    // GitHub App tokens rotate every 8 h — make sure the servers this run will
    // touch still hold a working token before the agent starts running git
    // commands on them. Fire-and-forget: an offline server just stays stale.
    for (const serverId of arg.serverIds ?? []) {
      void github.ensureServerCredentialsFresh(cm, connectServer, serverId);
    }

    // Fold this turn's attachments (images / text files) into the last user
    // message as multimodal content before the model sees it.
    const modelMessages = buildModelMessages(messages, arg.attachments);

    // Guard against a hand-edited store: unknown provider falls back to Gemini.
    const provider = isProviderId(settings.aiProvider) ? settings.aiProvider : 'google';

    // Codex uses the ChatGPT subscription: resolve (and refresh, if near expiry)
    // the OAuth access token now, so the run gets a live token. Other providers
    // read their API key synchronously from the encrypted store.
    let apiKey = aiKeys.resolveApiKey(provider);
    let codexAccountId: string | undefined;
    if (provider === 'codex') {
      const auth = await codexAuth.resolveCodexAuth();
      apiKey = auth?.accessToken;
      codexAccountId = auth?.accountId;
    }

    setTimeout(() => {
      startAgentRun({
        runId,
        messages: modelMessages,
        maxSteps: settings.agentMaxSteps,
        modelConfig: {
          provider,
          modelId: settings.aiModel,
          apiKey,
          baseUrl: settings.aiBaseUrl || undefined,
          codexAccountId,
          effort: settings.aiEffort,
          thinking: settings.aiThinking,
        },
        toolContext,
        emit,
        todos: arg.todos,
        planning: settings.aiPlanning !== false,
        projectContext: projectContext + localTargetContext,
      });
    }, 0);
    return { runId };
  });

  // Resolve (deny) any approval/form the run was blocked on when it ends, so a
  // cancelled or errored run never leaks its resolver + suspended tool frame.
  const drainPendingForRun = (runId: string) => {
    for (const [id, entry] of pendingApprovals) {
      if (entry.runId === runId) {
        pendingApprovals.delete(id);
        entry.resolve(false);
      }
    }
    for (const [id, entry] of pendingForms) {
      if (entry.runId === runId) {
        pendingForms.delete(id);
        entry.resolve(null);
      }
    }
  };

  ipcMain.handle(IPC.agentCancel, (_e, arg: { runId: string }) => {
    cancelAgentRun(arg.runId);
    drainPendingForRun(arg.runId);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.agentSteer,
    (_e, arg: { runId: string; items: SteerItem[] }) => ({
      accepted: steerAgentRun(arg.runId, arg.items),
    }),
  );

  ipcMain.handle(
    IPC.agentApprove,
    (_e, arg: { approvalId: string; approved: boolean }) => {
      const entry = pendingApprovals.get(arg.approvalId);
      if (entry) {
        pendingApprovals.delete(arg.approvalId);
        entry.resolve(arg.approved);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC.agentRespondForm,
    (_e, arg: { formId: string; values: Record<string, string> | null }) => {
      const entry = pendingForms.get(arg.formId);
      if (entry) {
        pendingForms.delete(arg.formId);
        entry.resolve(arg.values);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(IPC.agentModel, () => store.getSettings().aiModel);

  // --- chat history (sessions) ----------------------------------------------
  // Multiple sessions can be saved at once (like FCode's thread list): "New
  // chat" starts a fresh session without deleting the previous one, and every
  // write broadcasts the full state so the sidebar's history list — and any
  // other window — stays in sync even if the ChatPanel itself is unmounted.

  ipcMain.handle(IPC.chatHistoryList, () => store.getChatState());
  ipcMain.handle(IPC.chatHistoryUpsert, (_e, session: ChatSession) => {
    const saved = store.upsertChatSession(session);
    send(IPC.evtChatHistory, saved);
    return saved;
  });
  ipcMain.handle(IPC.chatHistorySetActive, (_e, id: string | null) => {
    const saved = store.setActiveChatSession(id);
    send(IPC.evtChatHistory, saved);
    return saved;
  });
  ipcMain.handle(
    IPC.chatHistorySetPinned,
    (_e, id: string, pinned: boolean) => {
      const saved = store.setChatSessionPinned(id, pinned);
      send(IPC.evtChatHistory, saved);
      return saved;
    },
  );
  ipcMain.handle(IPC.chatHistoryRename, (_e, id: string, title: string) => {
    const saved = store.renameChatSession(id, title);
    send(IPC.evtChatHistory, saved);
    return saved;
  });
  ipcMain.handle(
    IPC.chatHistorySetProject,
    (_e, id: string, projectId: string | null) => {
      const saved = store.setChatSessionProject(id, projectId);
      send(IPC.evtChatHistory, saved);
      return saved;
    },
  );
  ipcMain.handle(IPC.chatHistoryDelete, (_e, id: string) => {
    const saved = store.deleteChatSession(id);
    send(IPC.evtChatHistory, saved);
    return saved;
  });

  // --- settings ------------------------------------------------------------

  ipcMain.handle(IPC.settingsGet, () => store.getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) => {
    const next = store.setSettings(patch);
    // A changed poll interval must reach already-running monitors, not just
    // the next one started — otherwise the setting appears to do nothing until
    // an app restart.
    if (patch.pollIntervalMs !== undefined) {
      monitor.reconfigureAll(store.getSettings().pollIntervalMs);
    }
    return next;
  });

  // --- AI provider API keys --------------------------------------------------
  // Like githubConnectToken: the key travels renderer -> main exactly once and
  // is never echoed back — the renderer only ever sees presence booleans.

  ipcMain.handle(IPC.aiKeySet, (_e, arg: { provider: ProviderId; key: string }) => {
    aiKeys.setProviderKey(arg.provider, arg.key);
    return aiKeys.keyStatus();
  });
  ipcMain.handle(IPC.aiKeyClear, (_e, arg: { provider: ProviderId }) => {
    aiKeys.clearProviderKey(arg.provider);
    return aiKeys.keyStatus();
  });
  ipcMain.handle(IPC.aiKeyStatus, () => aiKeys.keyStatus());

  // --- codex (ChatGPT subscription) sign-in ---------------------------------
  // Mirrors the github device-flow handlers: login opens the browser and pushes
  // pending/success/error over evtCodexAuth. Tokens never cross back to the
  // renderer — only account metadata (email/plan) does.

  ipcMain.handle(IPC.codexStatus, () => codexAuth.status());
  ipcMain.handle(IPC.codexLogin, () =>
    codexAuth.login((event) => send(IPC.evtCodexAuth, event)),
  );
  ipcMain.handle(IPC.codexCancel, () => {
    codexAuth.cancelLogin();
    return { ok: true };
  });
  ipcMain.handle(IPC.codexLogout, () => codexAuth.logout());

  // --- playbooks -----------------------------------------------------------

  ipcMain.handle(IPC.playbooksList, () => playbookMeta());

  // --- app templates (open-source app gallery) ------------------------------

  ipcMain.handle(IPC.templatesList, (_event, request?: TemplateListRequest) =>
    listTemplatePage(request),
  );
  ipcMain.handle(IPC.templatesDeploy, (_e, arg: TemplateDeployRequest) =>
    templateDeploys.start(arg),
  );
  ipcMain.handle(
    IPC.templatesDeployCancel,
    (_e, arg: { deployId: string }) => templateDeploys.cancel(arg.deployId),
  );

  // --- live log streaming (Deploys + Artifacts tabs) -------------------------
  // Long-lived follow channels. Output arrives as IPC.evtLogData events keyed
  // by streamId; the renderer closes the stream when its panel unmounts.

  ipcMain.handle(IPC.logsOpen, (_e, arg: LogStreamRequest) =>
    startLogStream(cm, arg),
  );
  ipcMain.handle(
    IPC.logsClose,
    (_e, arg: { serverId: string; streamId: string }) => {
      cm.closeLogStream(arg.serverId, arg.streamId);
    },
  );

  // --- ssh tunnels (Tunnels tab) ---------------------------------------------
  // Saved configs live in the store; the TunnelManager owns the local listeners
  // and pushes the full state list on every change (IPC.evtTunnelState).

  ipcMain.handle(IPC.tunnelsList, () => tunnels.states());

  ipcMain.handle(
    IPC.tunnelsSave,
    (
      _e,
      arg: {
        id?: string;
        serverId: string;
        name?: string;
        localPort: number;
        remoteHost: string;
        remotePort: number;
      },
    ) => {
      const invalid = validateTunnelInput(arg);
      if (invalid) return { ok: false as const, error: invalid };
      if (!store.getServer(arg.serverId)) {
        return { ok: false as const, error: 'Unknown server.' };
      }
      const existing = arg.id
        ? store.listTunnels().find((t) => t.id === arg.id)
        : undefined;
      store.saveTunnel({
        id: arg.id ?? `tun_${Date.now()}_${runCounter++}`,
        serverId: arg.serverId,
        name: arg.name?.trim() || undefined,
        localPort: arg.localPort,
        remoteHost: arg.remoteHost.trim(),
        remotePort: arg.remotePort,
        createdAt: existing?.createdAt ?? Date.now(),
      });
      // Editing a running tunnel restarts it against the new destination.
      if (existing && arg.id) tunnels.stop(arg.id);
      send(IPC.evtTunnelState, tunnels.states());
      return { ok: true as const };
    },
  );

  ipcMain.handle(IPC.tunnelsRemove, (_e, arg: { id: string }) => {
    tunnels.stop(arg.id);
    store.removeTunnel(arg.id);
    send(IPC.evtTunnelState, tunnels.states());
    return { ok: true };
  });

  ipcMain.handle(IPC.tunnelsStart, (_e, arg: { id: string }) =>
    tunnels.start(arg.id),
  );

  ipcMain.handle(IPC.tunnelsStop, (_e, arg: { id: string }) => {
    tunnels.stop(arg.id);
    return { ok: true };
  });

  // --- artifacts -----------------------------------------------------------

  ipcMain.handle(IPC.artifactsScan, (_e, arg: { serverId: string }) =>
    scanArtifacts(cm, arg.serverId),
  );
  ipcMain.handle(IPC.artifactsAction, (_e, arg: ArtifactActionRequest) =>
    runArtifactAction(cm, arg.serverId, arg.runtime, arg.name, arg.action),
  );
  ipcMain.handle(IPC.artifactsLogs, (_e, arg: ArtifactLogsRequest) =>
    readArtifactLogs(cm, arg.serverId, arg.runtime, arg.name),
  );

  // --- github auto-deploys (Deploys tab) -------------------------------------

  ipcMain.handle(IPC.deploysList, (_e, arg: { serverId: string }) =>
    deployments.listDeployments(cm, arg.serverId),
  );
  ipcMain.handle(
    IPC.deploysLog,
    (_e, arg: { serverId: string; logPath: string }) =>
      deployments.readDeployLog(cm, arg.serverId, arg.logPath),
  );
  ipcMain.handle(
    IPC.deploysEnvRead,
    (_e, arg: { serverId: string; envPath: string }) =>
      deployments.readEnvFile(cm, arg.serverId, arg.envPath),
  );
  ipcMain.handle(
    IPC.deploysEnvWrite,
    (_e, arg: { serverId: string; envPath: string; content: string }) =>
      deployments.writeEnvFile(cm, arg.serverId, arg.envPath, arg.content),
  );
  ipcMain.handle(
    IPC.deploysRedeploy,
    (_e, arg: { serverId: string; scriptPath: string }) =>
      deployments.forceRedeploy(cm, arg.serverId, arg.scriptPath),
  );

  // --- database credentials --------------------------------------------------
  // Saved by the setup-database wizard (via the saveDatabaseCredential tool)
  // or manually by the user from the Artifacts tab; the password only ever
  // leaves main on an explicit reveal call.

  ipcMain.handle(IPC.credentialsList, (_e, arg: { serverId: string }) =>
    credentials.listDatabaseCredentials(arg.serverId),
  );
  ipcMain.handle(
    IPC.credentialsSave,
    (_e, arg: SaveDatabaseCredentialRequest) =>
      credentials.saveDatabaseCredential(arg),
  );
  ipcMain.handle(IPC.credentialsReveal, (_e, arg: { id: string }) =>
    credentials.revealDatabaseCredential(arg.id) ?? null,
  );
  ipcMain.handle(IPC.credentialsDelete, (_e, arg: { id: string }) => {
    credentials.deleteDatabaseCredential(arg.id);
    return { ok: true };
  });
  ipcMain.handle(
    IPC.credentialsRecoverFromContainer,
    async (
      _e,
      arg: { serverId: string; containerName: string; engine: string },
    ) =>
      (await credentials.recoverContainerCredential(
        cm,
        arg.serverId,
        arg.containerName,
        arg.engine,
      )) ?? null,
  );

  // --- database editor -------------------------------------------------------
  // The lightweight in-app DB IDE. Each call reveals the saved credential and
  // runs the database's own CLI (psql/mysql) over SSH — see main/db-query.ts.

  ipcMain.handle(IPC.dbTables, (_e, arg: { target: DbEditorTarget }) =>
    dbQuery.listTables(cm, arg.target),
  );
  ipcMain.handle(
    IPC.dbColumns,
    (_e, arg: { target: DbEditorTarget; schema: string; table: string }) =>
      dbQuery.tableColumns(cm, arg.target, arg.schema, arg.table),
  );
  ipcMain.handle(
    IPC.dbSelect,
    (
      _e,
      arg: {
        target: DbEditorTarget;
        schema: string;
        table: string;
        limit?: number;
        offset?: number;
        orderBy?: { column: string; dir: 'asc' | 'desc' };
      },
    ) =>
      dbQuery.selectRows(cm, arg.target, arg.schema, arg.table, {
        limit: arg.limit,
        offset: arg.offset,
        orderBy: arg.orderBy,
      }),
  );
  ipcMain.handle(
    IPC.dbQuery,
    (_e, arg: { target: DbEditorTarget; sql: string }) =>
      dbQuery.runQuery(cm, arg.target, arg.sql),
  );
  ipcMain.handle(IPC.dbGraph, (_e, arg: { target: DbEditorTarget }) =>
    dbQuery.schemaGraph(cm, arg.target),
  );
  ipcMain.handle(
    IPC.dbUpdateCell,
    (
      _e,
      arg: {
        target: DbEditorTarget;
        schema: string;
        table: string;
        pk: { column: string; value: string | null }[];
        column: string;
        value: string | null;
      },
    ) =>
      dbQuery.updateCell(cm, arg.target, arg.schema, arg.table, arg.pk, arg.column, arg.value),
  );

  // --- github ----------------------------------------------------------------
  // Token exchange & storage stay in main (github.ts); only status crosses IPC.

  ipcMain.handle(IPC.githubStatus, () => github.getStatus());

  ipcMain.handle(IPC.githubDeviceStart, () =>
    github.startDeviceFlow((event) => send(IPC.evtGithubAuth, event)),
  );

  ipcMain.handle(IPC.githubDeviceCancel, () => {
    github.cancelDeviceFlow();
    return { ok: true };
  });

  ipcMain.handle(IPC.githubConnectToken, async (_e, arg: { token: string }) => {
    try {
      return await github.connectWithToken(arg.token);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });

  ipcMain.handle(IPC.githubDisconnect, () => github.disconnect(cm));

  ipcMain.handle(IPC.githubRepos, () => github.listRepos());

  ipcMain.handle(IPC.githubInstallations, () => github.listInstallations());

  ipcMain.handle(IPC.githubOpenInstall, (_e, arg?: { installationId?: number }) =>
    github.openInstallPage(arg?.installationId),
  );

  ipcMain.handle(IPC.githubAuthorizeServer, (_e, arg: { serverId: string }) =>
    github.authorizeServer(cm, connectServer, arg.serverId),
  );

  ipcMain.handle(IPC.githubDeauthorizeServer, (_e, arg: { serverId: string }) =>
    github.deauthorizeServer(cm, connectServer, arg.serverId),
  );

  ipcMain.handle(
    IPC.githubClone,
    (_e, arg: { serverId: string; repoFullName: string; destPath?: string }) =>
      github.cloneRepo(cm, connectServer, arg.serverId, arg.repoFullName, arg.destPath),
  );

  // --- google drive app-data sync -------------------------------------------
  // OAuth and Drive uploads stay in main. The renderer sees only account
  // metadata and sync status; backup snapshots keep secrets encrypted.

  ipcMain.handle(IPC.googleDriveStatus, () => googleDriveSync.status());

  // Push status changes (sync start/finish, background first sync, reauth) so
  // the Settings UI reflects a completed sync without polling.
  const stopGoogleDriveStatus = googleDriveSync.onStatusChange((s) =>
    send(IPC.evtGoogleDriveStatus, s),
  );

  ipcMain.handle(IPC.googleDriveLogin, () =>
    googleDriveSync.login((event) => send(IPC.evtGoogleDriveAuth, event)),
  );

  ipcMain.handle(IPC.googleDriveCancel, () => {
    googleDriveSync.cancelLogin();
    return { ok: true };
  });

  ipcMain.handle(IPC.googleDriveDisconnect, () => googleDriveSync.disconnect());

  ipcMain.handle(IPC.googleDriveSyncNow, () =>
    googleDriveSync.syncNow({ force: true, userInitiated: true }),
  );

  ipcMain.handle(IPC.googleDriveRestore, () => googleDriveSync.restoreNow());

  ipcMain.handle(IPC.googleDriveKeepLocal, () => googleDriveSync.keepLocalAndSync());

  // --- alerts / telegram -----------------------------------------------------
  // The bot token is validated, stored (encrypted) and used entirely in main
  // (alerts.ts); only non-secret status/config crosses IPC.

  ipcMain.handle(IPC.alertsStatus, () => alerts.getAlertsStatus());

  ipcMain.handle(IPC.alertsConnectToken, (_e, arg: { token: string }) =>
    alerts.connectToken(arg.token),
  );

  ipcMain.handle(IPC.alertsDisconnect, () => {
    const status = alerts.disconnect();
    alertEngine.reconcile();
    return status;
  });

  ipcMain.handle(IPC.alertsDetectChat, () => alerts.detectChat());

  ipcMain.handle(IPC.alertsSetChat, (_e, arg: { chatId: string | null }) => {
    store.setAlertConfig({ chatId: arg.chatId });
    alertEngine.reconcile();
    return alerts.getAlertsStatus();
  });

  ipcMain.handle(IPC.alertsTest, () => alerts.sendTest());

  ipcMain.handle(
    IPC.alertsSetConfig,
    (_e, patch: Partial<Omit<AlertConfig, 'servers'>>) => {
      store.setAlertConfig(patch);
      alertEngine.reconcile();
      return alerts.getAlertsStatus();
    },
  );

  ipcMain.handle(IPC.alertsSetServer, (_e, sc: ServerAlertConfig) => {
    store.setServerAlertConfig(sc);
    if (!sc.enabled) alertEngine.clearServer(sc.serverId);
    alertEngine.reconcile();
    return alerts.getAlertsStatus();
  });

  // --- local MCP server ------------------------------------------------------
  // External coding agents (Claude Code, Codex, …) reach the user's servers
  // through this app: the endpoint reuses the same store + connection manager
  // the in-app agent uses, and credentials never leave the main process.

  // Per-install bearer token, generated once and kept in the encrypted secret
  // store. If secure storage is unavailable the token lives only in memory for
  // this app run (configs written by one-click install would go stale on
  // restart — same environments where the app can't save SSH secrets anyway).
  const MCP_TOKEN_SECRET_ID = 'mcp-auth-token';
  let mcpMemoryToken: string | null = null;
  const mcpAuthToken = (): string | null => {
    const stored = secrets.hasRawSecret(MCP_TOKEN_SECRET_ID)
      ? secrets.loadRawSecret(MCP_TOKEN_SECRET_ID)
      : undefined;
    if (stored) return stored;
    if (!mcpMemoryToken) {
      mcpMemoryToken = randomBytes(24).toString('base64url');
      try {
        secrets.saveRawSecret(MCP_TOKEN_SECRET_ID, mcpMemoryToken);
      } catch (err) {
        console.warn('[mcp] auth token not persisted (secure storage unavailable)', err);
      }
    }
    return mcpMemoryToken;
  };

  const mcp = new TevadaMcpServer(
    {
      listServers: () => store.listServers(),
      listProjects: () => store.listProjects(),
      getStatus: (serverId) => cm.getStatus(serverId),
      connect: connectServer,
      exec: (serverId, command, opts) => cm.exec(serverId, command, opts),
      getStats: (serverId) => monitor.getLatest(serverId),
      listSkills: loadSkills,
      sftpWriteFile: (serverId, path, content) =>
        cm.sftpWriteFile(serverId, path, content),
      sftpReadFile: (serverId, path, maxBytes) =>
        cm.sftpReadFile(serverId, path, maxBytes),
      sftpList: (serverId, path) => cm.sftpList(serverId, path),
      scanArtifacts: (serverId) => scanArtifacts(cm, serverId),
      listDeployments: (serverId) => deployments.listDeployments(cm, serverId),
      readDeployLog: (serverId, logPath) =>
        deployments.readDeployLog(cm, serverId, logPath),
      getAlertsInfo: () => {
        const config = store.getAlertConfig();
        return {
          configured: !!alerts.loadToken() && !!config.chatId,
          // http/tls incidents key on the check id — swap in the URL so the
          // MCP get_alerts tool (which resolves names via the server list)
          // falls back to something meaningful.
          incidents: alertEngine.snapshot().map((i) =>
            i.metric === 'http' || i.metric === 'tls'
              ? {
                  ...i,
                  serverId:
                    (config.httpChecks ?? []).find((c) => c.id === i.serverId)
                      ?.url ?? i.serverId,
                }
              : i,
          ),
        };
      },
      isReadOnly: () => store.getSettings().mcpReadOnly,
      listGithubRepos: () => github.listRepos(),
      githubAuthorizedServerIds: () =>
        store.getGithubAccount()?.authorizedServerIds ?? [],
      setupDeployNotifications: (serverId) => {
        // Same as the in-app agent: token + chat stay in main; callers only
        // ever see ok/telegramConfigured.
        const token = alerts.loadToken();
        const chatId = store.getAlertConfig().chatId;
        return deployments.provisionDeployNotifications(
          cm,
          serverId,
          token && chatId ? { token, chatId } : undefined,
        );
      },
    },
    mcpAuthToken,
    (status) => send(IPC.evtMcpStatus, status),
  );

  ipcMain.handle(IPC.mcpStatus, () => mcp.status());
  ipcMain.handle(IPC.mcpStart, async (_e, arg: { port?: number }) => {
    const port =
      arg?.port && Number.isInteger(arg.port) && arg.port > 0 && arg.port < 65536
        ? arg.port
        : store.getSettings().mcpPort;
    const status = await mcp.start(port);
    // Record last-run state and the working port (the server never auto-starts
    // — this is just so the UI and port field reflect the last session).
    store.setSettings({ mcpEnabled: status.running, mcpPort: port });
    return status;
  });
  ipcMain.handle(IPC.mcpStop, async () => {
    store.setSettings({ mcpEnabled: false });
    return mcp.stop();
  });
  ipcMain.handle(
    IPC.mcpInstall,
    (_e, arg: { client: McpInstallClient }) => {
      const { url } = mcp.status();
      const target = url ?? `http://127.0.0.1:${store.getSettings().mcpPort}/mcp`;
      const token = mcpAuthToken();
      if (!token) {
        return {
          ok: false as const,
          error: 'No auth token available — OS secure storage is unavailable.',
        };
      }
      return installMcpClient(arg.client, target, token);
    },
  );

  // --- in-app updates --------------------------------------------------------

  const updater = new AppUpdater((state) => send(IPC.evtUpdateState, state));
  updater.startAutoChecks();
  ipcMain.handle(IPC.updateState, () => updater.getState());
  ipcMain.handle(IPC.updateCheck, () => updater.check());
  ipcMain.handle(IPC.updateInstall, () => updater.install());
  ipcMain.handle(IPC.updateOpenReleases, () => updater.openReleasesPage());

  // The MCP server never auto-starts: it exposes the user's servers to coding
  // agents, so bringing it up is an explicit, deliberate action every session.
  // The user runs it from Settings → Agent Access with the Run button.

  // --- lifecycle cleanup ---------------------------------------------------

  const win = getWindow();
  if (win) {
    win.webContents.on('did-start-navigation', () => {
      // Dev hot-reload / navigation: don't leave zombie runs & monitors.
      cancelAllRuns();
      monitor.stopAll();
      for (const [, entry] of pendingApprovals) entry.resolve(false);
      pendingApprovals.clear();
      for (const [, entry] of pendingForms) entry.resolve(null);
      pendingForms.clear();
      // Any session still marked running belongs to a run we just killed.
      send(IPC.evtChatHistory, store.markInterruptedChatSessions());
    });
    win.on('closed', () => {
      cancelAllRuns();
      tunnels.stopAll();
      monitor.stopAll();
      stopGoogleDriveAutoSync();
      stopGoogleDriveStatus();
      alertEngine.stop();
      void mcp.stop();
    });
  }
}
