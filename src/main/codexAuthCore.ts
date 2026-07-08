/**
 * Pure helpers for the Codex (ChatGPT subscription) OAuth flow — no Electron,
 * no network, no I/O, so they are unit-testable under vitest (Node). The
 * stateful login/refresh/store logic lives in codexAuth.ts.
 *
 * This replicates what the open-source `codex` CLI does internally
 * (codex-rs/login) so a user can sign in with their ChatGPT subscription and
 * we never need an OpenAI API key. Constants verified against the CLI source
 * and OpenAI's public Codex OAuth client (July 2026).
 */
import crypto from 'node:crypto';

/** Public OAuth client id shared by the official Codex CLI (not a secret). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_ISSUER = 'https://auth.openai.com';
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
/** The OAuth client only allows these two localhost ports; we bind the first
 *  that's free and build the redirect URI to match. */
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_PORT_FALLBACK = 1457;
export const CODEX_REDIRECT_PATH = '/auth/callback';

export function codexRedirectUri(port: number): string {
  return `http://localhost:${port}${CODEX_REDIRECT_PATH}`;
}
/** Minimal scopes needed for the token + refresh (proven by third-party tools). */
export const CODEX_SCOPE = 'openid profile email offline_access';
/** Identifies our requests to the ChatGPT backend, same value the CLI uses. */
export const CODEX_ORIGINATOR = 'codex_cli_rs';
/** Base URL of the ChatGPT-backend Responses API used with a subscription token. */
export const CODEX_BACKEND_URL = 'https://chatgpt.com/backend-api/codex';

/** Renew the access token this long before it actually expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

export type CodexPkce = { verifier: string; challenge: string };

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE (RFC 7636, S256): 64 random bytes → verifier, SHA-256(verifier) → challenge. */
export function generatePkce(): CodexPkce {
  const verifier = base64Url(crypto.randomBytes(64));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Opaque anti-CSRF value echoed back on the callback. */
export function generateState(): string {
  return base64Url(crypto.randomBytes(32));
}

/** Build the browser authorize URL with the exact params the Codex CLI sends. */
export function buildAuthorizeUrl(challenge: string, state: string, port: number): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: codexRedirectUri(port),
    scope: CODEX_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: CODEX_ORIGINATOR,
    state,
  });
  return `${CODEX_AUTHORIZE_URL}?${params.toString()}`;
}

/** Form body (x-www-form-urlencoded) for the code→token exchange. */
export function buildCodeExchangeBody(code: string, verifier: string, port: number): string {
  return new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: codexRedirectUri(port),
    client_id: CODEX_CLIENT_ID,
    code_verifier: verifier,
  }).toString();
}

/** JSON body for a refresh_token grant. Current Codex sends JSON (not form) and
 *  no `scope` — the token endpoint reuses the original grant's scopes. */
export function buildRefreshBody(refreshToken: string): string {
  return JSON.stringify({
    client_id: CODEX_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

/** The raw token bundle returned by the OpenAI token endpoint. */
export type CodexTokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

/** auth.json-shaped bundle we persist (mirrors the Codex CLI's auth.json). */
export type CodexAuthJson = {
  auth_mode: 'chatgpt';
  OPENAI_API_KEY: string | null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  /** ISO timestamp of the last successful (re)issue — set by the caller. */
  last_refresh: string;
};

export type CodexIdClaims = {
  email?: string;
  accountId?: string;
  planType?: string;
  /** Access-token expiry in epoch ms, when derivable from the JWT. */
  expMs?: number;
};

/** Decode a JWT payload without verifying the signature (we trust our own TLS call). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    b64 += '='.repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Pull the ChatGPT account id + plan + email out of the id_token claims. */
export function parseIdToken(idToken: string): CodexIdClaims {
  const payload = decodeJwtPayload(idToken);
  if (!payload) return {};
  const auth = (payload['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>;
  const email = typeof payload.email === 'string' ? payload.email : undefined;
  const accountId =
    typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined;
  const planType =
    typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : undefined;
  return { email, accountId, planType };
}

/** Read the access-token expiry (epoch ms) from its JWT `exp`, if present. */
export function accessTokenExpiry(accessToken: string): number | undefined {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/**
 * Whether the stored access token should be refreshed. Prefers the token's own
 * `exp`; falls back to the age of the last refresh (tokens live ~ an hour, so a
 * 25-minute floor is safely conservative) when `exp` can't be read.
 */
export function needsRefresh(auth: CodexAuthJson, now: number): boolean {
  const exp = accessTokenExpiry(auth.tokens.access_token);
  if (exp) return now >= exp - TOKEN_REFRESH_MARGIN_MS;
  const last = Date.parse(auth.last_refresh);
  if (Number.isNaN(last)) return true;
  return now - last > 25 * 60_000;
}

const PLAN_LABELS: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

/** Human label for the ChatGPT subscription tier shown in Settings. */
export function planLabel(planType: string | undefined): string {
  if (!planType) return 'ChatGPT';
  const known = PLAN_LABELS[planType.toLowerCase()];
  return known ? `ChatGPT ${known}` : `ChatGPT (${planType})`;
}
