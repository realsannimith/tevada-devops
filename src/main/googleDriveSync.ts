/**
 * Google Drive app-data sync.
 *
 * Tokens stay encrypted in secrets.ts. The renderer only sees metadata and
 * status. Backups are uploaded to Drive's hidden appDataFolder as one JSON
 * snapshot containing easyhost.json, encrypted secret blobs, and EasyHost
 * runtime-home files that carry user data (skills/userdata).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { app, shell } from 'electron';
import type {
  GoogleDriveAccount,
  GoogleDriveAuthEvent,
  GoogleDriveRestoreResult,
  GoogleDriveStatus,
  GoogleDriveSyncResult,
} from '../shared/ipc-types';
import * as secrets from './secrets';
import * as store from './store';
import { resolveRuntimeHome } from './runtimePaths';

const ACCESS_SECRET_ID = 'google-drive-access-token';
const REFRESH_SECRET_ID = 'google-drive-refresh-token';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const CALLBACK_PATH = '/google-drive/callback';
const BACKUP_NAME = 'easyhost-app-data-backup.json';
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
const AUTO_SYNC_DELAY_MS = 15_000;
const MAX_RUNTIME_FILE_BYTES = 10 * 1024 * 1024;
const MAX_RUNTIME_TOTAL_BYTES = 50 * 1024 * 1024;
const EXCLUDED_SECRET_IDS = new Set([ACCESS_SECRET_ID, REFRESH_SECRET_ID]);

function clientId(): string {
  return process.env.GOOGLE_DRIVE_CLIENT_ID?.trim() ?? '';
}

function clientSecret(): string | undefined {
  return process.env.GOOGLE_DRIVE_CLIENT_SECRET?.trim() || undefined;
}

function clientConfigured(): boolean {
  return clientId().length > 0;
}

function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function authErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message || 'Google Drive sign-in failed.';
}

function base64Url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function generateState(): string {
  return base64Url(crypto.randomBytes(32));
}

function decodeJwtPayload(jwt: string | undefined): Record<string, unknown> | null {
  if (!jwt) return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
}

function accountFromTokens(
  tokens: TokenResponse,
  connectedAt: number,
): GoogleDriveAccount {
  const claims = decodeJwtPayload(tokens.id_token);
  const email = typeof claims?.email === 'string' ? claims.email : 'Google account';
  return {
    email,
    name: typeof claims?.name === 'string' ? claims.name : undefined,
    picture: typeof claims?.picture === 'string' ? claims.picture : undefined,
    connectedAt,
    accessTokenExpiresAt: tokenExpiry(tokens),
  };
}

function tokenExpiry(tokens: Pick<TokenResponse, 'expires_in'>): number | undefined {
  return typeof tokens.expires_in === 'number' && tokens.expires_in > 0
    ? Date.now() + tokens.expires_in * 1000
    : undefined;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
};

function saveTokens(tokens: TokenResponse): void {
  if (tokens.access_token) secrets.saveRawSecret(ACCESS_SECRET_ID, tokens.access_token);
  if (tokens.refresh_token) secrets.saveRawSecret(REFRESH_SECRET_ID, tokens.refresh_token);
}

function loadAccessToken(): string | undefined {
  return secrets.loadRawSecret(ACCESS_SECRET_ID);
}

function loadRefreshToken(): string | undefined {
  return secrets.loadRawSecret(REFRESH_SECRET_ID);
}

function hasRefreshToken(): boolean {
  return secrets.hasRawSecret(REFRESH_SECRET_ID);
}

// Set right after connect when Drive already holds a backup and the user
// hasn't chosen restore-vs-overwrite. Auto-sync is suppressed while true so a
// reconnect can never clobber the cloud backup before the user decides.
let remoteBackupPending = false;
let restoreInProgress = false;

export function status(): GoogleDriveStatus {
  const account = store.getGoogleDriveAccount();
  const connected = !!account && hasRefreshToken();
  return {
    connected,
    account: connected ? account : undefined,
    clientConfigured: clientConfigured(),
    secretsAvailable: secrets.secretsAvailable(),
    syncInProgress,
    remoteBackupPending: connected ? remoteBackupPending : false,
    restoreInProgress: connected ? restoreInProgress : false,
  };
}

// Lets the renderer react to sync start/finish and connection changes without
// polling — the first sync runs in the background after connect, so its result
// has to be pushed once it lands.
type StatusListener = (s: GoogleDriveStatus) => void;
const statusListeners = new Set<StatusListener>();

export function onStatusChange(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

function emitStatus(): void {
  const snapshot = status();
  for (const cb of statusListeners) {
    try {
      cb(snapshot);
    } catch {
      /* a dead renderer listener must not break sync */
    }
  }
}

