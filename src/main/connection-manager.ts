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
import {
  Client,
  utils,
  type ClientChannel,
  type FileEntry,
  type SFTPWrapper,
} from 'ssh2';
import {
  ConnStatus,
  ExecResult,
  ServerProfile,
  ServerSecret,
  SftpEntry,
  SftpEntryType,
} from '../shared/ipc-types';
import * as knownHosts from './knownHosts';

/** POSIX mode field masks — used to classify SFTP directory entries by their
 *  `mode` bits, which is more reliable across ssh2 versions than relying on the
 *  attrs object carrying Stats helper methods. */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function classifyMode(mode: number | undefined): SftpEntryType {
  switch ((mode ?? 0) & S_IFMT) {
    case S_IFDIR:
      return 'directory';
    case S_IFLNK:
      return 'symlink';
    case S_IFREG:
      return 'file';
    default:
      return 'other';
  }
}

/** Join a remote (POSIX) directory and a child name. Remote paths are always
 *  '/'-separated regardless of the desktop OS, so we never use node's path. */
export function posixJoin(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

type Managed = {
  client: Client;
  status: ConnStatus;
  shells: Map<string, ClientChannel>;
  /** Long-lived follow commands (`tail -f`, `docker logs -f`), keyed by
   *  streamId. Deliberately separate from `shells` and from `execQueue`. */
  logStreams: Map<string, ClientChannel>;
  sftp?: SFTPWrapper;
  execQueue: Promise<unknown>;
};

export type ExecOptions = {
  timeoutMs?: number;
  maxOutputBytes?: number;
  /**
   * Abort the command mid-flight (e.g. the user hit Stop on the agent run).
   * Closes the exec channel — which sends EOF/close to the remote — and rejects
   * the exec promise. If it fires while the exec is still queued behind another
   * command, the exec is rejected before it ever opens a channel.
   */
  signal?: AbortSignal;
};

type Listeners = {
  onStatus: (serverId: string, status: ConnStatus, error?: string) => void;
  onShellData: (sessionId: string, data: string) => void;
  onShellExit: (sessionId: string) => void;
  onLogData: (streamId: string, chunk: string) => void;
  onLogExit: (streamId: string, error?: string) => void;
};

const DEFAULT_EXEC_TIMEOUT = 60_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024;

/** Browser file reads preserve BOMs and sometimes old-Mac/Windows line endings.
 * ssh2 accepts normal PEM/OpenSSH text, but those invisible bytes can make an
 * otherwise valid uploaded key impossible to parse. */
export function normalizePrivateKey(key: string): string {
  return key.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim() + '\n';
}

export function actionableSshError(
  message: string,
  profile: Pick<ServerProfile, 'authType' | 'username'>,
): string {
  if (/all configured authentication methods failed/i.test(message)) {
    if (profile.authType === 'key') {
      return (
        `The server is reachable, but it rejected this key for user ` +
        `"${profile.username}". The upload worked. Confirm that this is the key ` +
        `pair assigned to the instance and confirm the provider's login user ` +
        `(AWS depends on the AMI; DigitalOcean, Linode, Vultr, and Hetzner ` +
        `normally start with "root"). Also verify the matching public key is in that user's ` +
        `~/.ssh/authorized_keys.`
      );
    }
    return `The server is reachable, but it rejected the password for user "${profile.username}".`;
  }
  return message;
}

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

  /** Build the ssh2 connect config from a profile + its decrypted secret.
   *  `hostVerifier` pins/verifies the server's host key (TOFU) — never connect
   *  without it, or credentials are sent to any host answering on the address. */
  private buildConfig(
    profile: ServerProfile,
    secret: ServerSecret,
    hostVerifier: (key: Buffer) => boolean,
  ) {
    let privateKey: string | undefined;
    if (profile.authType === 'key' && secret.privateKey) {
      privateKey = normalizePrivateKey(secret.privateKey);
      const parsed = utils.parseKey(privateKey, secret.passphrase || undefined);
      if (parsed instanceof Error) {
        throw new Error(`The uploaded private key could not be read: ${parsed.message}`);
      }
    }
    return {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      password: profile.authType === 'password' ? secret.password : undefined,
      privateKey,
      passphrase: secret.passphrase || undefined,
      hostVerifier,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      readyTimeout: 20_000,
    };
  }

  /** A host-key verifier bound to one profile. Trust-on-first-use: pins the key
   *  on first connect, rejects a later changed key. Sets `mismatch.hit` so the
   *  caller can replace ssh2's generic error with an actionable one. */
  private makeHostVerifier(
    profile: ServerProfile,
    mismatch: { hit: boolean },
  ): (key: Buffer) => boolean {
    return (key: Buffer): boolean => {
      const result = knownHosts.verifyAndPin(profile.host, profile.port, key);
      if (result === 'mismatch') {
        mismatch.hit = true;
        return false;
      }
      return true;
    };
  }

  private hostKeyChangedMessage(profile: ServerProfile): string {
    return (
      `Host key verification failed for ${profile.host}: the server's SSH ` +
      `identity has changed since you last connected. This usually means the ` +
      `server was rebuilt or reinstalled — but it can also mean the connection ` +
      `is being intercepted. If you know the server was rebuilt, remove and ` +
      `re-add it (or forget its saved key) to trust the new one; otherwise do ` +
      `NOT connect.`
    );
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
      const mismatch = { hit: false };
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
        .on('error', (err) =>
          done(
            false,
            mismatch.hit
              ? this.hostKeyChangedMessage(profile)
              : actionableSshError(err.message, profile),
          ),
        );
      try {
        client.connect(
          this.buildConfig(
            profile,
            secret,
            this.makeHostVerifier(profile, mismatch),
          ),
        );
      } catch (err) {
        done(false, err instanceof Error ? err.message : String(err));
      }
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
      const mismatch = { hit: false };
      const managed: Managed = {
        client,
        status: 'connecting',
        shells: new Map(),
        logStreams: new Map(),
        execQueue: Promise.resolve(),
      };
      this.conns.set(profile.id, managed);
      this.setStatus(profile.id, 'connecting');

      let settled = false;
      client
        .on('ready', () => {
          client.setNoDelay(true); // re-assert in case the socket was created late
          this.setStatus(profile.id, 'connected');
          settled = true;
          resolve({ ok: true });
        })

        .on('error', (err) => {
          const message = mismatch.hit
            ? this.hostKeyChangedMessage(profile)
            : actionableSshError(err.message, profile);
          this.setStatus(profile.id, 'error', message);
          if (!settled) {
            settled = true;
            resolve({ ok: false, error: message });
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
          // Same for log follows — tell the renderer so it can stop showing a
          // "Live" badge for a stream that can no longer receive anything.
          // Drop each entry BEFORE closing it: ch.close() re-enters the
          // channel's own close handler, which would otherwise see the stream
          // still registered and emit a second, error-less exit.
          for (const [streamId, ch] of [...managed.logStreams]) {
            managed.logStreams.delete(streamId);
            try {
              ch.close();
            } catch {
              /* noop */
            }
            this.listeners.onLogExit(streamId, 'The SSH connection closed.');
          }
          managed.logStreams.clear();
          managed.sftp = undefined;
          if (managed.status !== 'error') {
            this.setStatus(profile.id, 'disconnected');
          }
        });

      try {
        client.connect(
          this.buildConfig(
            profile,
            secret,
            this.makeHostVerifier(profile, mismatch),
          ),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus(profile.id, 'error', message);
        settled = true;
        resolve({ ok: false, error: message });
      }

      // Interactive typing dies by Nagle's algorithm: without TCP_NODELAY each
      // keystroke packet can sit in the send buffer waiting on the previous
      // ACK (40–200ms of echo jitter). OpenSSH disables Nagle for interactive
      // sessions; so do we. Safe to call pre-connect — node queues it.
      client.setNoDelay(true);
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
    const signal = opts.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Command aborted before it started.'));
        return;
      }

      let channel: ClientChannel | undefined;
      let aborted = false;
      let settled = false;

      // Abort can fire at three points: before the exec channel opens (still
      // queued / handshaking), or while it's streaming. Track a flag + the
      // channel handle so each case closes the channel and rejects exactly once.
      const onAbort = () => {
        aborted = true;
        if (channel) {
          try {
            channel.close();
          } catch {
            /* noop */
          }
        } else if (!settled) {
          settled = true;
          detach();
          reject(new Error('Command aborted by user.'));
        }
      };
      const detach = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      m.client.exec(command, { pty: false }, (err, ch) => {
        if (settled) {
          // Aborted before the channel opened — close the late channel if the
          // exec still succeeded, and drop it.
          if (!err && ch) {
            try {
              ch.close();
            } catch {
              /* noop */
            }
          }
          return;
        }
        if (err) {
          settled = true;
          detach();
          return reject(err);
        }
        channel = ch;
        if (aborted) {
          // Aborted between listener registration and channel open.
          try {
            ch.close();
          } catch {
            /* noop */
          }
        }

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
            ch.close();
          } catch {
            /* noop */
          }
        }, timeoutMs);

        ch.on('data', (chunk: Buffer) => {
          stdout = append(stdout, chunk);
        })
          .on('exit', (code: number | null) => {
            exitCode = code;
          })
          .on('close', () => {
            clearTimeout(timer);
            detach();
            if (settled) return;
            settled = true;
            if (aborted) {
              reject(new Error('Command aborted by user.'));
              return;
            }
            resolve({
              stdout: stdout.slice(0, maxBytes),
              stderr: stderr.slice(0, maxBytes),
              exitCode,
              truncated,
              timedOut,
            });
          });
        ch.stderr.on('data', (chunk: Buffer) => {
          stderr = append(stderr, chunk);
        });
      });
    });
  }

  // --- port forwarding (Tunnels tab) ----------------------------------------

  /**
   * Open one forwarded TCP channel to `dstHost:dstPort` as resolved from the
   * server. The caller (main/tunnels.ts) owns the local listener and pipes each
   * accepted socket through the channel this returns. Not serialized through
   * `execQueue`: forwarded channels are long-lived, and OpenSSH counts them
   * against MaxSessions separately from exec sessions.
   */
  forwardOut(
    serverId: string,
    dstHost: string,
    dstPort: number,
  ): Promise<ClientChannel> {
    const m = this.requireConnected(serverId);
    return new Promise((resolve, reject) => {
      m.client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, channel) =>
        err ? reject(err) : resolve(channel),
      );
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

          // Coalesce output: buffer chunks that arrive within the same I/O tick
          // and flush them as a single IPC message. This batches bursty output
          // (e.g. `ls -R`, `cat bigfile`) without adding latency to interactive
          // echo, which flushes on the next tick anyway.
          let buffer: Buffer[] = [];
          let scheduled = false;
          const flush = () => {
            scheduled = false;
            if (buffer.length === 0) return;
            const data = Buffer.concat(buffer).toString('utf8');
            buffer = [];
            this.listeners.onShellData(sessionId, data);
          };
          const push = (chunk: Buffer) => {
            buffer.push(chunk);
            if (!scheduled) {
              scheduled = true;
              setImmediate(flush);
            }
          };

          channel
            .on('data', push)
            .on('close', () => {
              flush();
              m.shells.delete(sessionId);
              this.listeners.onShellExit(sessionId);
            });
          channel.stderr.on('data', push);
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

  // --- log follow (Deploys + Artifacts tabs) --------------------------------

  /**
   * Run a long-lived follow command (`tail -f`, `docker logs -f`, `journalctl
   * -f`) and push its output to the renderer as it arrives.
   *
   * Deliberately does NOT go through `exec()`. Execs are serialized per server
   * via `execQueue` to stay under OpenSSH's MaxSessions, and a follow command
   * never returns — queueing one would starve the monitor poller, the agent,
   * and every other exec on that server for as long as the panel stayed open.
   * Like `openShell`, this opens its own channel and is tracked separately.
   *
   * `pty: true` matters for two reasons: `docker logs` only emits ANSI colour
   * when it believes it has a TTY, and a PTY-backed remote process gets SIGHUP
   * when the channel drops — without it, closing the panel leaves an orphaned
   * `tail -f` running on the server forever.
   *
   * The caller is responsible for building `command` safely; see main/logStream.ts.
   */
  openLogStream(
    serverId: string,
    streamId: string,
    command: string,
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    return new Promise((resolve, reject) => {
      m.client.exec(command, { pty: true }, (err, channel) => {
        if (err) return reject(err);
        m.logStreams.set(streamId, channel);

        // Same coalescing as openShell: a build that dumps thousands of lines
        // in one tick becomes one IPC message, not thousands.
        let buffer: Buffer[] = [];
        let scheduled = false;
        const flush = () => {
          scheduled = false;
          if (buffer.length === 0) return;
          const chunk = Buffer.concat(buffer).toString('utf8');
          buffer = [];
          this.listeners.onLogData(streamId, chunk);
        };
        const push = (chunk: Buffer) => {
          buffer.push(chunk);
          if (!scheduled) {
            scheduled = true;
            setImmediate(flush);
          }
        };

        channel.on('data', push).on('close', () => {
          flush();
          // Only report an exit for a stream we still own. closeLogStream()
          // deletes the entry first, so a user-initiated close stays silent.
          if (m.logStreams.delete(streamId)) {
            this.listeners.onLogExit(streamId);
          }
        });
        // With pty:true the remote merges stderr into the pty, but ssh2 still
        // exposes the stream — wire it up so nothing is silently dropped.
        channel.stderr.on('data', push);
        resolve();
      });
    });
  }

  closeLogStream(serverId: string, streamId: string): void {
    const m = this.conns.get(serverId);
    const ch = m?.logStreams.get(streamId);
    if (!m || !ch) return;
    m.logStreams.delete(streamId); // before close() — suppresses the exit event
    try {
      ch.close();
    } catch {
      /* noop */
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
    options: { mode?: number } = {},
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath, options);
      stream.on('error', reject);
      stream.on('close', () => resolve());
      stream.end(content);
    });
  }

  // --- SFTP file browser (user-facing Files tab) ---------------------------

  /** Resolve a path to its absolute form on the server ('.' → the login home). */
  async sftpRealpath(serverId: string, remotePath: string): Promise<string> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      sftp.realpath(remotePath && remotePath.length ? remotePath : '.', (err, abs) =>
        err ? reject(err) : resolve(abs),
      );
    });
  }

  /** List a remote directory. Resolves the path first so breadcrumbs and the
   *  home button always show a canonical absolute path (no trailing '.'/'..'). */
  async sftpList(
    serverId: string,
    remotePath: string,
  ): Promise<{ path: string; entries: SftpEntry[] }> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    const abs = await this.sftpRealpath(serverId, remotePath);
    const list = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(abs, (err, l) => (err ? reject(err) : resolve(l)));
    });
    const entries: SftpEntry[] = list
      .filter((e) => e.filename !== '.' && e.filename !== '..')
      .map((e) => {
        const mode = e.attrs?.mode ?? 0;
        return {
          name: e.filename,
          path: posixJoin(abs, e.filename),
          type: classifyMode(mode),
          size: e.attrs?.size ?? 0,
          // ssh2 reports mtime in whole seconds; the UI wants ms since epoch.
          mtime: (e.attrs?.mtime ?? 0) * 1000,
          mode,
        };
      });
    return { path: abs, entries };
  }

  async sftpMkdir(serverId: string, remotePath: string): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => (err ? reject(err) : resolve()));
    });
  }

  async sftpRename(serverId: string, from: string, to: string): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Delete a file, or a directory and everything under it. Recursion runs
   *  entirely over SFTP (unlink/rmdir) — no shell — so it stays within the same
   *  trust boundary as the rest of the file browser and never follows symlinks
   *  (a symlinked entry is unlinked, not descended into). */
  async sftpDelete(
    serverId: string,
    remotePath: string,
    isDir: boolean,
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    await this.sftpRemovePath(sftp, remotePath, isDir);
  }

  private async sftpRemovePath(
    sftp: SFTPWrapper,
    remotePath: string,
    isDir: boolean,
  ): Promise<void> {
    if (!isDir) {
      return new Promise((resolve, reject) =>
        sftp.unlink(remotePath, (err) => (err ? reject(err) : resolve())),
      );
    }
    const children = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(remotePath, (err, l) => (err ? reject(err) : resolve(l)));
    });
    for (const child of children) {
      if (child.filename === '.' || child.filename === '..') continue;
      const childIsDir = ((child.attrs?.mode ?? 0) & S_IFMT) === S_IFDIR;
      await this.sftpRemovePath(
        sftp,
        posixJoin(remotePath, child.filename),
        childIsDir,
      );
    }
    return new Promise((resolve, reject) =>
      sftp.rmdir(remotePath, (err) => (err ? reject(err) : resolve())),
    );
  }

  /** Stream a remote file down to a local path (binary-safe). */
  async sftpFastGet(
    serverId: string,
    remotePath: string,
    localPath: string,
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  /** Stream a local file up to a remote path (binary-safe). */
  async sftpFastPut(
    serverId: string,
    localPath: string,
    remotePath: string,
  ): Promise<void> {
    const m = this.requireConnected(serverId);
    const sftp = await this.getSftp(m);
    return new Promise((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
