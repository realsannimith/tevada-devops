/**
 * Codex "Sign in with ChatGPT" — the ChatGPT-subscription OAuth flow, run
 * ENTIRELY in the main process (mirrors github.ts). The user signs in with
 * their ChatGPT Plus/Pro/Team/Edu subscription and we obtain OAuth tokens that
 * call OpenAI's Codex backend directly — so no OpenAI API key is ever needed.
 *
 * We reimplement what the open-source `codex` CLI does internally (PKCE flow
 * against auth.openai.com + a local 127.0.0.1 callback), so the CLI does NOT
 * need to be installed. The token bundle is stored encrypted via safeStorage
 * (secrets.ts) in the same auth.json shape the CLI writes; it never crosses IPC
 * to the renderer. Account metadata (email, plan) lives in the plain store.
 *
 * The stored access token is short-lived (~1h); resolveCodexAuth() refreshes it
 * transparently right before an agent run, exactly like github.ensureFreshToken.
 */
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { shell } from 'electron';
import type { CodexAccount, CodexAuthEvent, CodexStatus } from '../shared/ipc-types';
import * as core from './codexAuthCore';
import * as secrets from './secrets';
import * as store from './store';

/** Encrypted auth.json blob (tokens). Metadata is stored separately in store.ts. */
const AUTH_SECRET_ID = 'codex-auth';
const LOGIN_TIMEOUT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Persisted token bundle
// ---------------------------------------------------------------------------

function loadAuth(): core.CodexAuthJson | undefined {
  if (!secrets.hasRawSecret(AUTH_SECRET_ID)) return undefined;
  const raw = secrets.loadRawSecret(AUTH_SECRET_ID);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as core.CodexAuthJson;
  } catch {
    return undefined;
  }
}

function saveAuth(auth: core.CodexAuthJson): void {
  secrets.saveRawSecret(AUTH_SECRET_ID, JSON.stringify(auth));
}

/** Build the account metadata (email/plan) shown in Settings from the id_token. */
function accountFromAuth(auth: core.CodexAuthJson, connectedAt: number): CodexAccount {
  const claims = core.parseIdToken(auth.tokens.id_token);
  return {
    email: claims.email,
    accountId: claims.accountId ?? auth.tokens.account_id,
    planType: claims.planType,
    planLabel: core.planLabel(claims.planType),
    connectedAt,
  };
}

/** Turn a token-endpoint response into our persisted auth.json shape. */
function toAuthJson(
  tokens: core.CodexTokenResponse,
  previousRefresh: string | undefined,
): core.CodexAuthJson {
  const claims = core.parseIdToken(tokens.id_token);
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? previousRefresh ?? '',
      account_id: claims.accountId ?? '',
    },
    last_refresh: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Status / logout
// ---------------------------------------------------------------------------

export function status(): CodexStatus {
  const account = store.getCodexAccount();
  const connected = !!account && secrets.hasRawSecret(AUTH_SECRET_ID);
  return { connected, account, secretsAvailable: secrets.secretsAvailable() };
}

export function logout(): CodexStatus {
  cancelLogin();
  secrets.deleteRawSecret(AUTH_SECRET_ID);
  store.setCodexAccount(undefined);
  return status();
}

// ---------------------------------------------------------------------------
// Login (PKCE + local callback)
// ---------------------------------------------------------------------------

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

/** Bind an http server on the first allowed port that's free (1455, then 1457). */
function listenOnAllowedPort(server: http.Server): Promise<number> {
  const ports = [core.CODEX_REDIRECT_PORT, core.CODEX_REDIRECT_PORT_FALLBACK];
  return new Promise((resolve, reject) => {
    const tryPort = (i: number) => {
      if (i >= ports.length) {
        reject(new Error('Ports 1455 and 1457 are both in use — close the app using them and retry.'));
        return;
      }
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('error', onError);
        if (err.code === 'EADDRINUSE') tryPort(i + 1);
        else reject(err);
      };
      server.once('error', onError);
      server.listen(ports[i], '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolve((server.address() as AddressInfo).port);
      });
    };
    tryPort(0);
  });
}

function respondPage(res: http.ServerResponse, title: string, body: string): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0b0d10;color:#e6e8eb;` +
      `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
      `.card{text-align:center;max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}` +
      `p{color:#9aa3ad;line-height:1.5}</style></head>` +
      `<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`,
  );
}

/**
 * Start the login flow: opens the ChatGPT authorize page in the browser and
 * runs a local callback server that completes the token exchange. Returns
 * immediately; progress arrives on `emit` (wired to evtCodexAuth), mirroring
 * github.startDeviceFlow.
 */