export function disconnect(): GoogleDriveStatus {
  cancelLogin();
  secrets.deleteRawSecret(ACCESS_SECRET_ID);
  secrets.deleteRawSecret(REFRESH_SECRET_ID);
  store.setGoogleDriveAccount(undefined);
  return status();
}

// --- login ------------------------------------------------------------------

type PendingLogin = {
  server: http.Server;
  verifier: string;
  state: string;
  port: number;
  timer: NodeJS.Timeout | null;
  done: boolean;
};

let pending: PendingLogin | null = null;

export function cancelLogin(): void {
  if (!pending) return;
  const p = pending;
  pending = null;
  p.done = true;
  if (p.timer) clearTimeout(p.timer);
  try {
    p.server.close();
  } catch {
    /* already closed */
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function respondPage(res: http.ServerResponse, title: string, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title>` +
      `<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e6e8eb;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
      `.card{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}` +
      `p{color:#9aa3ad;line-height:1.5}</style></head>` +
      `<body><div class="card"><h1>${safeTitle}</h1><p>${safeBody}</p></div></body></html>`,
  );
}

export async function login(
  emit: (e: GoogleDriveAuthEvent) => void,
): Promise<{ ok: boolean; error?: string }> {
  cancelLogin();
  if (!clientConfigured()) {
    return {
      ok: false,
      error: 'Google Drive sync needs GOOGLE_DRIVE_CLIENT_ID in .env.',
    };
  }
  if (!secrets.secretsAvailable()) {
    return {
      ok: false,
      error:
        'OS secure storage is unavailable, so Google Drive tokens cannot be stored safely.',
    };
  }

  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const server = http.createServer();
  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const p: PendingLogin = { server, verifier, state, port, timer: null, done: false };
  pending = p;

  const fail = (error: string) => {
    if (p.done) return;
    emit({ phase: 'error', error });
    cancelLogin();
  };

  p.timer = setTimeout(() => fail('The Google Drive sign-in timed out.'), LOGIN_TIMEOUT_MS);
  server.on('request', (req, res) => {
    void handleCallback(req, res, p, emit, fail);
  });

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId(),
    redirect_uri: redirectUri(port),
    scope: 'openid email profile https://www.googleapis.com/auth/drive.appdata',
    access_type: 'offline',
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });

  try {
    await shell.openExternal(`${AUTHORIZE_URL}?${params.toString()}`);
  } catch {
    /* keep callback server open; user can retry from browser history */
  }
  emit({ phase: 'pending' });
  return { ok: true };
}

