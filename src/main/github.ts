/**
 * GitHub account connection — runs ENTIRELY in the main process, mirroring the
 * keygen.ts model: the token is obtained here (device flow or a pasted personal
 * access token), stored via safeStorage (secrets.ts), and never crosses IPC to
 * the renderer. The renderer only ever sees account metadata and status.
 *
 * Two kinds of client id work for the device flow (GITHUB_CLIENT_ID in .env):
 *  - A **GitHub App** client id ("Iv…") — the recommended path. The user signs
 *    in, then installs the app on their account/org choosing "All repositories"
 *    or "Only select repositories"; the token can only reach what they granted,
 *    and they can change the selection any time on GitHub. User tokens expire
 *    after 8 h with a 6-month refresh token (no client secret needed for
 *    device-flow refresh) — `ensureFreshToken` renews them transparently and
 *    re-pushes the rotated token to every authorized server.
 *  - A classic **OAuth App** client id — legacy path, `repo read:user` scopes,
 *    non-expiring token, access to everything the user can reach.
 *
 * Two ways a server gets to use the credentials:
 *  - `authorizeServer` writes the token into the server's git credential store
 *    (`~/.git-credentials`) so ANY git clone/pull/push against github.com on that
 *    server — including ones the AI agent runs — just works.
 *  - `cloneRepo` does a one-shot authenticated clone and then strips the token
 *    from the cloned repo's remote URL, leaving nothing behind.
 */
import { shell } from 'electron';
import {
  ExecResult,
  GithubAccount,
  GithubAuthEvent,
  GithubCloneResult,
  GithubDeviceFlowStart,
  GithubInstallation,
  GithubInstallationsResult,
  GithubRepo,
  GithubReposResult,
  GithubStatus,
} from '../shared/ipc-types';
import * as store from './store';
import * as secrets from './secrets';
import { ConnectionManager } from './connection-manager';

const TOKEN_SECRET_ID = 'github-token';
const REFRESH_SECRET_ID = 'github-refresh-token';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE = 'https://api.github.com';
const OAUTH_SCOPES = 'repo read:user';
/** Renew user access tokens this long before they actually expire. */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;

function clientId(): string {
  return process.env.GITHUB_CLIENT_ID?.trim() ?? '';
}

/** GitHub App client ids start with "Iv" (OAuth App ids are 20-char hex). */
function isGithubAppClient(): boolean {
  return clientId().startsWith('Iv');
}

function appSlug(): string {
  return (
    process.env.GITHUB_APP_SLUG?.trim() ||
    store.getGithubAccount()?.appSlug ||
    ''
  );
}

/** Page where the user installs the app and picks all/selected repositories. */
function installUrl(): string | undefined {
  const slug = appSlug();
  return slug ? `https://github.com/apps/${slug}/installations/new` : undefined;
}

export function deviceFlowAvailable(): boolean {
  return clientId().length > 0;
}

// --- server credential sync ----------------------------------------------------
// github.ts never owns SSH connections; ipc.ts lends them once at registration
// so rotated tokens can be re-pushed to authorized servers in the background.

type Runtime = {
  cm: ConnectionManager;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
};
let runtime: Runtime | null = null;

export function bindRuntime(r: Runtime): void {
  runtime = r;
}

// --- GitHub API helpers ------------------------------------------------------

async function ghJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
  return res.json();
}

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tevada-devops',
  };
}

type GhUser = { login: string; name?: string; avatarUrl?: string; scopes?: string };

/** Validate a token against the API and return who it belongs to. */
async function fetchUser(token: string): Promise<GhUser> {
  const res = await fetch(`${API_BASE}/user`, { headers: apiHeaders(token) });
  if (res.status === 401) throw new Error('GitHub rejected the token.');
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
  const u = (await res.json()) as {
    login: string;
    name?: string | null;
    avatar_url?: string;
  };
  return {
    login: u.login,
    name: u.name ?? undefined,
    avatarUrl: u.avatar_url,
    scopes: res.headers.get('x-oauth-scopes') ?? undefined,
  };
}

// --- token persistence ---------------------------------------------------------