export async function login(
  emit: (e: CodexAuthEvent) => void,
): Promise<{ ok: boolean; error?: string }> {
  cancelLogin();
  if (!secrets.secretsAvailable()) {
    return {
      ok: false,
      error:
        'OS secure storage is unavailable — cannot store the sign-in safely. ' +
        'On Linux, ensure a keyring (gnome-keyring / kwallet) is running.',
    };
  }

  const { verifier, challenge } = core.generatePkce();
  const state = core.generateState();
  const server = http.createServer();

  let port: number;
  try {
    port = await listenOnAllowedPort(server);
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

  p.timer = setTimeout(() => fail('The sign-in timed out. Try again.'), LOGIN_TIMEOUT_MS);

  server.on('request', (req, res) => {
    void handleCallback(req, res, p, emit, fail);
  });

  const authorizeUrl = core.buildAuthorizeUrl(challenge, state, port);
  try {
    await shell.openExternal(authorizeUrl);
  } catch {
    /* the URL still resolves on manual paste; keep the server open */
  }
  emit({ phase: 'pending' });
  return { ok: true };
}

async function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  p: PendingLogin,
  emit: (e: CodexAuthEvent) => void,
  fail: (error: string) => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${p.port}`);
  if (!url.pathname.startsWith(core.CODEX_REDIRECT_PATH)) {
    res.writeHead(404).end();
    return;
  }
  const err = url.searchParams.get('error');
  if (err) {
    respondPage(res, 'Sign-in failed', 'You can close this tab and try again.');
    fail(err === 'access_denied' ? 'You declined the sign-in.' : `Sign-in failed: ${err}.`);
    return;
  }
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  if (!code || returnedState !== p.state) {
    respondPage(res, 'Sign-in failed', 'The response could not be verified. Close this tab and try again.');
    fail('The sign-in response could not be verified (state mismatch).');
    return;
  }

  try {
    const tokens = await exchangeCode(code, p.verifier, p.port);
    const auth = toAuthJson(tokens, undefined);
    if (!auth.tokens.account_id) {
      throw new Error('OpenAI did not return a ChatGPT account — is this a subscription account?');
    }
    saveAuth(auth);
    const account = accountFromAuth(auth, Date.now());
    store.setCodexAccount(account);
    respondPage(res, 'Signed in to ChatGPT', 'You can close this tab and return to the app.');
    if (p.done) return;
    p.done = true;
    emit({ phase: 'success', account });
    cancelLogin();
  } catch (e) {
    respondPage(res, 'Sign-in failed', 'Close this tab and try again.');
    fail(e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Token endpoint calls
// ---------------------------------------------------------------------------

async function exchangeCode(
  code: string,
  verifier: string,
  port: number,
): Promise<core.CodexTokenResponse> {
  const res = await fetch(core.CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: core.buildCodeExchangeBody(code, verifier, port),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}). Try signing in again.`);
  }
  const json = (await res.json()) as core.CodexTokenResponse;
  if (!json.id_token || !json.access_token) {
    throw new Error('OpenAI returned an incomplete token response.');
  }
  return json;
}

/** Returns the refreshed auth, or throws on a permanent refresh failure. */
async function refresh(auth: core.CodexAuthJson): Promise<core.CodexAuthJson> {
  const res = await fetch(core.CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: core.buildRefreshBody(auth.tokens.refresh_token),
  });
  if (!res.ok) {
    throw new Error(`refresh_failed_${res.status}`);
  }
  const json = (await res.json()) as Partial<core.CodexTokenResponse>;
  const next: core.CodexAuthJson = {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: json.id_token ?? auth.tokens.id_token,
      access_token: json.access_token ?? auth.tokens.access_token,
      refresh_token: json.refresh_token ?? auth.tokens.refresh_token,
      account_id: auth.tokens.account_id,
    },
    last_refresh: new Date().toISOString(),
  };
  saveAuth(next);
  // Keep the displayed plan/email fresh if the id_token rotated.
  if (json.id_token) {
    const existing = store.getCodexAccount();
    store.setCodexAccount(accountFromAuth(next, existing?.connectedAt ?? Date.now()));
  }
  return next;
}

// ---------------------------------------------------------------------------
// Runtime resolution (called by ipc.ts right before an agent run)
// ---------------------------------------------------------------------------

export type CodexRuntimeAuth = { accessToken: string; accountId: string };

/**
 * Return a fresh access token + account id for a run, refreshing if the current
 * token is near expiry. Returns undefined when the user isn't signed in or the
 * refresh token has expired (the run guard then tells them to sign in again).
 */
export async function resolveCodexAuth(): Promise<CodexRuntimeAuth | undefined> {
  let auth = loadAuth();
  if (!auth || !auth.tokens.access_token) return undefined;
  if (core.needsRefresh(auth, Date.now())) {
    try {
      auth = await refresh(auth);
    } catch {
      // Refresh failed (expired/reused refresh token) — mark the account so the
      // UI prompts a reconnect, but don't wipe it (the user may just be offline).
      const account = store.getCodexAccount();
      if (account) store.setCodexAccount({ ...account, needsReauth: true });
      return undefined;
    }
  }
  return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id };
}

/** Cheap presence check (no refresh) for the run-start guard. */
export function isConnected(): boolean {
  return !!store.getCodexAccount() && secrets.hasRawSecret(AUTH_SECRET_ID);
}
