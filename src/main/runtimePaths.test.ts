import { describe, expect, it } from 'vitest';

import {
  isDevelopmentRuntime,
  resolveAppDataBase,
  resolveAppDisplayName,
  resolveAppUserModelId,
  resolveRuntimeHome,
  resolveStateDir,
  resolveUserDataPath,
} from './runtimePaths';

describe('runtimePaths', () => {
  it('resolves EASYHOST_HOME when configured', () => {
    expect(resolveRuntimeHome({ EASYHOST_HOME: '/custom/runtime' })).toBe('/custom/runtime');
  });

  it('defaults runtime home to ~/.easyhost', () => {
    expect(resolveRuntimeHome({})).toMatch(/\.easyhost$/);
  });

  it('resolves dev/prod userData profile names', () => {
    const appDataBase = '/Users/tester/Library/Application Support';

    expect(resolveUserDataPath({ appDataBase, isDevelopment: true })).toBe(
      '/Users/tester/Library/Application Support/easyhost-dev',
    );
    expect(resolveUserDataPath({ appDataBase, isDevelopment: false })).toBe(
      '/Users/tester/Library/Application Support/easyhost',
    );
  });

  it('uses XDG_CONFIG_HOME on Linux when available', () => {
    expect(
      resolveAppDataBase({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: '/tmp/xdg' },
        homeDir: '/home/tester',
      }),
    ).toBe('/tmp/xdg');
  });

  it('resolves state dir under runtime home', () => {
    expect(resolveStateDir('/custom/runtime')).toBe('/custom/runtime/userdata');
  });

  it('detects development runtime from explicit flag or env', () => {
    expect(isDevelopmentRuntime(true)).toBe(true);
    expect(isDevelopmentRuntime(false)).toBe(false);
    expect(isDevelopmentRuntime(undefined, { VITE_DEV_SERVER_URL: 'http://localhost:5733' })).toBe(
      true,
    );
  });

  it('resolves app identity for dev vs prod', () => {
    expect(resolveAppDisplayName(true)).toBe('Tevada DevOps (Dev)');
    expect(resolveAppDisplayName(false)).toBe('Tevada DevOps');
    expect(resolveAppUserModelId(true)).toBe('com.sannimith.easyhost.dev');
    expect(resolveAppUserModelId(false)).toBe('com.sannimith.easyhost');
  });
});
