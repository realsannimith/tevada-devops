/**
 * In-app updates — same design as FCode's desktop updater, adapted to this
 * app's electron-forge + GitHub Releases pipeline:
 *
 *  - Detect: poll the GitHub "latest release" API (on startup, every 4 h, and
 *    on demand) and compare tags semver-style against the running version.
 *  - Download: starts automatically in the background as soon as an update is
 *    detected (FCode's prepare-in-background step), streaming the platform's
 *    installer asset to a temp dir with progress events pushed to the
 *    renderer. Installing — and the restart it implies — stays user-controlled
 *    so active work is never interrupted.
 *  - Install:
 *      macOS   — our builds are ad-hoc signed, which Squirrel.Mac refuses, so
 *                we swap the .app bundle directly (FCode's unsigned-mac path):
 *                extract with ditto, strip quarantine, then a detached script
 *                waits for the app to quit, swaps the bundle (with rollback),
 *                and relaunches.
 *      Windows — launch the downloaded Squirrel Setup.exe and quit; it
 *                updates in place and restarts the app.
 *      Linux   — deb/rpm installs can't safely self-replace; we open the
 *                release page instead.
 */
import * as ChildProcess from 'node:child_process';
import * as FS from 'node:fs';
import * as OS from 'node:os';
import * as Path from 'node:path';
import { app, shell } from 'electron';
import type { UpdateState } from '../shared/ipc-types';

/** GitHub repo whose Releases feed serves this app's updates. */
const UPDATE_REPO = 'realsannimith/tevada-devops';

const STARTUP_DELAY_MS = 15_000;
const POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// --- version comparison (ported from FCode's updateState.ts) -------------------

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};

