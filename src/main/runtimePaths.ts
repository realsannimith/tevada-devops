/**
 * Runtime path resolution for EASY-HOST.
 *
 * Mirrors the FCode desktop pattern: a configurable home directory
 * (EASYHOST_HOME, default ~/.easyhost) and a stable Electron userData profile
 * name that separates dev from production builds.
 */
import * as OS from 'node:os';
import * as Path from 'node:path';

const DEV_USER_DATA_DIR_NAME = 'easyhost-dev';
const PROD_USER_DATA_DIR_NAME = 'easyhost';

export function resolveRuntimeHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.EASYHOST_HOME?.trim();
  if (configured) {
    return Path.resolve(configured);
  }
  return Path.join(OS.homedir(), '.easyhost');
}

export function resolveAppDataBase(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const homeDir = input?.homeDir ?? OS.homedir();

  if (platform === 'win32') {
    return env.APPDATA || Path.join(homeDir, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return Path.join(homeDir, 'Library', 'Application Support');
  }
  return env.XDG_CONFIG_HOME || Path.join(homeDir, '.config');
}

export function resolveUserDataPath(input: {
  readonly appDataBase: string;
  readonly isDevelopment: boolean;
}): string {
  return Path.join(
    input.appDataBase,
    input.isDevelopment ? DEV_USER_DATA_DIR_NAME : PROD_USER_DATA_DIR_NAME,
  );
}

export function resolveStateDir(runtimeHome: string): string {
  return Path.join(runtimeHome, 'userdata');
}

export function isDevelopmentRuntime(
  hasDevServerUrl?: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (hasDevServerUrl !== undefined) {
    return hasDevServerUrl;
  }
  return Boolean(env.MAIN_WINDOW_VITE_DEV_SERVER_URL ?? env.VITE_DEV_SERVER_URL);
}

export function resolveAppDisplayName(isDevelopment: boolean): string {
  return isDevelopment ? 'EASY-HOST (Dev)' : 'EASY-HOST';
}

export function resolveAppUserModelId(isDevelopment: boolean): string {
  return isDevelopment ? 'com.sannimith.easyhost.dev' : 'com.sannimith.easyhost';
}