async function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: PendingLogin,
  emit: (e: GoogleDriveAuthEvent) => void,
  fail: (error: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${p.port}`);
  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404).end();
    return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    const desc = url.searchParams.get('error_description')?.replace(/\+/g, ' ') ?? '';
    console.warn('[google-drive] callback returned error', { error: err, desc });
    const message =
      err === 'access_denied'
        ? desc ||
          'Google denied access. If your OAuth app is in “Testing”, add this Google account as a test user (Google Auth Platform → Audience), then try again.'
        : desc
          ? `${err}: ${desc}`
          : err;
    respondPage(res, 'Google Drive sign-in failed', message);
    fail(message);
    return;
  }
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || returnedState !== p.state) {
    console.warn('[google-drive] callback could not be verified', {
      hasCode: !!code,
      stateMatched: returnedState === p.state,
    });
    const message = !code
      ? 'Google did not return an authorization code. Please try again.'
      : 'The sign-in could not be verified — the app may have restarted mid sign-in. Please try again.';
    respondPage(res, 'Google Drive sign-in failed', `${message} Close this tab and try again.`);
    fail(message);
    return;
  }

  try {
    const tokens = await exchangeCode(code, p);
    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error(
        'Google did not return a refresh token. Try disconnecting the app in your Google Account permissions, then connect again.',
      );
    }
    saveTokens(tokens);
    const account = accountFromTokens(tokens, Date.now());
    store.setGoogleDriveAccount(account);
    respondPage(res, 'Google Drive connected', 'You can close this tab and return to EasyHost.');
    if (p.done) return;
    p.done = true;
    emit({ phase: 'success', account });
    cancelLogin();
    void reconcileAfterConnect();
  } catch (error) {
    const message = authErrorMessage(error);
    console.warn('[google-drive] sign-in failed', { error: message });
    respondPage(res, 'Google Drive sign-in failed', message);
    fail(message);
  }
}

async function exchangeCode(code: string, p: PendingLogin): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(p.port),
    client_id: clientId(),
    code_verifier: p.verifier,
  });
  const secret = clientSecret();
  if (secret) body.set('client_secret', secret);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(json.error_description || json.error || `Token exchange failed (${res.status}).`);
  }
  return json;
}

// --- access tokens -----------------------------------------------------------

let refreshInFlight: Promise<string | undefined> | null = null;

async function resolveAccessToken(): Promise<string | undefined> {
  const account = store.getGoogleDriveAccount();
  const accessToken = loadAccessToken();
  if (!account || !hasRefreshToken()) return undefined;
  if (
    accessToken &&
    account.accessTokenExpiresAt &&
    Date.now() < account.accessTokenExpiresAt - TOKEN_REFRESH_MARGIN_MS
  ) {
    return accessToken;
  }
  refreshInFlight ??= refreshAccessToken(account).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshAccessToken(account: GoogleDriveAccount): Promise<string | undefined> {
  const refreshToken = loadRefreshToken();
  if (!refreshToken) return undefined;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId(),
  });
  const secret = clientSecret();
  if (secret) body.set('client_secret', secret);

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || !json.access_token) {
    store.setGoogleDriveAccount({
      ...account,
      needsReauth: true,
      syncError: json.error_description || json.error || `Refresh failed (${res.status}).`,
    });
    emitStatus();
    return undefined;
  }
  secrets.saveRawSecret(ACCESS_SECRET_ID, json.access_token);
  store.setGoogleDriveAccount({
    ...account,
    accessTokenExpiresAt: tokenExpiry(json),
    needsReauth: false,
    syncError: undefined,
  });
  return json.access_token;
}

// --- backup creation ---------------------------------------------------------

type BackupFile = {
  path: string;
  size: number;
  mtimeMs: number;
  base64: string;
};

type BackupContent = {
  store: unknown;
  secretBlobs: BackupFile[];
  runtimeFiles: BackupFile[];
};

function readStoreData(): unknown {
  const file = path.join(app.getPath('userData'), 'easyhost.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    delete parsed.googleDrive;
    // Never send chat transcripts off-site. The agent is instructed to print
    // connection strings / DB passwords into its final summary, so a session's
    // items can hold plaintext credentials. Unlike the encrypted secret blobs,
    // transcripts are cleartext — keep them device-local and out of the cloud
    // backup. Servers, projects, credential metadata and settings still sync.
    delete parsed.chatSessions;
    delete parsed.activeChatSessionId;
    return parsed;
  } catch {
    return null;
  }
}

function readFileEntry(abs: string, rel: string): BackupFile | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(abs);
    return { path: rel, size: buf.byteLength, mtimeMs: st.mtimeMs, base64: buf.toString('base64') };
  } catch {
    return null;
  }
}

function readSecretBlobs(): BackupFile[] {
  const dir = path.join(app.getPath('userData'), 'secrets');
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.bin'))
      .filter((name) => !EXCLUDED_SECRET_IDS.has(name.replace(/\.bin$/, '')))
      .map((name) => readFileEntry(path.join(dir, name), `secrets/${name}`))
      .filter((entry): entry is BackupFile => entry !== null);
  } catch {
    return [];
  }
}

function collectRuntimeFiles(): BackupFile[] {
  const root = resolveRuntimeHome();
  const includeRoots = ['skills', 'userdata'];
  const files: BackupFile[] = [];
  let total = 0;

  const walk = (abs: string, rel: string) => {
    if (total >= MAX_RUNTIME_TOTAL_BYTES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
      } else if (entry.isFile()) {
        let st: fs.Stats;
        try {
          st = fs.statSync(childAbs);
        } catch {
          continue;
        }
        if (st.size > MAX_RUNTIME_FILE_BYTES || total + st.size > MAX_RUNTIME_TOTAL_BYTES) continue;
        const file = readFileEntry(childAbs, `runtime/${childRel}`);
        if (!file) continue;
        files.push(file);
        total += file.size;
      }
    }
  };

  for (const rel of includeRoots) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) walk(abs, rel);
  }
  return files;
}

function buildBackup(): {
  hash: string;
  bytes: number;
  fileCount: number;
  payload: Buffer;
} {
  const content: BackupContent = {
    store: readStoreData(),
    secretBlobs: readSecretBlobs(),
    runtimeFiles: collectRuntimeFiles(),
  };
  const canonical = JSON.stringify(content);
  const hash = crypto.createHash('sha256').update(canonical).digest('hex');
  const snapshot = {
    version: 1,
    app: 'easyhost',
    generatedAt: new Date().toISOString(),
    source: {
      userDataPath: app.getPath('userData'),
      runtimeHome: resolveRuntimeHome(),
    },
    content,
  };
  const payload = Buffer.from(JSON.stringify(snapshot, null, 2), 'utf8');
  return {
    hash,
    payload,
    bytes: payload.byteLength,
    fileCount: content.secretBlobs.length + content.runtimeFiles.length + 1,
  };
}

// --- Drive upload ------------------------------------------------------------

let syncInProgress = false;

export async function syncNow(
  opts: { force?: boolean; userInitiated?: boolean } = {},
): Promise<GoogleDriveSyncResult> {
  const account = store.getGoogleDriveAccount();
  if (!account || !hasRefreshToken()) {
    return { ok: false, error: 'Google Drive is not connected.' };
  }
  // A manual "Sync now" is an explicit choice to push this device's data up,
  // which resolves any pending restore prompt (user chose to keep local).
  if (opts.userInitiated && remoteBackupPending) {
    remoteBackupPending = false;
    emitStatus();
  }
  if (restoreInProgress) {
    return { ok: false, error: 'A restore is in progress. Try again in a moment.' };
  }
  if (syncInProgress) return { ok: true, skipped: true };
  syncInProgress = true;
  emitStatus();
  try {
    const accessToken = await resolveAccessToken();
    if (!accessToken) throw new Error('Google Drive needs to be reconnected.');
    const backup = buildBackup();
    const latestAccount = store.getGoogleDriveAccount() ?? account;
    if (!opts.force && latestAccount.lastSyncHash === backup.hash) {
      return { ok: true, skipped: true, lastSyncedAt: latestAccount.lastSyncedAt };
    }
    const fileId = await findBackupFile(accessToken);
    await uploadBackup(accessToken, backup.payload, fileId);
    const lastSyncedAt = Date.now();
    store.setGoogleDriveAccount({
      ...(store.getGoogleDriveAccount() ?? account),
      lastSyncedAt,
      lastSyncBytes: backup.bytes,
      lastSyncFileCount: backup.fileCount,
      lastSyncHash: backup.hash,
      syncError: undefined,
      needsReauth: false,
    });
    return {
      ok: true,
      lastSyncedAt,
      bytes: backup.bytes,
      fileCount: backup.fileCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.setGoogleDriveAccount({
      ...(store.getGoogleDriveAccount() ?? account),
      syncError: message,
    });
    return { ok: false, error: message };
  } finally {
    syncInProgress = false;
    emitStatus();
  }
}

async function driveErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return '';
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string; errors?: Array<{ reason?: string }> };
      };
      const reason = parsed.error?.errors?.[0]?.reason;
      const message = parsed.error?.message;
      if (message && reason) return ` — ${reason}: ${message}`;
      if (message) return ` — ${message}`;
    } catch {
      /* not JSON */
    }
    return ` — ${text.slice(0, 300)}`;
  } catch {
    return '';
  }
}

async function findBackupFile(accessToken: string): Promise<string | undefined> {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    fields: 'files(id,name)',
    q: `name = '${BACKUP_NAME.replace(/'/g, "\\'")}'`,
  });
  const res = await fetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const detail = await driveErrorDetail(res);
    throw new Error(`Google Drive list failed (${res.status})${detail}`);
  }
  const json = (await res.json()) as { files?: Array<{ id: string; name: string }> };
  return json.files?.[0]?.id;
}

