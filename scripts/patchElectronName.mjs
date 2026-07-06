/**
 * Make the DEV app say "Tevada DevOps (Dev)" instead of "Electron" in the dock
 * tooltip, menu bar and app switcher — the same trick FCode desktop uses.
 *
 * Why a COPY (not an in-place edit): in dev the app runs from the
 * `node_modules/electron` bundle, and macOS's LaunchServices has that PATH
 * cached as "Electron" from every prior launch. Editing its Info.plist in place
 * does NOT bust that cache, so the dock tooltip keeps saying "Electron". The fix
 * is to launch from a FRESH bundle path with a UNIQUE CFBundleIdentifier, which
 * LaunchServices registers as a brand-new app and reads fresh — exactly what
 * FCode does. We copy the bundle into `.electron-runtime/Tevada DevOps (Dev).app`,
 * rename it, register it, and point Forge directly at that bundle's executable.
 *
 * Copy with `ditto`, NOT `fs.cpSync`: cpSync rewrites the framework's relative
 * symlinks to absolute paths and drops `icudtl.dat`, so the copy crashes on
 * launch. `ditto` is bundle-aware and copies it faithfully. macOS only.
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE_VERSION = 6;
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

function plistGet(plistPath, key) {
  const r = spawnSync('plutil', ['-extract', key, 'raw', plistPath], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

function plistSet(plistPath, key, value) {
  if (spawnSync('plutil', ['-replace', key, '-string', value, plistPath]).status === 0) return;
  spawnSync('plutil', ['-insert', key, '-string', value, plistPath]);
}

/** Undo any earlier in-place rename of the real node_modules bundle so it
 *  doesn't collide (same bundle id) with our copy. */
function restorePristineElectron(sourceApp) {
  const info = join(sourceApp, 'Contents', 'Info.plist');
  if (!existsSync(info) || plistGet(info, 'CFBundleName') === 'Electron') return;
  plistSet(info, 'CFBundleName', 'Electron');
  plistSet(info, 'CFBundleIdentifier', 'com.github.Electron');
  spawnSync('plutil', ['-remove', 'CFBundleDisplayName', info]);
}

function patchMainBundle(appBundle, displayName, bundleId, iconPath) {
  const info = join(appBundle, 'Contents', 'Info.plist');
  plistSet(info, 'CFBundleDisplayName', displayName);
  plistSet(info, 'CFBundleName', displayName);
  plistSet(info, 'CFBundleIdentifier', bundleId);
  plistSet(info, 'CFBundleExecutable', 'Electron');
  if (existsSync(iconPath)) {
    plistSet(info, 'CFBundleIconFile', 'icon.icns');
    const resources = join(appBundle, 'Contents', 'Resources');
    copyFileSync(iconPath, join(resources, 'icon.icns'));
    copyFileSync(iconPath, join(resources, 'electron.icns'));
  }
}

function patchHelperBundles(appBundle, displayName, bundleId) {
  const frameworks = join(appBundle, 'Contents', 'Frameworks');
  if (!existsSync(frameworks)) return;
  for (const entry of readdirSync(frameworks, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
    if (!entry.name.startsWith('Electron Helper')) continue;
    const info = join(frameworks, entry.name, 'Contents', 'Info.plist');
    if (!existsSync(info)) continue;
    const suffix = entry.name.replace('Electron Helper', '').replace('.app', '').trim();
    const helperName = suffix ? `${displayName} Helper ${suffix}` : `${displayName} Helper`;
    const idSuffix = suffix.replace(/[()]/g, '').trim().toLowerCase().replace(/\s+/g, '-');
    plistSet(info, 'CFBundleDisplayName', helperName);
    plistSet(info, 'CFBundleName', helperName);
    plistSet(info, 'CFBundleIdentifier', idSuffix ? `${bundleId}.helper.${idSuffix}` : `${bundleId}.helper`);
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build (or reuse) the name-patched Electron app and return its executable path.
 * Returns null on non-macOS.
 */
export function buildPatchedElectronBinaryPath({ isDevelopment }) {
  if (process.platform !== 'darwin') return null;

  const displayName = isDevelopment ? 'Tevada DevOps (Dev)' : 'Tevada DevOps';
  const bundleId = isDevelopment ? 'com.sannimith.tevada.dev' : 'com.sannimith.tevada';

  const require = createRequire(import.meta.url);
  const electronBinary = require('electron'); // …/dist/Electron.app/Contents/MacOS/Electron
  const sourceApp = resolve(electronBinary, '../../..'); // …/dist/Electron.app
  const iconPath = join(rootDir, 'resources', 'icon.icns');

  restorePristineElectron(sourceApp);

  const runtimeDir = join(rootDir, '.electron-runtime');
  const targetApp = join(runtimeDir, `${displayName}.app`);
  const targetBinary = join(targetApp, 'Contents', 'MacOS', 'Electron');
  const metaPath = join(runtimeDir, 'metadata.json');

  const expected = {
    cacheVersion: CACHE_VERSION,
    displayName,
    bundleId,
    sourceApp,
    sourceMtimeMs: statSync(sourceApp).mtimeMs,
    iconMtimeMs: existsSync(iconPath) ? statSync(iconPath).mtimeMs : 0,
  };

  if (
    existsSync(targetBinary) &&
    JSON.stringify(readJson(metaPath)) === JSON.stringify(expected)
  ) {
    return targetBinary;
  }

  rmSync(targetApp, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });

  // ditto copies the .app faithfully (frameworks, symlinks, resources).
  const copy = spawnSync('ditto', [sourceApp, targetApp], { encoding: 'utf8' });
  if (copy.status !== 0) {
    throw new Error(`ditto failed to copy the Electron bundle: ${(copy.stderr || '').trim()}`);
  }

  patchMainBundle(targetApp, displayName, bundleId, iconPath);
  patchHelperBundles(targetApp, displayName, bundleId);

  // Register the fresh bundle so LaunchServices (and thus the dock tooltip /
  // app switcher) picks up the new name instead of a cached "Electron".
  if (existsSync(LSREGISTER)) {
    spawnSync(LSREGISTER, ['-f', targetApp]);
  }

  writeFileSync(metaPath, `${JSON.stringify(expected, null, 2)}\n`);
  return targetBinary;
}

export function buildPatchedElectronDist(options) {
  const binaryPath = buildPatchedElectronBinaryPath(options);
  return binaryPath ? resolve(binaryPath, '../../..') : null;
}
