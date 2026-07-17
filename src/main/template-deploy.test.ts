import { describe, expect, it, vi } from 'vitest';
import {
  buildOverrideYaml,
  composeReadiness,
  parseComposePs,
  parseListeningPorts,
  parseTemplateCredentials,
  pickHostPort,
  redactSensitiveText,
  safeMountPath,
  TemplateDeployManager,
} from './template-deploy';

describe('parseListeningPorts', () => {
  it('reads ports from ss -tlnp output', () => {
    const out = [
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port',
      'LISTEN 0      511          0.0.0.0:80         0.0.0.0:*',
      'LISTEN 0      128             [::]:22            [::]:*',
      'LISTEN 0      70         127.0.0.1:33060      0.0.0.0:*',
    ].join('\n');
    const ports = parseListeningPorts(out);
    expect(ports.has(80)).toBe(true);
    expect(ports.has(22)).toBe(true);
    expect(ports.has(33060)).toBe(true);
    expect(ports.has(443)).toBe(false);
  });

  it('ignores junk and out-of-range numbers', () => {
    const ports = parseListeningPorts('foo bar:99999 nonsense\n');
    expect(ports.size).toBe(0);
  });
});

describe('pickHostPort', () => {
  it('prefers the container port when free', () => {
    expect(pickHostPort(8080, new Set([80, 443]))).toBe(8080);
  });

  it('walks to the next free port when taken', () => {
    expect(pickHostPort(8080, new Set([8080, 8081]))).toBe(8082);
  });

  it('never picks a privileged port', () => {
    expect(pickHostPort(80, new Set([80]))).toBeGreaterThanOrEqual(1024);
  });
});

describe('buildOverrideYaml', () => {
  it('emits one ports entry per service', () => {
    const yaml = buildOverrideYaml([
      { serviceName: 'web', hostPort: 8080, containerPort: 80 },
      { serviceName: 'api', hostPort: 3000, containerPort: 3000 },
    ]);
    expect(yaml).toBe(
      [
        'services:',
        '  web:',
        '    ports:',
        '      - "8080:80"',
        '  api:',
        '    ports:',
        '      - "3000:3000"',
        '',
      ].join('\n'),
    );
  });
});

describe('parseComposePs', () => {
  it('parses line-delimited JSON (compose v2.21+)', () => {
    const out =
      '{"Name":"app-web-1","Service":"web","State":"running","Health":"healthy"}\n' +
      '{"Name":"app-db-1","Service":"db","State":"exited"}';
    expect(parseComposePs(out)).toEqual([
      { name: 'web', state: 'running', health: 'healthy' },
      { name: 'db', state: 'exited' },
    ]);
  });

  it('parses a JSON array (older compose builds)', () => {
    const out = '[{"Name":"app-web-1","State":"Running"}]';
    expect(parseComposePs(out)).toEqual([
      { name: 'app-web-1', state: 'running' },
    ]);
  });

  it('returns [] for unparseable output', () => {
    expect(parseComposePs('NAME  STATUS\nweb   Up 2 seconds')).toEqual([]);
    expect(parseComposePs('')).toEqual([]);
  });
});

describe('composeReadiness', () => {
  it('accepts running services with healthy or absent health checks', () => {
    expect(
      composeReadiness([
        { name: 'web', state: 'running', health: 'healthy' },
        { name: 'worker', state: 'running' },
      ]),
    ).toEqual({ ready: true, pending: false });
  });

  it('keeps polling empty output and starting health checks', () => {
    expect(composeReadiness([])).toMatchObject({ ready: false, pending: true });
    expect(
      composeReadiness([{ name: 'web', state: 'running', health: 'starting' }]),
    ).toMatchObject({ ready: false, pending: true });
  });

  it('rejects non-running and unhealthy services', () => {
    expect(
      composeReadiness([{ name: 'web', state: 'restarting' }]),
    ).toMatchObject({ ready: false, pending: false });
    expect(
      composeReadiness([{ name: 'web', state: 'running', health: 'unhealthy' }]),
    ).toMatchObject({ ready: false, pending: false });
  });
});

describe('safeMountPath', () => {
  it('normalizes safe paths beneath the app files directory', () => {
    expect(safeMountPath('config/../config/app.ini')).toBe('config/app.ini');
  });

  it('rejects absolute and traversing paths', () => {
    expect(() => safeMountPath('/etc/passwd')).toThrow('Unsafe template mount path');
    expect(() => safeMountPath('../../root/.ssh/authorized_keys')).toThrow(
      'Unsafe template mount path',
    );
    expect(() => safeMountPath('config; touch /tmp/pwned')).toThrow(
      'Unsafe template mount path',
    );
  });
});

describe('template credential handling', () => {
  it('parses values containing equals signs and redacts secret values from logs', () => {
    const credentials = parseTemplateCredentials([
      'APP_URL=https://example.com?a=b',
      'ADMIN_PASSWORD=super-secret',
      'MALFORMED',
    ]);
    expect(credentials).toEqual([
      { key: 'APP_URL', value: 'https://example.com?a=b' },
      { key: 'ADMIN_PASSWORD', value: 'super-secret' },
    ]);
    expect(
      redactSensitiveText(
        'started https://example.com?a=b with password super-secret',
        credentials,
      ),
    ).toBe('started https://example.com?a=b with password [REDACTED]');
  });
});

describe('TemplateDeployManager lifecycle', () => {
  it('uses the renderer-created id and emits synchronous startup failures against it', async () => {
    const send = vi.fn();
    const manager = new TemplateDeployManager({
      cm: {} as never,
      connect: vi.fn(async () => ({ ok: true })),
      getServer: () => undefined,
      send,
    });
    const deployId = 'template_123e4567-e89b-12d3-a456-426614174000';

    expect(
      manager.start({ deployId, serverId: 'missing', templateId: 'wordpress' }),
    ).toEqual({ deployId });
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith({
        deployId,
        type: 'error',
        error: 'Unknown server.',
      });
    });
  });

  it('rejects malformed deploy and template ids before starting', () => {
    const manager = new TemplateDeployManager({
      cm: {} as never,
      connect: vi.fn(async () => ({ ok: true })),
      getServer: () => undefined,
      send: vi.fn(),
    });
    expect(() =>
      manager.start({ deployId: 'bad', serverId: 'srv', templateId: 'wordpress' }),
    ).toThrow('Invalid template deploy id');
    expect(() =>
      manager.start({
        deployId: 'template_123e4567-e89b-12d3-a456-426614174000',
        serverId: 'srv',
        templateId: '../../escape',
      }),
    ).toThrow('Invalid template id');
  });
});