async function uploadBackup(
  accessToken: string,
  payload: Buffer,
  fileId: string | undefined,
): Promise<void> {
  const boundary = `easyhost_${crypto.randomBytes(12).toString('hex')}`;
  const metadata = fileId
    ? { name: BACKUP_NAME }
    : { name: BACKUP_NAME, parents: ['appDataFolder'] };
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n`,
      'utf8',
    ),
    payload,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  const url = fileId
    ? `${DRIVE_UPLOAD_URL}/${encodeURIComponent(fileId)}?uploadType=multipart`
    : `${DRIVE_UPLOAD_URL}?uploadType=multipart`;
  const res = await fetch(url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.byteLength),
    },
    body,
  });
  if (!res.ok) {
    const detail = await driveErrorDetail(res);
    throw new Error(`Google Drive upload failed (${res.status})${detail}`);
  }
}

// --- restore (download) ------------------------------------------------------

type RestoreSnapshot = {
  content?: {
    store?: unknown;
    secretBlobs?: BackupFile[];
    runtimeFiles?: BackupFile[];
  };
};

async function downloadBackup(accessToken: string, fileId: string): Promise<RestoreSnapshot> {
  const res = await fetch(
    `${DRIVE_FILES_URL}/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const detail = await driveErrorDetail(res);
    throw new Error(`Google Drive download failed (${res.status})${detail}`);
  }
  return (await res.json()) as RestoreSnapshot;
}

