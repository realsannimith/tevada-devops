import { describe, expect, it } from 'vitest';
import { upsertClaudeConfig, upsertCodexConfig } from './mcpInstall';

const URL = 'http://127.0.0.1:7423/mcp';
const TOKEN = 'tok_abc123';
const HEADERS = { Authorization: `Bearer ${TOKEN}` };

describe('upsertClaudeConfig', () => {
  it('creates a fresh config when none exists', () => {
    const parsed = JSON.parse(upsertClaudeConfig(null, URL, TOKEN));
    expect(parsed.mcpServers['tevada-devops']).toEqual({
      type: 'http',
      url: URL,
      headers: HEADERS,
    });
  });

  it('preserves unrelated keys and other servers', () => {
    const existing = JSON.stringify({
      numStartups: 42,
      mcpServers: { other: { type: 'stdio', command: 'foo' } },
      projects: { '/tmp': { history: [] } },
    });
    const parsed = JSON.parse(upsertClaudeConfig(existing, URL, TOKEN));
    expect(parsed.numStartups).toBe(42);
    expect(parsed.mcpServers.other).toEqual({ type: 'stdio', command: 'foo' });
    expect(parsed.projects['/tmp']).toEqual({ history: [] });
    expect(parsed.mcpServers['tevada-devops'].url).toBe(URL);
    expect(parsed.mcpServers['tevada-devops'].headers).toEqual(HEADERS);
  });

  it('replaces an existing entry (e.g. after a port or token change)', () => {
    const first = upsertClaudeConfig(null, URL, TOKEN);
    const second = JSON.parse(
      upsertClaudeConfig(first, 'http://127.0.0.1:9999/mcp', 'tok_rotated'),
    );
    expect(second.mcpServers['tevada-devops'].url).toBe(
      'http://127.0.0.1:9999/mcp',
    );
    expect(second.mcpServers['tevada-devops'].headers).toEqual({
      Authorization: 'Bearer tok_rotated',
    });
  });

  it('throws on a corrupt file instead of clobbering it', () => {
    expect(() => upsertClaudeConfig('not json', URL, TOKEN)).toThrow();
  });
});

describe('upsertCodexConfig', () => {
  const BLOCK = `[mcp_servers.tevada-devops]\nurl = "${URL}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }\n`;

  it('appends to an empty / missing config', () => {
    expect(upsertCodexConfig(null, URL, TOKEN)).toBe(BLOCK);
  });

  it('appends after existing content with a blank-line separator', () => {
    const existing = 'model = "gpt-5.5"\n';
    const out = upsertCodexConfig(existing, URL, TOKEN);
    expect(out).toBe(`model = "gpt-5.5"\n\n${BLOCK}`);
  });

  it('replaces an existing block in place, leaving later tables intact', () => {
    const existing = [
      'model = "gpt-5.5"',
      '',
      '[mcp_servers.tevada-devops]',
      'url = "http://127.0.0.1:1111/mcp"',
      '',
      '[mcp_servers.other]',
      'command = "foo"',
      '',
    ].join('\n');
    const out = upsertCodexConfig(existing, URL, TOKEN);
    expect(out).toContain(
      `[mcp_servers.tevada-devops]\nurl = "${URL}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }`,
    );
    expect(out).toContain('[mcp_servers.other]\ncommand = "foo"');
    expect(out).toContain('model = "gpt-5.5"');
    expect(out.match(/tevada-devops/g)).toHaveLength(1);
  });

  it('upgrades a pre-token block (no http_headers) in place', () => {
    const existing = `[mcp_servers.tevada-devops]\nurl = "${URL}"\n`;
    const out = upsertCodexConfig(existing, URL, TOKEN);
    expect(out).toBe(BLOCK);
  });
});
