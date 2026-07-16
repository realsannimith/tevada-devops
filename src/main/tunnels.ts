/**
 * SSH tunnels (local port forwards), main process.
 *
 * One active tunnel = one local TCP listener on 127.0.0.1:<localPort>. Every
 * accepted socket is piped through a fresh forwarded channel on the server's
 * existing SSH connection (ConnectionManager.forwardOut) to
 * <remoteHost>:<remotePort> as resolved from the server — the way `ssh -L`
 * works, minus the extra ssh process.
 *
 * Lifecycle rules:
 *  - Starting a tunnel connects the server on demand (same as the agent).
 *  - The SSH connection dropping kills every in-flight forwarded socket; the
 *    local listener STAYS up and later connections retry forwardOut, so a
 *    reconnect heals the tunnel without the user re-starting it. The state
 *    carries the last forward error so the UI can say why connects fail.
 *  - Nothing auto-starts on launch: an open local port is an explicit action.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { TunnelConfig, TunnelState } from '../shared/ipc-types';
import type { ConnectionManager } from './connection-manager';

type ActiveTunnel = {
  config: TunnelConfig;
  server: Server;
  sockets: Set<Socket>;
  lastError?: string;
};

export type TunnelManagerDeps = {
  cm: ConnectionManager;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  listConfigs: () => TunnelConfig[];
  /** Called on every state change with the full state list (renderer push). */
  emit: (states: TunnelState[]) => void;
};

export class TunnelManager {
  private active = new Map<string, ActiveTunnel>();

  constructor(private deps: TunnelManagerDeps) {}

  /** Full state list: every saved config, active or not. */
  states(): TunnelState[] {
    return this.deps.listConfigs().map((config) => {
      const act = this.active.get(config.id);
      return {
        config,
        active: !!act,
        connections: act?.sockets.size ?? 0,
        error: act?.lastError,
      };
    });
  }

  private notify(): void {
    this.deps.emit(this.states());
  }

  async start(id: string): Promise<{ ok: boolean; error?: string }> {
    if (this.active.has(id)) return { ok: true };
    const config = this.deps.listConfigs().find((t) => t.id === id);
    if (!config) return { ok: false, error: 'Unknown tunnel.' };

    if (this.deps.cm.getStatus(config.serverId) !== 'connected') {
      const conn = await this.deps.connect(config.serverId);
      if (!conn.ok) {
        return { ok: false, error: conn.error ?? 'Could not connect to the server.' };
      }
    }

    const entry: ActiveTunnel = {
      config,
      server: createServer((socket) => this.handleConnection(entry, socket)),
      sockets: new Set(),
    };

    try {
      await new Promise<void>((resolve, reject) => {
        entry.server.once('error', reject);
        entry.server.listen(config.localPort, '127.0.0.1', () => {
          entry.server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      const error =
        err instanceof Error && 'code' in err && err.code === 'EADDRINUSE'
          ? `Local port ${config.localPort} is already in use.`
          : err instanceof Error
            ? err.message
            : String(err);
      return { ok: false, error };
    }

    // A listener error after startup (rare) tears the tunnel down cleanly.
    entry.server.on('error', (err) => {
      entry.lastError = err.message;
      this.stop(id);
    });

    this.active.set(id, entry);
    this.notify();
    return { ok: true };
  }

  private handleConnection(entry: ActiveTunnel, socket: Socket): void {
    entry.sockets.add(socket);
    const done = () => {
      if (entry.sockets.delete(socket)) this.notify();
    };
    socket.on('close', done);
    socket.on('error', () => socket.destroy());

    this.deps.cm
      .forwardOut(
        entry.config.serverId,
        entry.config.remoteHost,
        entry.config.remotePort,
      )
      .then((channel) => {
        if (socket.destroyed) {
          channel.close();
          return;
        }
        entry.lastError = undefined;
        socket.pipe(channel).pipe(socket);
        channel.on('close', () => socket.destroy());
        channel.on('error', () => socket.destroy());
        this.notify();
      })
      .catch((err) => {
        // Server offline / destination refused — drop this socket, keep the
        // listener. The error is surfaced on the row until a connect succeeds.
        entry.lastError = err instanceof Error ? err.message : String(err);
        socket.destroy();
        this.notify();
      });
  }

  stop(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    this.active.delete(id);
    for (const socket of entry.sockets) {
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
    }
    entry.sockets.clear();
    try {
      entry.server.close();
    } catch {
      /* noop */
    }
    this.notify();
  }

  /** Stop every active tunnel of one server (server removed from the app). */
  stopForServer(serverId: string): void {
    for (const [id, entry] of this.active) {
      if (entry.config.serverId === serverId) this.stop(id);
    }
  }

  stopAll(): void {
    for (const id of [...this.active.keys()]) this.stop(id);
  }
}

/** Renderer-supplied fields are untrusted; normalize before persisting. */
export function validateTunnelInput(input: {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}): string | undefined {
  const validPort = (p: number) => Number.isInteger(p) && p > 0 && p < 65536;
  if (!validPort(input.localPort)) return 'Local port must be 1–65535.';
  if (!validPort(input.remotePort)) return 'Remote port must be 1–65535.';
  const host = input.remoteHost.trim();
  if (!host || host.length > 253 || !/^[A-Za-z0-9.:_-]+$/.test(host)) {
    return 'Remote host must be a hostname or IP address.';
  }
  return undefined;
}