/** Everything GitHub hands back from a device-flow token exchange or refresh. */
type TokenGrant = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
};

function persistGrant(grant: TokenGrant): { token: string; expiresAt?: number } {
  const token = grant.access_token ?? '';
  secrets.saveRawSecret(TOKEN_SECRET_ID, token);
  if (grant.refresh_token) {
    secrets.saveRawSecret(REFRESH_SECRET_ID, grant.refresh_token);
  } else {
    secrets.deleteRawSecret(REFRESH_SECRET_ID);
  }
  const expiresAt =
    typeof grant.expires_in === 'number' && grant.expires_in > 0
      ? Date.now() + grant.expires_in * 1000
      : undefined;
  return { token, expiresAt };
}

function saveConnection(
  grant: TokenGrant,
  user: GhUser,
  method: 'device' | 'token' | 'app',
): GithubAccount {
  const { expiresAt } = persistGrant(grant);
  const account: GithubAccount = {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    scopes: user.scopes,
    connectedAt: Date.now(),
    method,
    authorizedServerIds: store.getGithubAccount()?.authorizedServerIds ?? [],
    tokenExpiresAt: method === 'app' ? expiresAt : undefined,
  };
  store.setGithubAccount(account);
  return account;
}

function loadToken(): string | undefined {
  return secrets.loadRawSecret(TOKEN_SECRET_ID);
}

// --- token refresh (GitHub App user tokens rotate every 8 h) -------------------

let refreshInFlight: Promise<string | undefined> | null = null;

/**
 * The one way to read the token for actual use. For GitHub App connections it
 * refreshes an (almost-)expired token first — the refresh endpoint needs no
 * client secret for device-flow tokens — and re-pushes the rotated token to
 * every authorized server in the background. Returns undefined when there is
 * no usable token (never connected, or refresh token expired → needsReauth).
 */