function parseVersion(version: string): ParsedVersion | null {
  const m = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

export function isVersionNewer(currentVersion: string, candidateVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const candidate = parseVersion(candidateVersion);
  if (!current || !candidate) {
    return candidateVersion.trim() !== currentVersion.trim();
  }
  if (candidate.major !== current.major) return candidate.major > current.major;
  if (candidate.minor !== current.minor) return candidate.minor > current.minor;
  if (candidate.patch !== current.patch) return candidate.patch > current.patch;
  // Stable beats the same version's prerelease; never reinstall the same stable.
  return current.prerelease !== null && candidate.prerelease === null;
}

// --- release asset selection ----------------------------------------------------

export type ReleaseAsset = { name: string; browser_download_url: string; size: number };

/**
 * Pick the installer for this platform/arch from a release's asset list.
 * Returns null when the platform has no in-app install path (Linux).
 */
export function pickUpdateAsset(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
): ReleaseAsset | null {
  if (platform === 'darwin') {
    // The forge ZIP maker names these Tevada.DevOps-darwin-<arch>-<version>.zip.
    return (
      assets.find(
        (a) => a.name.includes(`darwin-${arch}`) && a.name.endsWith('.zip'),
      ) ?? null
    );
  }
  if (platform === 'win32') {
    return assets.find((a) => a.name.endsWith('Setup.exe')) ?? null;
  }
  return null;
}

// --- unsigned-mac direct install (ported from FCode) -----------------------------

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Detached installer script: waits (bounded) for the app to exit, moves the old
 * bundle aside, moves the new one into place, and relaunches. Any failure
 * restores the old bundle so the user is never left without an app.
 */
export function buildMacSwapScript(args: {
  pid: number;
  appBundlePath: string;
  stagedAppPath: string;
  backupPath: string;
}): string {
  const appPath = shellQuote(args.appBundlePath);
  const staged = shellQuote(args.stagedAppPath);
  const backup = shellQuote(args.backupPath);
  return [
    '#!/bin/bash',
    '# Tevada DevOps update installer (unsigned build). Generated at install time.',
    'for _ in $(seq 1 300); do',
    `  kill -0 ${args.pid} 2>/dev/null || break`,
    '  sleep 0.2',
    'done',
    `if kill -0 ${args.pid} 2>/dev/null; then`,
    '  exit 1',
    'fi',
    `if ! mv ${appPath} ${backup}; then`,
    '  exit 1',
    'fi',
    `if mv ${staged} ${appPath}; then`,
    `  rm -rf ${backup}`,
    'else',
    `  mv ${backup} ${appPath}`,
    'fi',
    `open ${appPath}`,
    '',
  ].join('\n');
}

function resolveMacAppBundlePath(execPath: string): string | null {
  // .../Tevada DevOps.app/Contents/MacOS/Tevada DevOps → .../Tevada DevOps.app
  const bundlePath = Path.resolve(execPath, '..', '..', '..');
  return bundlePath.endsWith('.app') ? bundlePath : null;
}

/** Extract the zip, strip quarantine, and spawn the detached swap script.
 *  The caller must quit right after; the swap happens once the process exits. */
function prepareMacInstall(zipPath: string): void {
  const appBundlePath = resolveMacAppBundlePath(process.execPath);
  if (!appBundlePath) {
    throw new Error('Could not locate the running .app bundle.');
  }
  const stageDir = FS.mkdtempSync(Path.join(OS.tmpdir(), 'tevada-update-'));

  // ditto preserves the symlinked framework structure; plain unzip does not.
  const extraction = ChildProcess.spawnSync('ditto', ['-x', '-k', zipPath, stageDir], {
    encoding: 'utf8',
    timeout: 5 * 60_000,
  });
  if (extraction.status !== 0) {
    throw new Error(
      `Could not extract the update (ditto exited ${extraction.status ?? 'null'}): ${(extraction.stderr ?? '').trim()}`,
    );
  }

  const apps = FS.readdirSync(stageDir).filter((e) => e.endsWith('.app'));
  if (apps.length !== 1) {
    throw new Error('Update archive did not contain exactly one .app bundle.');
  }
  const stagedAppPath = Path.join(stageDir, apps[0]);

  // Without this Gatekeeper reports the swapped-in app as damaged.
  ChildProcess.spawnSync('xattr', ['-dr', 'com.apple.quarantine', stagedAppPath], {
    timeout: 60_000,
  });

  const script = buildMacSwapScript({
    pid: process.pid,
    appBundlePath,
    stagedAppPath,
    backupPath: Path.join(stageDir, 'previous-bundle.app'),
  });
  const scriptPath = Path.join(stageDir, 'install.sh');
  FS.writeFileSync(scriptPath, script, { mode: 0o700 });
  ChildProcess.spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
}

// --- the updater ------------------------------------------------------------------

export class AppUpdater {
  private state: UpdateState;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private assetUrl: string | null = null;
  private assetName: string | null = null;
  private downloadedPath: string | null = null;

  constructor(
    private readonly onChange: (state: UpdateState) => void = () => {},
    /** Test seam — production callers always use the baked-in feed. */
    private readonly repo: string = UPDATE_REPO,
  ) {
    const disabledReason = !this.repo
      ? 'No update feed is configured for this build.'
      : !app.isPackaged
        ? 'Updates only run in packaged builds.'
        : process.platform === 'linux'
          ? 'On Linux, install updates with your package manager from the releases page.'
          : undefined;
    this.state = {
      status: disabledReason ? 'disabled' : 'idle',
      currentVersion: app.getVersion(),
      disabledReason,
    };
  }

  getState(): UpdateState {
    return this.state;
  }

  /** Startup (+15 s) and 4-hourly background checks, like FCode. */
  startAutoChecks(): void {
    if (this.state.status === 'disabled') return;
    this.startupTimer = setTimeout(() => void this.check(), STARTUP_DELAY_MS);
    this.pollTimer = setInterval(() => void this.check(), POLL_INTERVAL_MS);
  }

  dispose(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  async check(): Promise<UpdateState> {
    // Like FCode, don't re-check while an update is mid-download or already
    // staged — the staged build installs on the next restart anyway.
    if (this.state.status === 'disabled' || this.state.status === 'downloaded' || this.busy) {
      return this.state;
    }
    this.busy = true;
    this.setState({ status: 'checking', error: undefined });
    try {
      const res = await fetch(
        `https://api.github.com/repos/${this.repo}/releases/latest`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'tevada-devops-updater',
          },
          signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        },
      );
      if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
      const release = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        assets?: ReleaseAsset[];
      };
      const tag = release.tag_name ?? '';
      const candidate = tag.replace(/^v/, '');
      const checkedAt = new Date().toISOString();
      if (!candidate || !isVersionNewer(this.state.currentVersion, candidate)) {
        this.setState({ status: 'up-to-date', checkedAt, availableVersion: undefined });
        return this.state;
      }
      const asset = pickUpdateAsset(release.assets ?? [], process.platform, process.arch);
      this.assetUrl = asset?.browser_download_url ?? null;
      this.assetName = asset?.name ?? null;
      this.setState({
        status: 'available',
        checkedAt,
        availableVersion: candidate,
        releaseUrl: release.html_url,
        canInstallInApp: this.assetUrl !== null,
      });
    } catch (err) {
      this.setState({
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
    }
    // Auto-download (FCode's prepare-in-background): stage the update as soon
    // as it is detected so installing is just a restart. User-triggered
    // installs still work if this background attempt fails.
    if (this.state.status === 'available' && this.assetUrl) {
      void this.download();
    }
    return this.state;
  }

  /** Stream the platform asset to a temp file with progress. Runs
   *  automatically after a successful check; safe to retry after a failure. */
  async download(): Promise<UpdateState> {
    if (this.busy || this.state.status !== 'available' || !this.assetUrl) {
      return this.state;
    }
    this.busy = true;
    this.setState({ status: 'downloading', downloadPercent: 0, error: undefined });
    try {
      const res = await fetch(this.assetUrl, {
        headers: { 'User-Agent': 'tevada-devops-updater' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}.`);
      const total = Number(res.headers.get('content-length')) || 0;
      const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), 'tevada-download-'));
      const filePath = Path.join(dir, this.assetName ?? 'update.bin');
      const out = FS.createWriteStream(filePath);
      const reader = res.body.getReader();
      let received = 0;
      let lastStep = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        await new Promise<void>((resolve, reject) => {
          out.write(Buffer.from(value), (e) => (e ? reject(e) : resolve()));
        });
        if (total > 0) {
          const percent = Math.min(100, (received / total) * 100);
          // Broadcast at most one event per whole percent (FCode's throttle).
          const step = Math.floor(percent);
          if (step !== lastStep) {
            lastStep = step;
            this.setState({ downloadPercent: percent });
          }
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end((e?: Error | null) => (e ? reject(e) : resolve()));
      });

      this.downloadedPath = filePath;
      this.setState({ status: 'downloaded', downloadPercent: 100 });
    } catch (err) {
      this.downloadedPath = null;
      this.setState({
        status: 'available',
        error: err instanceof Error ? err.message : String(err),
        downloadPercent: undefined,
      });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  /** Hand the staged download to the platform installer and quit. On macOS the
   *  detached script relaunches the new version. If the background download
   *  failed (status is back to "available"), retry it first. */
  async install(): Promise<UpdateState> {
    if (this.state.status === 'available') {
      await this.download();
    }
    if (this.busy || this.state.status !== 'downloaded' || !this.downloadedPath) {
      return this.state;
    }
    this.busy = true;
    this.setState({ status: 'installing', error: undefined });
    try {
      if (process.platform === 'darwin') {
        prepareMacInstall(this.downloadedPath);
        app.quit();
      } else if (process.platform === 'win32') {
        // Squirrel Setup.exe updates in place and restarts the app.
        ChildProcess.spawn(this.downloadedPath, ['--silent'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        app.quit();
      } else {
        throw new Error('In-app install is not supported on this platform.');
      }
    } catch (err) {
      this.setState({
        status: 'downloaded',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy = false;
    }
    return this.state;
  }

  async openReleasesPage(): Promise<void> {
    await shell.openExternal(
      this.state.releaseUrl ?? `https://github.com/${this.repo}/releases/latest`,
    );
  }
}
