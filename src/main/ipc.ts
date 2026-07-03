/**
 * Registers every ipcMain handler and wires the store, secrets, connection
 * manager, monitor and agent together. Called once after app.whenReady().
 */
import { BrowserWindow, ipcMain } from 'electron';
import {
  AgentEvent,
  AgentStartRequest,
  AppSettings,
  IPC,
  ServerProfile,
  ServerSecret,
  ServerWithStatus,
} from '../shared/ipc-types';
import * as store from './store';
import * as secrets from './secrets';
import { ConnectionManager } from './connection-manager';
import { Monitor } from './monitor';
import {
  agentModel,
  cancelAgentRun,
  cancelAllRuns,
  startAgentRun,
} from '../agent/agent';
import { AgentToolContext } from '../agent/tools';
import { getPlaybook, playbookMeta } from '../agent/playbooks';
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

    const emit = (event: AgentEvent) =>
      send(IPC.evtAgentEvent, { runId, event });

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
    }

    startAgentRun({
      runId,
      messages,
      maxSteps: settings.agentMaxSteps,
      toolContext,
      emit,
    });
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

  // --- settings ------------------------------------------------------------

  ipcMain.handle(IPC.settingsGet, () => store.getSettings());
  ipcMain.handle(IPC.settingsSet, (_e, patch: Partial<AppSettings>) =>
    store.setSettings(patch),
  );

  // --- playbooks -----------------------------------------------------------

  ipcMain.handle(IPC.playbooksList, () => playbookMeta());

  // --- lifecycle cleanup ---------------------------------------------------

  const win = getWindow();
  if (win) {
    win.webContents.on('did-start-navigation', () => {
      // Dev hot-reload / navigation: don't leave zombie runs & monitors.
      cancelAllRuns();
      monitor.stopAll();
      for (const [, resolve] of pendingApprovals) resolve(false);
      pendingApprovals.clear();
    });
    win.on('closed', () => {
      cancelAllRuns();
      monitor.stopAll();
    });
  }
}
