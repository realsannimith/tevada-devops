import { describe, expect, it } from 'vitest';
import { actionableSshError, normalizePrivateKey } from './connection-manager';

describe('normalizePrivateKey', () => {
  it('removes a BOM and normalizes uploaded Windows line endings', () => {
    expect(normalizePrivateKey('\uFEFF-----BEGIN KEY-----\r\nabc\r\n-----END KEY-----\r\n')).toBe(
      '-----BEGIN KEY-----\nabc\n-----END KEY-----\n',
    );
  });
});

describe('actionableSshError', () => {
  it('explains that generic key authentication failure is not an upload failure', () => {
    const result = actionableSshError('All configured authentication methods failed', {
      authType: 'key',
      username: 'ubuntu',
    });
    expect(result).toContain('server is reachable');
    expect(result).toContain('upload worked');
    expect(result).toContain('DigitalOcean');
    expect(result).toContain('root');
  });

  it('leaves unrelated errors untouched', () => {
    expect(
      actionableSshError('connect ETIMEDOUT', { authType: 'key', username: 'ubuntu' }),
    ).toBe('connect ETIMEDOUT');
  });
});
