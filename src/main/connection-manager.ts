/**
 * SSH connection manager (main process). Owns one ssh2 Client per server and
 * multiplexes over it: interactive shell channels (for the terminal UI), one-off
 * exec channels (for the agent + monitoring), and a lazily-opened SFTP session.
 *
 * Design notes:
 *  - One Client per serverId, kept alive with keepalives.
 *  - Agent/monitor execs are serialized per server via a small promise queue so we
 *    don't blow past OpenSSH's default MaxSessions (10) during command bursts.
 *  - On unexpected close we mark disconnected, tear down shells, and notify — we do
 *    NOT auto-reopen shells (their remote state is gone).
 */
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2';
import {
  ConnStatus,
  ExecResult,
  ServerProfile,
  ServerSecret,
} from '../shared/ipc-types';

type Managed = {
  client: Client;
  status: ConnStatus;
  shells: Map<string, ClientChannel>;
  sftp?: SFTPWrapper;
  execQueue: Promise<unknown>;
};

export type ExecOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
};

type Listeners = {
  onStatus: (serverId: string, status: ConnStatus, error?: string) => void;
  onShellData: (sessionId: string, data: string) => void;
  onShellExit: (sessionId: string) => void;
};

const DEFAULT_EXEC_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

export class ConnectionManager {
  private conns = new Map<string, Managed>();
  private listeners: Listeners;

  constructor(listeners: Listeners) {
    this.listeners = listeners;
  }

  getStatus(serverId: string): ConnStatus {
    return this.conns.get(serverId)?.status ?? 'disconnected';
  }

  statusAll(): Record<string, ConnStatus> {
    const out: Record<string, ConnStatus> = {};
    for (const [id, m] of this.conns) out[id] = m.status;
    return out;
  }

  private setStatus(serverId: string, status: ConnStatus, error?: string) {
    const m = this.conns.get(serverId);
    if (m) m.status = status;
    this.listeners.onStatus(serverId, status, error);
  }

  /** Build the ssh2 connect config from a profile + its decrypted secret. */
  private buildConfig(profile: ServerProfile, secret: ServerSecret) {
    return {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.authType === 'password' ? secret.password : undefined,
      privateKey: profile.authType === 'key' ? secret.privateKey : undefined,
      passphrase: secret.passphrase || undefined,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      readyTimeout: 20_000,
    };
  }

