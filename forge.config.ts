import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const iconPath = path.join(rootDir, 'resources', 'icon');

// Modules the packaged main process still `require()`s at runtime: the deps
// kept external in vite.main.config.ts (ssh2, cpu-features) plus ajv/ajv-formats,
// which the bundled MCP SDK requires lazily. plugin-vite's default packaging
// ignore strips node_modules entirely, so we supply our own ignore that also
// keeps these modules' transitive dependency trees.
const RUNTIME_MODULES = ['ssh2', 'cpu-features', 'ajv', 'ajv-formats'];

const collectRuntimeModules = (name: string, keep: Set<string>): void => {
  if (keep.has(name)) return;
  const pkgJsonPath = path.join(rootDir, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return; // optional dep that isn't installed
  keep.add(name);
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  for (const dep of [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]) {
    collectRuntimeModules(dep, keep);
  }
};

const runtimeModules = new Set<string>();
for (const name of RUNTIME_MODULES) collectRuntimeModules(name, runtimeModules);

const keepPrefixes = ['/.vite', ...[...runtimeModules].map((m) => `/node_modules/${m}`)];
const keepDirs = new Set(['/node_modules']);
for (const m of runtimeModules) {
  if (m.startsWith('@')) keepDirs.add(`/node_modules/${m.split('/')[0]}`);
}

const easyHostDevElectronPlugin = {
  name: 'easy-host-dev-electron',
  __isElectronForgePlugin: true as const,
  init() {},
  getHooks() {
    return {};
  },
  async startLogic() {
    return process.env.EASYHOST_ELECTRON_EXEC_PATH || false;
  },
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    icon: iconPath,
    extraResource: [path.join(rootDir, 'resources')],
    // Keep the Vite output plus the runtime modules above; everything else is
    // excluded (this replaces plugin-vite's default "only .vite" ignore).
    // prune must be off: when it's on, packager decides node_modules contents
    // from the dependency graph alone and bypasses `ignore` for modules.
    prune: false,
    ignore: (file: string) => {
      if (!file) return false;
      if (file === '/package.json' || keepDirs.has(file)) return false;
      return !keepPrefixes.some((p) => file === p || file.startsWith(`${p}/`));
    },
    // The deb/rpm makers require a binary named after package.json `name`;
    // Packager otherwise names it after productName ("Tevada DevOps").
    // Linux-only so the macOS/Windows executables keep the product name.
    ...(process.platform === 'linux' ? { executableName: 'tevada-devops' } : {}),
  },
  rebuildConfig: {},
  hooks: {
    // Ad-hoc re-sign the whole bundle on macOS ('-' = no Developer ID).
    // Packaging modifies the app (name/icon/resources), which breaks
    // Electron's original code-signing seal — Gatekeeper reports an app with
    // a BROKEN signature as "damaged" with no override. A consistent deep
    // ad-hoc signature downgrades that to the "unverified developer" flow
    // users can bypass (see README). osxSign/@electron/osx-sign is NOT used:
    // it left the nested Electron Framework with a mismatched Team ID and the
    // app died at launch (dyld refuses the framework). `codesign --deep`
    // re-signs every nested binary consistently — verified locally by
    // launching the packaged app. Replace with Developer ID + notarization
    // when an Apple account is available.
    postPackage: async (_config, result) => {
      if (result.platform !== 'darwin') return;
      for (const outputPath of result.outputPaths) {
        const appBundle = fs
          .readdirSync(outputPath)
          .find((name) => name.endsWith('.app'));
        if (!appBundle) continue;
        execFileSync('codesign', [
          '--force',
          '--deep',
          '--sign',
          '-',
          path.join(outputPath, appBundle),
        ]);
      }
    },
  },
  makers: [
    new MakerSquirrel({}),
    // DMG is the installer Mac users expect; keep the ZIP too for
    // auto-update feeds and users who prefer a bare .app.
    new MakerDMG({ format: 'ULFO' }, ['darwin']),
    new MakerZIP({}, ['darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    easyHostDevElectronPlugin,
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.mts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