export async function ensureFreshToken(): Promise<string | undefined> {
  const account = store.getGithubAccount();
  const token = loadToken();
  if (!token || !account) return undefined;
  if (account.method !== 'app' || !account.tokenExpiresAt) return token;
  if (Date.now() < account.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) return token;

  refreshInFlight ??= refreshUserToken(account).finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refreshUserToken(account: GithubAccount): Promise<string | undefined> {
  const refreshToken = secrets.loadRawSecret(REFRESH_SECRET_ID);
  if (!refreshToken) {
    store.setGithubAccount({ ...account, needsReauth: true });
    return undefined;
  }
  let grant: TokenGrant;
  try {
    grant = (await ghJson(ACCESS_TOKEN_URL, {
      method: 'POST',
      body: JSON.stringify({
        client_id: clientId(),
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    })) as TokenGrant;
  } catch {
    // Transient network failure — keep the old token; it may still be valid
    // (we refresh 10 min early) and the next call will retry.
    return loadToken();
  }
  if (!grant.access_token) {
    // The refresh token itself expired (6 months) or was revoked.
    store.setGithubAccount({ ...store.getGithubAccount()!, needsReauth: true });
    return undefined;
  }
  const { token, expiresAt } = persistGrant(grant);
  store.setGithubAccount({
    ...store.getGithubAccount()!,
    tokenExpiresAt: expiresAt,
    needsReauth: false,
  });
  // Servers keep a copy of the token in their git credential store — swap in
  // the new one wherever we can reach (offline servers heal on next authorize).
  void syncAuthorizedServers(token);
  return token;
}

async function syncAuthorizedServers(token: string): Promise<void> {
  const account = store.getGithubAccount();
  if (!runtime || !account) return;
  await Promise.allSettled(
    account.authorizedServerIds.map(async (serverId) => {
      const conn = await runtime!.connect(serverId);
      if (!conn.ok) return;
      await writeServerCredentials(runtime!.cm, serverId, token);
    }),
  );
}

// --- status ------------------------------------------------------------------

export function getStatus(): GithubStatus {
  const account = store.getGithubAccount();
  const connected = !!account && !!loadToken();
  return {
    connected,
    account: connected ? account : undefined,
    deviceFlowAvailable: deviceFlowAvailable(),
    githubApp: isGithubAppClient(),
    installUrl: installUrl(),
  };
}

// --- device flow (GitHub App or classic OAuth App) -----------------------------

type DevicePoll = { cancelled: boolean; timer?: NodeJS.Timeout };
let activePoll: DevicePoll | null = null;

export function cancelDeviceFlow(): void {
  if (activePoll) {
    activePoll.cancelled = true;
    if (activePoll.timer) clearTimeout(activePoll.timer);
    activePoll = null;
  }
}

/**
 * Kick off the device flow: returns the user code to display, opens the GitHub
 * verification page in the default browser, and polls for the token in the
 * background, emitting progress over `emit` (wired to evtGithubAuth).
 */
export async function startDeviceFlow(
  emit: (e: GithubAuthEvent) => void,
): Promise<GithubDeviceFlowStart> {
  if (!deviceFlowAvailable()) {
    return {
      ok: false,
      error:
        'Device sign-in needs GITHUB_CLIENT_ID in .env (a GitHub App or OAuth App with device flow enabled). You can paste a personal access token instead.',
    };
  }
  cancelDeviceFlow();

  const isApp = isGithubAppClient();
  let data: {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval?: number;
  };
  try {
    // GitHub Apps take no scope — permissions come from the app + installation.
    data = (await ghJson(DEVICE_CODE_URL, {
      method: 'POST',
      body: JSON.stringify(
        isApp
          ? { client_id: clientId() }
          : { client_id: clientId(), scope: OAUTH_SCOPES },
      ),
    })) as typeof data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!data.device_code || !data.user_code) {
    return { ok: false, error: 'GitHub did not return a device code. Check that device flow is enabled on your GitHub App.' };
  }

  const poll: DevicePoll = { cancelled: false };
  activePoll = poll;
  const deadline = Date.now() + data.expires_in * 1000;
  let intervalMs = Math.max(5, data.interval ?? 5) * 1000;

  const tick = async () => {
    if (poll.cancelled) return;
    if (Date.now() > deadline) {
      if (activePoll === poll) activePoll = null;
      emit({ phase: 'error', error: 'The sign-in code expired. Try again.' });
      return;
    }
    try {
      const res = (await ghJson(ACCESS_TOKEN_URL, {
        method: 'POST',
        body: JSON.stringify({
          client_id: clientId(),
          device_code: data.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      })) as TokenGrant;
      if (poll.cancelled) return;

      if (res.access_token) {
        if (activePoll === poll) activePoll = null;
        const user = await fetchUser(res.access_token);
        let account = saveConnection(res, user, isApp ? 'app' : 'device');
        if (isApp) {
          // Learn the installations (and app slug) right away so the UI can
          // show repo access — or the install prompt — immediately.
          try {
            await refreshInstallationsCache(res.access_token);
            account = store.getGithubAccount() ?? account;
          } catch {
            /* installations load is best-effort; the UI refetches */
          }
        }
        emit({ phase: 'success', account });
        return;
      }
      if (res.error === 'authorization_pending') {
        emit({ phase: 'pending' });
      } else if (res.error === 'slow_down') {
        intervalMs += 5000;
      } else if (res.error) {
        if (activePoll === poll) activePoll = null;
        emit({
          phase: 'error',
          error:
            res.error === 'access_denied'
              ? 'You declined the authorization on GitHub.'
              : res.error === 'device_flow_disabled'
                ? 'Device flow is not enabled on this GitHub App. Enable it in the app settings on GitHub.'
                : `GitHub sign-in failed: ${res.error}.`,
        });
        return;
      }
    } catch {
      /* transient network error — keep polling until the code expires */
    }
    poll.timer = setTimeout(tick, intervalMs);
  };
  poll.timer = setTimeout(tick, intervalMs);

  // Open the verification page for the user; the code stays visible in-app.
  void shell.openExternal(data.verification_uri);

  return {
    ok: true,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: data.expires_in,
  };
}

// --- personal access token ----------------------------------------------------

export async function connectWithToken(token: string): Promise<GithubStatus> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Paste a token first.');
  const user = await fetchUser(trimmed);
  saveConnection({ access_token: trimmed }, user, 'token');
  return getStatus();
}

// --- disconnect ----------------------------------------------------------------

/**
 * Forget the account. Best-effort removes the credentials from every server the
 * user had authorized (only ones currently reachable can be cleaned).
 */
export async function disconnect(cm: ConnectionManager): Promise<GithubStatus> {
  cancelDeviceFlow();
  const account = store.getGithubAccount();
  if (account) {
    for (const serverId of account.authorizedServerIds) {
      try {
        await cm.exec(serverId, DEAUTHORIZE_CMD, { timeoutMs: 15_000 });
      } catch {
        /* server offline — credentials stay until it is authorized/cleaned again */
      }
    }
  }
  secrets.deleteRawSecret(TOKEN_SECRET_ID);
  secrets.deleteRawSecret(REFRESH_SECRET_ID);
  store.setGithubAccount(undefined);
  return getStatus();
}

// --- installations (GitHub App repo access) -------------------------------------

type ApiInstallation = {
  id: number;
  app_slug?: string;
  repository_selection?: string;
  html_url?: string;
  account?: {
    login?: string;
    type?: string;
    avatar_url?: string;
  };
};

/** Settings page where the user edits one installation's repository access. */
function installationSettingsUrl(inst: ApiInstallation): string {
  if (inst.html_url) return inst.html_url;
  return inst.account?.type === 'Organization'
    ? `https://github.com/organizations/${inst.account.login}/settings/installations/${inst.id}`
    : `https://github.com/settings/installations/${inst.id}`;
}

async function fetchInstallations(
  token: string,
): Promise<{ installations: GithubInstallation[]; appSlug?: string }> {
  const res = await fetch(`${API_BASE}/user/installations?per_page=100`, {
    headers: apiHeaders(token),
  });
  if (res.status === 401) throw new Error('GitHub rejected the token.');
  if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}.`);
  const body = (await res.json()) as { installations?: ApiInstallation[] };
  const raw = body.installations ?? [];

  const installations = await Promise.all(
    raw.map(async (inst): Promise<GithubInstallation> => {
      // per_page=1 → we only want total_count, not the repos themselves.
      let repoCount: number | undefined;
      try {
        const r = await fetch(
          `${API_BASE}/user/installations/${inst.id}/repositories?per_page=1`,
          { headers: apiHeaders(token) },
        );
        if (r.ok) {
          repoCount = ((await r.json()) as { total_count?: number }).total_count;
        }
      } catch {
        /* count is cosmetic */
      }
      return {
        id: inst.id,
        accountLogin: inst.account?.login ?? 'unknown',
        accountType: inst.account?.type === 'Organization' ? 'Organization' : 'User',
        accountAvatarUrl: inst.account?.avatar_url,
        repositorySelection: inst.repository_selection === 'all' ? 'all' : 'selected',
        repoCount,
        htmlUrl: installationSettingsUrl(inst),
      };
    }),
  );
  return { installations, appSlug: raw[0]?.app_slug };
}

/** Fetch installations and fold them (plus the app slug) into the account. */
async function refreshInstallationsCache(token: string): Promise<GithubInstallation[]> {
  const { installations, appSlug: slug } = await fetchInstallations(token);
  const account = store.getGithubAccount();
  if (account) {
    store.setGithubAccount({
      ...account,
      installations,
      appSlug: slug ?? account.appSlug,
    });
  }
  return installations;
}

/**
 * List the app installations the connected user can reach — each one is an
 * account (user/org) with either all repos or a hand-picked set granted.
 */
export async function listInstallations(): Promise<GithubInstallationsResult> {
  const account = store.getGithubAccount();
  if (!account) return { ok: false, error: 'GitHub is not connected.' };
  if (account.method !== 'app') {
    // OAuth/PAT connections aren't installation-scoped; report none.
    return { ok: true, installations: [] };
  }
  const token = await ensureFreshToken();
  if (!token) {
    return { ok: false, error: 'Your GitHub session expired. Reconnect your account.' };
  }
  try {
    return { ok: true, installations: await refreshInstallationsCache(token) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Open the right GitHub page in the browser: a specific installation's
 * settings (to edit repo access), or the app's install page.
 */
export async function openInstallPage(installationId?: number): Promise<{ ok: boolean; error?: string }> {
  if (installationId) {
    const inst = store.getGithubAccount()?.installations?.find((i) => i.id === installationId);
    if (inst?.htmlUrl) {
      await shell.openExternal(inst.htmlUrl);
      return { ok: true };
    }
  }
  const url = installUrl();
  if (!url) {
    return {
      ok: false,
      error:
        'The GitHub App slug is not configured. Set GITHUB_APP_SLUG in .env (the name in your app\'s public URL, github.com/apps/<slug>).',
    };
  }
  await shell.openExternal(url);
  return { ok: true };
}

// --- repos ----------------------------------------------------------------------

function mapRepo(r: {
  full_name: string;
  private: boolean;
  default_branch: string;
  description?: string | null;
  pushed_at?: string;
}): GithubRepo {
  return {
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    description: r.description ?? undefined,
    pushedAt: r.pushed_at,
  };
}

type ApiRepo = Parameters<typeof mapRepo>[0];

/**
 * The repositories the connection can actually reach. For GitHub App
 * connections that is exactly what the user granted per installation; for
 * OAuth/PAT it is everything the token can see.
 */
export async function listRepos(): Promise<GithubReposResult> {
  const account = store.getGithubAccount();
  const token = await ensureFreshToken();
  if (!token || !account) {
    return {
      ok: false,
      error: account?.needsReauth
        ? 'Your GitHub session expired. Reconnect your account.'
        : 'GitHub is not connected.',
    };
  }
  try {
    if (account.method === 'app') {
      const { installations } = await fetchInstallations(token);
      const repos: GithubRepo[] = [];
      for (const inst of installations) {
        // Up to 3 pages per installation — plenty for a picker/agent listing.
        for (let page = 1; page <= 3; page++) {
          const res = await fetch(
            `${API_BASE}/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,
            { headers: apiHeaders(token) },
          );
          if (!res.ok) break;
          const body = (await res.json()) as { repositories?: ApiRepo[] };
          const batch = body.repositories ?? [];
          repos.push(...batch.map(mapRepo));
          if (batch.length < 100) break;
        }
      }
      repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
      return { ok: true, repos };
    }

    const res = await fetch(
      `${API_BASE}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`,
      { headers: apiHeaders(token) },
    );
    if (!res.ok) return { ok: false, error: `GitHub returned HTTP ${res.status}.` };
    const list = (await res.json()) as ApiRepo[];
    return { ok: true, repos: list.map(mapRepo) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- server authorization ---------------------------------------------------------

/** Remove any github.com entries from the server's git credential store. */
const DEAUTHORIZE_CMD =
  "if [ -f ~/.git-credentials ]; then grep -v '@github.com' ~/.git-credentials > ~/.git-credentials.tmp 2>/dev/null; mv ~/.git-credentials.tmp ~/.git-credentials; fi";

function redact(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

function execError(r: ExecResult, token: string): string {
  const detail = redact((r.stderr || r.stdout).trim(), token).slice(0, 400);
  return detail || `Command exited with code ${r.exitCode}.`;
}

/** Install/replace the github.com entry in a server's git credential store. */
async function writeServerCredentials(
  cm: ConnectionManager,
  serverId: string,
  token: string,
): Promise<ExecResult> {
  // Token charset is [A-Za-z0-9_-], safe inside single quotes.
  const credLine = `https://x-access-token:${token}@github.com`;
  const cmd = [
    'umask 077',
    'git config --global credential.helper store',
    `( grep -v '@github.com' ~/.git-credentials 2>/dev/null; printf '%s\\n' '${credLine}' ) > ~/.git-credentials.tmp`,
    'mv ~/.git-credentials.tmp ~/.git-credentials',
    'chmod 600 ~/.git-credentials',
  ].join(' && ');
  return cm.exec(serverId, cmd, { timeoutMs: 20_000 });
}

/**
 * Grant a server standing permission to clone (and pull/push) the user's GitHub
 * repos: installs the token into the server's git credential store, so every
 * `git` command against github.com on that server authenticates automatically.
 */
export async function authorizeServer(
  cm: ConnectionManager,
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>,
  serverId: string,
): Promise<{ ok: boolean; error?: string }> {
  const token = await ensureFreshToken();
  const account = store.getGithubAccount();
  if (!token || !account) {
    return {
      ok: false,
      error: account?.needsReauth
        ? 'Your GitHub session expired. Reconnect your account in Settings.'
        : 'GitHub is not connected.',
    };
  }

  const conn = await connect(serverId);
  if (!conn.ok) return { ok: false, error: conn.error ?? 'Could not reach the server.' };

  const gitCheck = await cm.exec(serverId, 'command -v git', { timeoutMs: 15_000 });
  if (gitCheck.exitCode !== 0) {
    return { ok: false, error: 'git is not installed on this server. Ask the agent to install it first.' };
  }

  const r = await writeServerCredentials(cm, serverId, token);
  if (r.exitCode !== 0) return { ok: false, error: execError(r, token) };

  if (!account.authorizedServerIds.includes(serverId)) {
    store.setGithubAccount({
      ...account,
      authorizedServerIds: [...account.authorizedServerIds, serverId],
    });
  }
  return { ok: true };
}

/**
 * Make sure an authorized server has a working (non-expired) token before an
 * agent run touches it. No-op unless the connection is a GitHub App one whose
 * token has rotated since the server was last written.
 */
export async function ensureServerCredentialsFresh(
  cm: ConnectionManager,
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>,
  serverId: string,
): Promise<void> {
  const account = store.getGithubAccount();
  if (
    !account ||
    account.method !== 'app' ||
    !account.authorizedServerIds.includes(serverId)
  ) {
    return;
  }
  const token = await ensureFreshToken();
  if (!token) return;
  const conn = await connect(serverId);
  if (!conn.ok) return;
  try {
    await writeServerCredentials(cm, serverId, token);
  } catch {
    /* best effort — the next authorize/refresh will retry */
  }
}

/** Revoke a server's standing GitHub access (removes stored credentials). */
export async function deauthorizeServer(
  cm: ConnectionManager,
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>,
  serverId: string,
): Promise<{ ok: boolean; error?: string }> {
  const account = store.getGithubAccount();
  const conn = await connect(serverId);
  if (conn.ok) {
    try {
      await cm.exec(serverId, DEAUTHORIZE_CMD, { timeoutMs: 15_000 });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  } else {
    return { ok: false, error: conn.error ?? 'Could not reach the server.' };
  }
  if (account) {
    store.setGithubAccount({
      ...account,
      authorizedServerIds: account.authorizedServerIds.filter((id) => id !== serverId),
    });
  }
  return { ok: true };
}

// --- one-shot clone -----------------------------------------------------------------

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Clone a repo onto a server with the stored token injected only for the clone
 * itself; afterwards the remote URL is rewritten token-free, so nothing secret
 * is left in the repo config.
 */
export async function cloneRepo(
  cm: ConnectionManager,
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>,
  serverId: string,
  repoFullName: string,
  destPath?: string,
): Promise<GithubCloneResult> {
  const token = await ensureFreshToken();
  if (!token) return { ok: false, error: 'GitHub is not connected.' };
  if (!REPO_RE.test(repoFullName)) {
    return { ok: false, error: `Invalid repository name: ${repoFullName}` };
  }
  const dest = (destPath?.trim() || repoFullName.split('/')[1]).replace(/'/g, '');

  const conn = await connect(serverId);
  if (!conn.ok) return { ok: false, error: conn.error ?? 'Could not reach the server.' };

  const authedUrl = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
  const cleanUrl = `https://github.com/${repoFullName}.git`;
  const cmd = `git clone '${authedUrl}' '${dest}' && git -C '${dest}' remote set-url origin '${cleanUrl}' && readlink -f '${dest}'`;
  const r = await cm.exec(serverId, cmd, { timeoutMs: 10 * 60_000, maxOutputBytes: 64_000 });
  if (r.exitCode !== 0) return { ok: false, error: execError(r, token) };
  const path = r.stdout.trim().split('\n').pop() ?? dest;
  return { ok: true, path };
}
