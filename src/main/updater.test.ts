import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '../shared/ipc-types';

const { electronApp } = vi.hoisted(() => ({
  electronApp: {
    isPackaged: false,
    getVersion: () => '1.0.1',
    quit: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: electronApp,
  shell: { openExternal: vi.fn() },
}));

import {
  AppUpdater,
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

describe('AppUpdater auto-download', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    electronApp.isPackaged = false;
    vi.unstubAllGlobals();
  });

  it('stages a detected update in the background, ready to install', async () => {
    // Run as a packaged macOS build so the updater is enabled and a zip asset
    // exists for the platform (Linux CI would otherwise disable it).
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    electronApp.isPackaged = true;

    const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const fetchMock = vi
      .fn()
      // 1st call: the GitHub "latest release" check.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'v1.0.2',
          html_url: 'https://github.com/example/releases/tag/v1.0.2',
          assets: [
            {
              name: `Tevada.DevOps-darwin-${process.arch}-1.0.2.zip`,
              browser_download_url: 'https://example.test/update.zip',
              size: zipBytes.byteLength,
            },
          ],
        }),
      })
      // 2nd call: the asset download, started automatically by check().
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => String(zipBytes.byteLength) },
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () =>
                sent
                  ? { done: true, value: undefined }
                  : ((sent = true), { done: false, value: zipBytes }),
            };
          },
        },
      });
    vi.stubGlobal('fetch', fetchMock);

    const states: UpdateState[] = [];
    const updater = new AppUpdater((s) => states.push(s), 'example/repo');
    await updater.check();

    // check() kicks the download off without awaiting it.
    await vi.waitFor(() => expect(updater.getState().status).toBe('downloaded'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Collapse repeated statuses (progress events re-emit 'downloading').
    const sequence = states
      .map((s) => s.status)
      .filter((status, i, all) => i === 0 || status !== all[i - 1]);
    expect(sequence).toEqual(['checking', 'available', 'downloading', 'downloaded']);
    expect(updater.getState().availableVersion).toBe('1.0.2');
  });

  it('does not re-check once an update is staged', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    electronApp.isPackaged = true;

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const updater = new AppUpdater(() => {}, 'example/repo');
    // Forcing the staged state through the public API needs a download, so
    // simulate it directly: a check while 'downloaded' must be a no-op.
    (updater as unknown as { state: UpdateState }).state = {
      status: 'downloaded',
      currentVersion: '1.0.1',
      availableVersion: '1.0.2',
    };
    await updater.check();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
