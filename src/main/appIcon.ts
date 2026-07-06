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
    // Try each candidate and use the FIRST that nativeImage actually decodes.
    // Electron's nativeImage can't read every .icns (iconutil-built ones often
    // come back empty), so a bare `icns ?? png` picks the icns *path*, loads an
    // empty image, and the dock silently keeps the default Electron icon. The
    // high-res PNGs decode reliably, so they're the fallback.
    const candidates = [
      resolveIconPath('icns'),
      resolveResourcePath('dock-icon.png'),
      resolveIconPath('png'),
    ].filter((p): p is string => !!p);

    for (const candidate of candidates) {
      const image = nativeImage.createFromPath(candidate);
      if (!image.isEmpty()) {
        app.dock.setIcon(image);
        return;
      }
    }
  }
}
