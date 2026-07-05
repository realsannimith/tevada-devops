/**
 * Resolve packaged app icon paths (same asset set as FCode desktop).
 */
import * as FS from 'node:fs';
import * as Path from 'node:path';

import { app, nativeImage } from 'electron';

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, '../../resources', fileName),
    Path.join(process.resourcesPath, 'resources', fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function resolveIconPath(ext: 'ico' | 'icns' | 'png'): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

export function getWindowIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === 'darwin') {
    return {};
  }
  const ext = process.platform === 'win32' ? 'ico' : 'png';
  const iconPath = resolveIconPath(ext);
  return iconPath ? { icon: iconPath } : {};
}

export function applyAppIcon(): void {
  if (process.platform === 'darwin' && app.dock) {
    const icnsPath = resolveIconPath('icns');
    const pngPath = resolveResourcePath('dock-icon.png') ?? resolveIconPath('png');
    const iconPath = icnsPath ?? pngPath;
    if (!iconPath) {
      return;
    }

    const image = nativeImage.createFromPath(iconPath);
    if (!image.isEmpty()) {
      app.dock.setIcon(image);
    }
  }
}
