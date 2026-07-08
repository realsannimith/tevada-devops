import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accessTokenExpiry,
  buildAuthorizeUrl,
  buildCodeExchangeBody,
  buildRefreshBody,
  CODEX_CLIENT_ID,
  codexRedirectUri,
  generatePkce,
  generateState,
  needsRefresh,
  parseIdToken,
  planLabel,
  type CodexAuthJson,
} from './codexAuthCore';

/** Build an unsigned JWT (header.payload.sig) for parsing tests. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

describe('generatePkce', () => {
  it('produces an S256 challenge = base64url(sha256(verifier))', () => {
    const { verifier, challenge } = generatePkce();
    const expected = crypto
      .createHash('sha256')
      .update(verifier)
      .digest('base64url');
    expect(challenge).toBe(expected);
    // base64url, no padding
    expect(verifier).not.toMatch(/[+/=]/);
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('is random each call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe('buildAuthorizeUrl', () => {
  it('sends the exact Codex OAuth params + PKCE + port-matched redirect', () => {
    const url = new URL(buildAuthorizeUrl('CHALLENGE', 'STATE', 1455));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CODEX_CLIENT_ID);
    expect(p.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(p.get('code_challenge')).toBe('CHALLENGE');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('STATE');
    expect(p.get('id_token_add_organizations')).toBe('true');
    expect(p.get('codex_cli_simplified_flow')).toBe('true');
    expect(p.get('originator')).toBe('codex_cli_rs');
    expect(p.get('scope')).toContain('offline_access');
  });

  it('matches the redirect port to the bound fallback port', () => {
    const url = new URL(buildAuthorizeUrl('c', 's', 1457));
    expect(url.searchParams.get('redirect_uri')).toBe(codexRedirectUri(1457));
    expect(codexRedirectUri(1457)).toBe('http://localhost:1457/auth/callback');
  });
});

describe('token bodies', () => {
  it('code exchange is form-encoded with the verifier + matching redirect', () => {
    const body = new URLSearchParams(buildCodeExchangeBody('CODE', 'VERIFIER', 1455));
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('code_verifier')).toBe('VERIFIER');
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(body.get('client_id')).toBe(CODEX_CLIENT_ID);
  });

  it('refresh is JSON with no scope (matches current Codex CLI)', () => {
    const body = JSON.parse(buildRefreshBody('REFRESH'));
    expect(body).toEqual({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: 'REFRESH',
    });
    expect(body.scope).toBeUndefined();
  });
});

describe('parseIdToken', () => {
  it('reads email + account id + plan from the namespaced auth claim', () => {
    const token = jwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-123',
        chatgpt_plan_type: 'pro',
      },
    });
    expect(parseIdToken(token)).toEqual({
      email: 'user@example.com',
      accountId: 'acct-123',
      planType: 'pro',
    });
  });

  it('is safe on a malformed token', () => {
    expect(parseIdToken('not-a-jwt')).toEqual({});
  });
});

describe('accessTokenExpiry + needsRefresh', () => {
  const authWith = (accessToken: string, lastRefresh: string): CodexAuthJson => ({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: 'i', access_token: accessToken, refresh_token: 'r', account_id: 'a' },
    last_refresh: lastRefresh,
  });

  it('reads exp (ms) from the access-token JWT', () => {
    const token = jwt({ exp: 1_000 });
    expect(accessTokenExpiry(token)).toBe(1_000_000);
  });

  it('refreshes within 5 min of exp, not before', () => {
    const now = 2_000_000;
    const soon = jwt({ exp: (now + 4 * 60_000) / 1000 }); // expires in 4 min
    const later = jwt({ exp: (now + 30 * 60_000) / 1000 }); // 30 min out
    expect(needsRefresh(authWith(soon, new Date(now).toISOString()), now)).toBe(true);
    expect(needsRefresh(authWith(later, new Date(now).toISOString()), now)).toBe(false);
  });

  it('falls back to last_refresh age when exp is unreadable', () => {
    const now = Date.now();
    const fresh = new Date(now - 5 * 60_000).toISOString();
    const stale = new Date(now - 40 * 60_000).toISOString();
    expect(needsRefresh(authWith('opaque', fresh), now)).toBe(false);
    expect(needsRefresh(authWith('opaque', stale), now)).toBe(true);
  });
});

describe('planLabel', () => {
  it('maps known plans and falls back for unknown ones', () => {
    expect(planLabel('plus')).toBe('ChatGPT Plus');
    expect(planLabel('pro')).toBe('ChatGPT Pro');
    expect(planLabel('edu')).toBe('ChatGPT Edu');
    expect(planLabel('k12')).toBe('ChatGPT (k12)');
    expect(planLabel(undefined)).toBe('ChatGPT');
  });
});
