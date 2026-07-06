// Load environment variables from .env FIRST, before any module that reads them.
import 'dotenv/config';
import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { registerIpc } from './main/ipc';
import { applyAppIcon, getWindowIconOption } from './main/appIcon';
import { resolveDesktopRuntimeInfo } from './main/runtimeArch';
import {
  isDevelopmentRuntime,
  resolveAppDataBase,
  resolveAppDisplayName,
  resolveAppUserModelId,
  resolveRuntimeHome,
  resolveStateDir,
  resolveUserDataPath,
} from './main/runtimePaths';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

const isDevelopment =
  typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== 'undefined' ||
  isDevelopmentRuntime();
const runtimeHome = resolveRuntimeHome();
const stateDir = resolveStateDir(runtimeHome);
const appDisplayName = resolveAppDisplayName(isDevelopment);
const appUserModelId = resolveAppUserModelId(isDevelopment);
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});

// Override Electron's userData path before `ready`, same as FCode desktop.
app.setPath(
  'userData',
  resolveUserDataPath({
    appDataBase: resolveAppDataBase(),
    isDevelopment,
  }),
);

// Set the app name synchronously at the top level — BEFORE app.whenReady() —
// so macOS uses it for the dock tooltip and menu bar instead of the default
// "Electron". Called again after ready (below) as belt-and-suspenders, exactly
// like FCode desktop.
configureAppIdentity();

let mainWindow: BrowserWindow | null = null;

function configureAppIdentity(): void {
  app.setName(appDisplayName);
  app.setAboutPanelOptions({
    applicationName: appDisplayName,
    applicationVersion: app.getVersion(),
    copyright: `© ${new Date().getFullYear()} sannimith`,
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(appUserModelId);
  }
}

const createWindow = () => {
  const isMac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    title: appDisplayName,
    ...getWindowIconOption(),
    // Frameless-ish shell: hide the titlebar but keep the traffic lights, and
    // let the app own a .drag-region. The canvas stays opaque (near-white);
    // the frosted look comes from the sidebar's CSS backdrop-filter, not OS
    // window vibrancy — vibrancy would tint the whole content card.
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    trafficLightPosition: isMac ? { x: 14, y: 14 } : undefined,
    backgroundColor: '#fcfcfc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Anything the renderer opens in a "new tab" (markdown links in the chat,
  // "Open website" on an artifact) belongs in the user's real browser — never
  // in a bare chromeless child window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const win = mainWindow;
    void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    // If the Vite dev server is slow to start, restarts, or briefly dies, a
    // one-shot loadURL leaves a permanently white window. Keep retrying so the
    // app heals itself as soon as the dev server is reachable again.
    win.webContents.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
      if (!isMainFrame) return;
      setTimeout(() => {
        if (!win.isDestroyed()) {
          void win.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
        }
      }, 1500);
    });
    win.webContents.openDevTools();
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
};

app.whenReady().then(() => {
  configureAppIdentity();
  applyAppIcon();
  console.info('[tevada-devops] runtime', {
    runtimeHome,
    stateDir,
    userData: app.getPath('userData'),
    isDevelopment,
    desktopRuntimeInfo,
  });

  // safeStorage and all IPC wiring must happen after the app is ready.
  // Create the window first so IPC can attach lifecycle listeners to it.
  createWindow();
  registerIpc(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
