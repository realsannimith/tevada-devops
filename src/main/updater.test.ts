import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: () => '1.0.1',
    quit: vi.fn(),
  },
  shell: { openExternal: vi.fn() },
}));

import {
  buildMacSwapScript,
  isVersionNewer,
  pickUpdateAsset,
  type ReleaseAsset,
} from './updater';

describe('isVersionNewer', () => {
  it('compares semver fields in order', () => {
    expect(isVersionNewer('1.0.0', '1.0.1')).toBe(true);
    expect(isVersionNewer('1.0.1', '1.1.0')).toBe(true);
    expect(isVersionNewer('1.9.9', '2.0.0')).toBe(true);
    expect(isVersionNewer('1.0.1', '1.0.1')).toBe(false);
    expect(isVersionNewer('1.0.2', '1.0.1')).toBe(false);
  });

  it('accepts a leading v and treats stable as newer than its own prerelease', () => {
    expect(isVersionNewer('1.0.0', 'v1.0.1')).toBe(true);
    expect(isVersionNewer('1.0.1-beta.1', '1.0.1')).toBe(true);
    expect(isVersionNewer('1.0.1', '1.0.1-beta.1')).toBe(false);
  });
});

describe('pickUpdateAsset', () => {
  const assets: ReleaseAsset[] = [
    { name: 'tevada-devops-1.0.1-1.x86_64.rpm', browser_download_url: 'u1', size: 1 },
    { name: 'tevada-devops_1.0.1_amd64.deb', browser_download_url: 'u2', size: 1 },
    { name: 'Tevada.DevOps-1.0.1-arm64.dmg', browser_download_url: 'u3', size: 1 },
    { name: 'Tevada.DevOps-1.0.1.Setup.exe', browser_download_url: 'u4', size: 1 },
    { name: 'Tevada.DevOps-darwin-arm64-1.0.1.zip', browser_download_url: 'u5', size: 1 },
    { name: 'Tevada.DevOps-darwin-x64-1.0.1.zip', browser_download_url: 'u6', size: 1 },
    { name: 'tevada_devops-1.0.1-full.nupkg', browser_download_url: 'u7', size: 1 },
  ];

  it('picks the darwin zip matching the arch (not the dmg)', () => {
    expect(pickUpdateAsset(assets, 'darwin', 'arm64')?.name).toBe(
      'Tevada.DevOps-darwin-arm64-1.0.1.zip',
    );
    expect(pickUpdateAsset(assets, 'darwin', 'x64')?.name).toBe(
      'Tevada.DevOps-darwin-x64-1.0.1.zip',
    );
  });

  it('picks Setup.exe on Windows and nothing on Linux', () => {
    expect(pickUpdateAsset(assets, 'win32', 'x64')?.name).toBe(
      'Tevada.DevOps-1.0.1.Setup.exe',
    );
    expect(pickUpdateAsset(assets, 'linux', 'x64')).toBeNull();
  });
});

describe('buildMacSwapScript', () => {
  it('waits for the pid, swaps with rollback, and relaunches', () => {
    const script = buildMacSwapScript({
      pid: 4242,
      appBundlePath: "/Applications/Tevada DevOps.app",
      stagedAppPath: '/tmp/stage/Tevada DevOps.app',
      backupPath: '/tmp/stage/previous-bundle.app',
    });
    expect(script).toContain('kill -0 4242');
    expect(script).toContain("mv '/Applications/Tevada DevOps.app' '/tmp/stage/previous-bundle.app'");
    expect(script).toContain("mv '/tmp/stage/Tevada DevOps.app' '/Applications/Tevada DevOps.app'");
    // Failure path restores the backup before ever deleting it.
    expect(script).toContain("mv '/tmp/stage/previous-bundle.app' '/Applications/Tevada DevOps.app'");
    expect(script).toContain("open '/Applications/Tevada DevOps.app'");
  });
});
