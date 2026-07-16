/**
 * Integration tests for the log-follow channel, driven against a fake ssh2
 * Client. These pin the behaviours the streaming build-log feature depends on
 * and that are easy to regress:
 *
 *  - a follow command opens its OWN channel and does not enter execQueue (a
 *    `tail -f` in the serialized queue would starve monitoring + the agent),
 *  - bursty output is coalesced into one IPC message per tick,
 *  - closing the panel does not surface a bogus "stream ended",
 *  - the remote process ending, or the SSH link dropping, does.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Defined via vi.hoisted: vi.mock's factory is hoisted above the module body,
// so it cannot close over ordinary top-level declarations.
const { FakeClient } = vi.hoisted(() => {
  type Handler = (...args: never[]) => void;

  /** Minimal EventEmitter. Hand-rolled rather than imported, because the
   *  hoisted factory runs before module imports are available. `on` chains,
   *  which ssh2 callers rely on. */
  class EE {
    private handlers = new Map<string, Handler[]>();
    on(event: string, fn: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): boolean {
      const list = this.handlers.get(event);
      if (!list?.length) return false;
      for (const fn of [...list]) (fn as (...a: unknown[]) => void)(...args);
      return true;
    }
  }

  /** A fake ssh2 exec channel: data + stderr + close, like a real ClientChannel. */
  class FakeChannel extends EE {
    stderr = new EE();
    closed = false;
    close() {
      this.closed = true;
      this.emit('close');
    }
  }

  /** A fake ssh2 Client that connects successfully and records exec()s. */
  class FakeClientImpl extends EE {
    static last: FakeClientImpl | null = null;
    execs: string[] = [];
    channels: FakeChannel[] = [];
    /** Set to make exec() fail, to test the error path. */
    failExec: Error | null = null;

    constructor() {
      super();
      FakeClientImpl.last = this;
    }
    setNoDelay() {}
    connect() {
      setImmediate(() => this.emit('ready'));
    }
    end() {
      this.emit('close');
    }
    exec(
      command: string,
      _opts: unknown,
      cb: (err: Error | null, ch?: FakeChannel) => void,
    ) {
      this.execs.push(command);
      if (this.failExec) {
        cb(this.failExec);
        return;
      }
      const ch = new FakeChannel();
      this.channels.push(ch);
      cb(null, ch);
    }
  }

  return { FakeClient: FakeClientImpl };
});

vi.mock('ssh2', () => ({
  Client: FakeClient,
  utils: { parseKey: () => ({}) },
}));
// The host-key check is not what's under test here.
vi.mock('./knownHosts', () => ({ verifyAndPin: () => 'ok' }));

import { ConnectionManager } from './connection-manager';

const PROFILE = {
  id: 'srv1',
  name: 'test',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authType: 'password' as const,
  createdAt: 0,
};

/** Let queued setImmediate/microtask work (the coalescing flush) run. */
const tick = () => new Promise((r) => setImmediate(r));

function makeCm() {
  const logData: { streamId: string; chunk: string }[] = [];
  const logExit: { streamId: string; error?: string }[] = [];
  const cm = new ConnectionManager({
    onStatus: () => {},
    onShellData: () => {},
    onShellExit: () => {},
    onLogData: (streamId, chunk) => logData.push({ streamId, chunk }),
    onLogExit: (streamId, error) => logExit.push({ streamId, error }),
  });
  return { cm, logData, logExit };
}