/**
 * Write a backed-up file back to disk, but only inside `rootDir`. The path
 * traversal check stops a tampered snapshot from writing outside the intended
 * userData/runtime roots.
 */
function writeBackupFile(rootDir: string, relPath: string, base64: string): boolean {
  const target = path.resolve(rootDir, relPath);
  const rootWithSep = path.resolve(rootDir) + path.sep;
  if (target !== path.resolve(rootDir) && !target.startsWith(rootWithSep)) {
    console.warn('[google-drive] restore skipped out-of-root path', { relPath });
    return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(base64, 'base64'));
  return true;
}

function applyRestore(snapshot: RestoreSnapshot): { fileCount: number; bytes: number } {
  const content = snapshot.content ?? {};
  let fileCount = 0;
  let bytes = 0;

  // 1. Encrypted secret blobs → <userData>/secrets/<name> (blobs stay
  //    encrypted; usable only on the same machine that made the backup).
  const secretsRoot = path.join(app.getPath('userData'), 'secrets');
  for (const file of content.secretBlobs ?? []) {
    // paths are stored as `secrets/<name>` — strip the leading segment.
    const rel = file.path.replace(/^secrets[\\/]/, '');
    if (EXCLUDED_SECRET_IDS.has(rel.replace(/\.bin$/, ''))) continue;
    if (writeBackupFile(secretsRoot, rel, file.base64)) {
      fileCount += 1;
      bytes += file.size;
    }
  }

  // 2. Runtime-home files (skills/, userdata/) → resolveRuntimeHome()/<rel>.
  const runtimeRoot = resolveRuntimeHome();
  for (const file of content.runtimeFiles ?? []) {
    const rel = file.path.replace(/^runtime[\\/]/, '');
    if (writeBackupFile(runtimeRoot, rel, file.base64)) {
      fileCount += 1;
      bytes += file.size;
    }
  }

  // 3. The store JSON last — it drives the visible app state and preserves the
  //    live Drive connection (see store.restoreStoreData).
  if (content.store && typeof content.store === 'object') {
    store.restoreStoreData(content.store);
    fileCount += 1;
  }

  return { fileCount, bytes };
}

