/**
 * Tiny JSON persistence for server profiles and app settings.
 *
 * Lives at `<userData>/easyhost.json`. Writes are atomic (temp file + rename) so
 * a crash mid-write can't corrupt the store. Secret material is NOT stored here —
 * see secrets.ts (safeStorage-encrypted blobs).
 */
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  AppSettings,
  DEFAULT_SETTINGS,
  ServerProfile,
} from '../shared/ipc-types';

type StoreData = {
  servers: ServerProfile[];
  settings: AppSettings;
};

const EMPTY: StoreData = { servers: [], settings: { ...DEFAULT_SETTINGS } };

function storePath(): string {
  return path.join(app.getPath('userData'), 'easyhost.json');
}

function read(): StoreData {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoreData>;
    return {
      servers: Array.isArray(parsed.servers) ? parsed.servers : [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
    };
  } catch {
    return { ...EMPTY, settings: { ...DEFAULT_SETTINGS } };
  }
}

function write(data: StoreData): void {
  const target = storePath();
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

// --- servers ---------------------------------------------------------------

export function listServers(): ServerProfile[] {
  return read().servers;
}

export function getServer(id: string): ServerProfile | undefined {
  return read().servers.find((s) => s.id === id);
}

export function addServer(profile: ServerProfile): ServerProfile {
  const data = read();
  data.servers.push(profile);
  write(data);
  return profile;
}

export function updateServer(
  id: string,
  patch: Partial<Omit<ServerProfile, 'id' | 'createdAt'>>,
): ServerProfile | undefined {
  const data = read();
  const idx = data.servers.findIndex((s) => s.id === id);
  if (idx === -1) return undefined;
  data.servers[idx] = { ...data.servers[idx], ...patch };
  write(data);
  return data.servers[idx];
}

export function removeServer(id: string): void {
  const data = read();
  data.servers = data.servers.filter((s) => s.id !== id);
  write(data);
}

// --- settings --------------------------------------------------------------

export function getSettings(): AppSettings {
  return read().settings;
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const data = read();
  data.settings = { ...data.settings, ...patch };
  write(data);
  return data.settings;
}
