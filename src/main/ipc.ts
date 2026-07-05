/**
 * Registers every ipcMain handler and wires the store, secrets, connection
 * manager, monitor and agent together. Called once after app.whenReady().
 */
import { BrowserWindow, ipcMain } from 'electron';
import {
  AgentEvent,
  AgentStartRequest,
  AlertConfig,
  AppSettings,
  ChatSession,
  IPC,
  SaveDatabaseCredentialRequest,
  ServerAlertConfig,
  ServerProfile,
  ServerSecret,
  ServerWithStatus,
} from '../shared/ipc-types';
import * as store from './store';
import * as secrets from './secrets';
import * as credentials from './credentials';
import * as github from './github';
import * as alerts from './alerts';
import { AlertEngine } from './alerts';
import * as deployments from './deployments';
import { ConnectionManager } from './connection-manager';
import { Monitor } from './monitor';
import { scanArtifacts } from './artifacts';
import {
  agentModel,
  cancelAgentRun,
  cancelAllRuns,
  startAgentRun,
} from '../agent/agent';
import { AgentToolContext } from '../agent/tools';
import {
  databaseWizardTarget,
  DatabaseWizardTarget,
  getPlaybook,
  playbookMeta,
} from '../agent/playbooks';
import { consumePendingKey, generateKeyPair } from './keygen';

let runCounter = 0;
let sessionCounter = 0;
let approvalCounter = 0;

// Pending approval promises, keyed by approvalId.
const pendingApprovals = new Map<string, (approved: boolean) => void>();

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
  });

  const monitor = new Monitor(cm, (serverId, stats) =>
    send(IPC.evtMonitorStats, { serverId, stats }),
  );

  const withStatus = (p: ServerProfile): ServerWithStatus => ({
    ...p,
    status: cm.getStatus(p.id),
  });

  /** Swap an in-app keyRef for the stashed private key (kept out of the renderer). */
  const resolveSecret = (secret: ServerSecret): ServerSecret => {
    if (!secret.keyRef) return secret;
    const privateKey = consumePendingKey(secret.keyRef);
    const rest = { ...secret };
    delete rest.keyRef;
    return { ...rest, privateKey: privateKey ?? secret.privateKey };
  };

  /** Load the stored secret and connect. Shared by ssh:connect and the agent. */
  const connectServer = async (serverId: string) => {
    const profile = store.getServer(serverId);
    if (!profile) return { ok: false, error: 'Unknown server.' };
    const secret = secrets.loadSecret(serverId);
    if (!secret) return { ok: false, error: 'No stored credentials.' };
    return cm.connect(profile, secret);
  };

  // Let github.ts re-push rotated GitHub App tokens to authorized servers in
  // the background (it never owns SSH connections itself).
  github.bindRuntime({ cm, connect: connectServer });

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
    cm.disconnect(arg.serverId);
    monitor.stop(arg.serverId);
    secrets.deleteSecret(arg.serverId);
    credentials.deleteDatabaseCredentialsForServer(arg.serverId);
    store.removeServerAlertConfig(arg.serverId);
    alertEngine.clearServer(arg.serverId);
    store.removeServer(arg.serverId);
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
      return cm.testConnection(profile, arg.secret);
    },
  );

  // --- keys ----------------------------------------------------------------

  ipcMain.handle(IPC.keysGenerate, (_e, arg: { comment?: string }) =>
    generateKeyPair(arg?.comment ?? 'easy-host'),
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

  ipcMain.handle(IPC.agentStart, (_e, arg: AgentStartRequest) => {
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

    const toolContext: AgentToolContext = {
      cm,
      approvalMode: settings.approvalMode,
      listServers: () => store.listServers().map(withStatus),
      connect: connectServer,
      getStats: (serverId) => monitor.getLatest(serverId),
      emit,
      requestApproval: (serverId, command, reason) =>
        new Promise<boolean>((resolve) => {
          const approvalId = `appr_${Date.now()}_${approvalCounter++}`;
          pendingApprovals.set(approvalId, resolve);
          emit({
            type: 'approval-required',
            approvalId,
            serverId,
            command,
            reason,
          });
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
    };

    // Build the seed messages. A playbook run turns answers into a prompt.
    let messages = arg.messages;
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
    }

    // GitHub App tokens rotate every 8 h — make sure the servers this run will
    // touch still hold a working token before the agent starts running git
    // commands on them. Fire-and-forget: an offline server just stays stale.
    for (const serverId of arg.serverIds ?? []) {
      void github.ensureServerCredentialsFresh(cm, connectServer, serverId);
    }

    setTimeout(() => {
      startAgentRun({
        runId,
        messages,
        maxSteps: settings.agentMaxSteps,
        toolContext,
        emit,
      });
    }, 0);
    return { runId };
  });

  ipcMain.handle(IPC.agentCancel, (_e, arg: { runId: string }) => {
    cancelAgentRun(arg.runId);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.agentApprove,
    (_e, arg: { approvalId: string; approved: boolean }) => {
      const resolve = pendingApprovals.get(arg.approvalId);
      if (resolve) {
        pendingApprovals.delete(arg.approvalId);
        resolve(arg.approved);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(IPC.agentModel, () => agentModel);

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
  ipcMain.handle(IPC.chatHistoryDelete, (_e, id: string) => {
    const saved = store.deleteChatSession(id);
    send(IPC.evtChatHistory, saved);
    return saved;
  });

  // --- settings ------------------------------------------------------------

  ipcMain.handle(IPC.settingsGet, () => store.getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) =>
    store.setSettings(patch),
  );

  // --- playbooks -----------------------------------------------------------

  ipcMain.handle(IPC.playbooksList, () => playbookMeta());

  // --- artifacts -----------------------------------------------------------

  ipcMain.handle(IPC.artifactsScan, (_e, arg: { serverId: string }) =>
    scanArtifacts(cm, arg.serverId),
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

  // --- lifecycle cleanup ---------------------------------------------------

  const win = getWindow();
  if (win) {
    win.webContents.on('did-start-navigation', () => {
      // Dev hot-reload / navigation: don't leave zombie runs & monitors.
      cancelAllRuns();
      monitor.stopAll();
      for (const [, resolve] of pendingApprovals) resolve(false);
      pendingApprovals.clear();
      // Any session still marked running belongs to a run we just killed.
      send(IPC.evtChatHistory, store.markInterruptedChatSessions());
    });
    win.on('closed', () => {
      cancelAllRuns();
      monitor.stopAll();
      alertEngine.stop();
    });
  }
}