/**
 * Download the Drive backup and put its data back onto this device. Clears the
 * pending-restore flag and stamps lastSyncHash so the next auto-sync doesn't
 * immediately re-upload the identical data.
 */
export async function restoreNow(): Promise<GoogleDriveRestoreResult> {
  const account = store.getGoogleDriveAccount();
  if (!account || !hasRefreshToken()) {
    return { ok: false, error: 'Google Drive is not connected.' };
  }
  if (restoreInProgress || syncInProgress) {
    return { ok: false, error: 'Another Drive operation is in progress.' };
  }
  restoreInProgress = true;
  emitStatus();
  try {
    const accessToken = await resolveAccessToken();
    if (!accessToken) throw new Error('Google Drive needs to be reconnected.');
    const fileId = await findBackupFile(accessToken);
    if (!fileId) {
      return { ok: false, error: 'No backup was found on Google Drive to restore.' };
    }
    const snapshot = await downloadBackup(accessToken, fileId);
    const applied = applyRestore(snapshot);
    remoteBackupPending = false;
    // Recompute the hash of what we just restored so auto-sync treats it as
    // already-synced instead of re-uploading.
    const rebuilt = buildBackup();
    store.setGoogleDriveAccount({
      ...(store.getGoogleDriveAccount() ?? account),
      lastSyncHash: rebuilt.hash,
      lastSyncedAt: Date.now(),
      lastSyncBytes: rebuilt.bytes,
      lastSyncFileCount: rebuilt.fileCount,
      syncError: undefined,
      needsReauth: false,
    });
    return { ok: true, fileCount: applied.fileCount, bytes: applied.bytes };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    store.setGoogleDriveAccount({
      ...(store.getGoogleDriveAccount() ?? account),
      syncError: message,
    });
    return { ok: false, error: message };
  } finally {
    restoreInProgress = false;
    emitStatus();
  }
}

/** User chose to keep this device's data: resolve the prompt and push up. */
export async function keepLocalAndSync(): Promise<GoogleDriveSyncResult> {
  return syncNow({ force: true, userInitiated: true });
}

/**
 * After connecting: if Drive already holds a backup, DON'T upload (that would
 * clobber it). Flag it so the UI can offer restore. If there's no backup yet,
 * it's safe to do the initial upload automatically.
 */
async function reconcileAfterConnect(): Promise<void> {
  try {
    const accessToken = await resolveAccessToken();
    if (!accessToken) return;
    const fileId = await findBackupFile(accessToken);
    if (fileId) {
      remoteBackupPending = true;
      emitStatus();
    } else {
      await syncNow({ force: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const account = store.getGoogleDriveAccount();
    if (account) store.setGoogleDriveAccount({ ...account, syncError: message });
    emitStatus();
  }
}

// --- debounced automatic sync ------------------------------------------------

let autoTimer: NodeJS.Timeout | null = null;
let autoCleanup: (() => void) | null = null;

export function startAutoSync(): () => void {
  if (autoCleanup) return autoCleanup;
  const offStore = store.onWrite(() => scheduleAutoSync());
  const offSecrets = secrets.onWrite((id) => {
    if (!EXCLUDED_SECRET_IDS.has(id)) scheduleAutoSync();
  });
  autoCleanup = () => {
    offStore();
    offSecrets();
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    autoCleanup = null;
  };
  scheduleAutoSync(5_000);
  return autoCleanup;
}

function scheduleAutoSync(delayMs = AUTO_SYNC_DELAY_MS): void {
  if (!store.getGoogleDriveAccount() || !hasRefreshToken()) return;
  // Never auto-upload while a restore is pending/running — that's exactly the
  // reconnect-clobbers-the-backup footgun this guard exists to prevent.
  if (remoteBackupPending || restoreInProgress) return;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void syncNow();
  }, delayMs);
}