  /**
   * Open a transient connection just to verify credentials. Does not register
   * the connection in the manager.
   */
  testConnection(
    profile: ServerProfile,
    secret: ServerSecret,
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      const client = new Client();
      let settled = false;
      const done = (ok: boolean, error?: string) => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch {
          /* noop */
        }
        resolve({ ok, error });
      };
      client
        .on('ready', () => done(true))
        .on('error', (err) => done(false, err.message))
        .connect(this.buildConfig(profile, secret));
    });
  }

  connect(
    profile: ServerProfile,
    secret: ServerSecret,
  ): Promise<{ ok: boolean; error?: string }> {
    const existing = this.conns.get(profile.id);
    if (existing && existing.status === 'connected') {
      return Promise.resolve({ ok: true });
    }

    return new Promise((resolve) => {
      const client = new Client();
      const managed: Managed = {
        client,
        status: 'connecting',
        shells: new Map(),
        execQueue: Promise.resolve(),
      };
      this.conns.set(profile.id, managed);
      this.setStatus(profile.id, 'connecting');

      let settled = false;
      client
        .on('ready', () => {
          this.setStatus(profile.id, 'connected');
          settled = true;
          resolve({ ok: true });
        })
        .on('error', (err) => {
          this.setStatus(profile.id, 'error', err.message);
          if (!settled) {
            settled = true;
            resolve({ ok: false, error: err.message });
          }
        })
        .on('close', () => {
          // Tear down shells; their remote state is gone.
          for (const [sid, ch] of managed.shells) {
            try {
              ch.close();
            } catch {
              /* noop */
            }
            this.listeners.onShellExit(sid);
          }
          managed.shells.clear();
          managed.sftp = undefined;
          if (managed.status !== 'error') {
            this.setStatus(profile.id, 'disconnected');
          }
        })
        .connect(this.buildConfig(profile, secret));
    });
  }

  disconnect(serverId: string): void {
    const m = this.conns.get(serverId);
    if (!m) return;
    try {
      m.client.end();
    } catch {
      /* noop */
    }
    this.conns.delete(serverId);
    this.setStatus(serverId, 'disconnected');
  }

  private requireConnected(serverId: string): Managed {
    const m = this.conns.get(serverId);
    if (!m || m.status !== 'connected') {
      throw new Error(`Server ${serverId} is not connected.`);
    }
    return m;
  }

  // --- exec (agent + monitoring) -------------------------------------------

  /** Serialize execs per server to respect MaxSessions during bursts. */
  exec(
    serverId: string,
    command: string,
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    const m = this.requireConnected(serverId);
    const run = (): Promise<ExecResult> => this.execNow(m, command, opts);
    const next: Promise<ExecResult> = m.execQueue.then(run, run);
    // Keep the queue chain alive regardless of individual failures.
    m.execQueue = next.catch((): void => undefined);
    return next;
  }

  private execNow(
    m: Managed,
    command: string,
    opts: ExecOptions,
  ): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT;
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    return new Promise((resolve, reject) => {
      m.client.exec(command, { pty: false }, (err, channel) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let timedOut = false;
        let exitCode: number | null = null;

        const append = (buf: string, chunk: Buffer) => {
          if (buf.length >= maxBytes) {
            truncated = true;
            return buf;
          }
          return buf + chunk.toString('utf8');
        };

        const timer = setTimeout(() => {
          timedOut = true;
          try {
            channel.close();
          } catch {
            /* noop */
          }
        }, timeoutMs);

        channel
          .on('data', (chunk: Buffer) => {
            stdout = append(stdout, chunk);
          })
          .on('exit', (code: number | null) => {
            exitCode = code;
          })
          .on('close', () => {
            clearTimeout(timer);
            resolve({
              stdout: stdout.slice(0, maxBytes),
              stderr: stderr.slice(0, maxBytes),
              exitCode,
              truncated,
              timedOut,
            });
          });
        channel.stderr.on('data', (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
      });
    });
  }

  // --- interactive shell (terminal UI) -------------------------------------

  openShell(
    serverId: string,
    sessionId: string,
    dims: { cols: number; rows: number; term?: string },
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    return new Promise((resolve, reject) => {
      m.client.shell(
        {
          cols: dims.cols,
          rows: dims.rows,
          term: dims.term ?? 'xterm-256color',
        },
        (err, channel) => {
          if (err) return reject(err);
          m.shells.set(sessionId, channel);
          channel
            .on('data', (chunk: Buffer) => {
              this.listeners.onShellData(sessionId, chunk.toString('utf8'));
            })
            .on('close', () => {
              m.shells.delete(sessionId);
              this.listeners.onShellExit(sessionId);
            });
          channel.stderr.on('data', (chunk: Buffer) => {
            this.listeners.onShellData(sessionId, chunk.toString('utf8'));
          });
          resolve();
        },
      );
    });
  }

  writeShell(serverId: string, sessionId: string, data: string): void {
    const ch = this.conns.get(serverId)?.shells.get(sessionId);
    if (ch) ch.write(data);
  }

  resizeShell(
    serverId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ): void {
    const ch = this.conns.get(serverId)?.shells.get(sessionId);
    if (ch) ch.setWindow(rows, cols, 0, 0);
  }

  closeShell(serverId: string, sessionId: string): void {
    const ch = this.conns.get(serverId)?.shells.get(sessionId);
    if (ch) {
      try {
        ch.close();
      } catch {
        /* noop */
      }
    }
  }

  // --- SFTP (agent file read/write) ----------------------------------------

  private getSftp(m: Managed): Promise<SFTPWrapper> {
    if (m.sftp) return Promise.resolve(m.sftp);
    return new Promise((resolve, reject) => {
      m.client.sftp((err, sftp) => {
        if (err) return reject(err);
        m.sftp = sftp;
        sftp.on('close', () => {
          m.sftp = undefined;
        });
        resolve(sftp);
      });
    });
  }

  async sftpReadFile(
    serverId: string,
    remotePath: string,
    maxBytes = 32 * 1024,
  ): Promise<{ content: string; truncated: boolean }> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let truncated = false;
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total <= maxBytes) chunks.push(chunk);
        else truncated = true;
      });
      stream.on('error', reject);
      stream.on('end', () =>
        resolve({
          content: Buffer.concat(chunks).toString('utf8').slice(0, maxBytes),
          truncated,
        }),
      );
    });
  }

  async sftpWriteFile(
    serverId: string,
    remotePath: string,
    content: string,
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(content);
    });
  }
}