describe('openLogStream', () => {
  beforeEach(() => {
    FakeClient.last = null;
  });

  it('runs the follow command and streams its output to the renderer', async () => {
    const { cm, logData } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });

    await cm.openLogStream('srv1', 'log_1', "tail -n 500 -F '/var/log/a.log'");
    const client = FakeClient.last!;
    expect(client.execs).toEqual(["tail -n 500 -F '/var/log/a.log'"]);

    const ch = client.channels[0];
    ch.emit('data', Buffer.from('hello\n'));
    await tick();

    expect(logData).toEqual([{ streamId: 'log_1', chunk: 'hello\n' }]);
  });

  it('coalesces a burst of output into one message per tick', async () => {
    const { cm, logData } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    await cm.openLogStream('srv1', 'log_1', 'tail -f x');

    const ch = FakeClient.last!.channels[0];
    // A build dumping many lines within one I/O tick must not become one IPC
    // message per line.
    ch.emit('data', Buffer.from('a\n'));
    ch.emit('data', Buffer.from('b\n'));
    ch.emit('data', Buffer.from('c\n'));
    await tick();

    expect(logData).toHaveLength(1);
    expect(logData[0].chunk).toBe('a\nb\nc\n');
  });

  it('merges stderr into the same stream', async () => {
    const { cm, logData } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    await cm.openLogStream('srv1', 'log_1', 'journalctl -f');

    const ch = FakeClient.last!.channels[0];
    ch.stderr.emit('data', Buffer.from('warning: something\n'));
    await tick();

    expect(logData[0].chunk).toBe('warning: something\n');
  });

  it('does NOT block the serialized exec queue', async () => {
    const { cm } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });

    // Open a follow that never ends...
    await cm.openLogStream('srv1', 'log_1', 'tail -f x');

    // ...then run a normal exec. If the follow had gone through execQueue this
    // would never resolve, and monitoring/the agent would hang behind it.
    const execPromise = cm.exec('srv1', 'uptime');
    await tick();
    const execChannel = FakeClient.last!.channels[1];
    expect(execChannel).toBeDefined(); // the exec got its own channel immediately
    execChannel.emit('data', Buffer.from('up 3 days'));
    execChannel.emit('exit', 0);
    execChannel.close();

    const res = await execPromise;
    expect(res.stdout).toBe('up 3 days');
    expect(res.exitCode).toBe(0);
  });

  it('reports an exit when the remote follow process ends on its own', async () => {
    const { cm, logExit } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    await cm.openLogStream('srv1', 'log_1', 'docker logs -f web');

    FakeClient.last!.channels[0].close(); // e.g. the container was removed
    await tick();

    expect(logExit).toEqual([{ streamId: 'log_1', error: undefined }]);
  });

  it('stays silent when the user closes the panel', async () => {
    const { cm, logExit } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    await cm.openLogStream('srv1', 'log_1', 'tail -f x');

    cm.closeLogStream('srv1', 'log_1');
    await tick();

    // The channel really closed, but a user-initiated close is not an "exit" —
    // surfacing one would flash "stream ended" as the panel unmounts.
    expect(FakeClient.last!.channels[0].closed).toBe(true);
    expect(logExit).toEqual([]);
  });

  it('flushes pending output before reporting the exit', async () => {
    const { cm, logData, logExit } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    await cm.openLogStream('srv1', 'log_1', 'tail -f x');

    const ch = FakeClient.last!.channels[0];
    // Last line and close land in the same tick — the line must not be lost.
    ch.emit('data', Buffer.from('final line\n'));
    ch.close();
    await tick();

    expect(logData[0].chunk).toBe('final line\n');
    expect(logExit).toHaveLength(1);
  });

  it('tells the renderer when the whole SSH connection drops', async () => {
    const { cm, logExit } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    await cm.openLogStream('srv1', 'log_1', 'tail -f x');

    FakeClient.last!.emit('close'); // link died
    await tick();

    expect(logExit).toHaveLength(1);
    expect(logExit[0].streamId).toBe('log_1');
    expect(logExit[0].error).toMatch(/connection closed/i);
  });

  it('rejects when the channel cannot be opened', async () => {
    const { cm } = makeCm();
    await cm.connect(PROFILE, { password: 'x' });
    FakeClient.last!.failExec = new Error('channel open failure');

    await expect(
      cm.openLogStream('srv1', 'log_1', 'tail -f x'),
    ).rejects.toThrow('channel open failure');
  });

  it('refuses to follow on a server that is not connected', () => {
    const { cm } = makeCm();
    expect(() => cm.openLogStream('nope', 'log_1', 'tail -f x')).toThrow(
      /not connected/i,
    );
  });
});
