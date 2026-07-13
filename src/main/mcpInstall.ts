/**
 * One-click MCP integration: writes the Tevada DevOps MCP endpoint into the
 * local config of the user's coding agent (Claude Code, Codex) so they don't
 * have to touch a config file. The content transforms are pure functions so
 * they can be unit-tested; only the thin install* wrappers touch the disk.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McpInstallClient, McpInstallResult } from '../shared/ipc-types';

export const MCP_SERVER_KEY = 'tevada-devops';

/** Upsert our server into Claude Code's user config (~/.claude.json). The file
 *  holds unrelated state, so everything else is preserved verbatim. */
export function upsertClaudeConfig(content: string | null, url: string): string {
  let parsed: Record<string, unknown> = {};
  if (content && content.trim()) {
    parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('~/.claude.json is not a JSON object');
    }
  }
  const mcpServers =
    typeof parsed.mcpServers === 'object' &&
    parsed.mcpServers !== null &&
    !Array.isArray(parsed.mcpServers)
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  mcpServers[MCP_SERVER_KEY] = { type: 'http', url };
  parsed.mcpServers = mcpServers;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** Upsert our server block into Codex's config (~/.codex/config.toml). If the
 *  block already exists it is replaced in place; otherwise it is appended. */
export function upsertCodexConfig(content: string | null, url: string): string {
  const block = `[mcp_servers.${MCP_SERVER_KEY}]\nurl = "${url}"\n`;
  const existing = content ?? '';
  const headerPattern = new RegExp(
    // The block runs from our table header to just before the next table
    // header (a line starting with "[") or the end of the file.
    `\\[mcp_servers\\.${MCP_SERVER_KEY}\\][^[]*`,
  );
  if (headerPattern.test(existing)) {
    return existing.replace(headerPattern, block);
  }
  const sep = existing.length === 0 || existing.endsWith('\n\n')
    ? ''
    : existing.endsWith('\n')
      ? '\n'
      : '\n\n';
  return `${existing}${sep}${block}`;
}

function installClaudeCode(url: string): McpInstallResult {
  const path = join(homedir(), '.claude.json');
  try {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    writeFileSync(path, upsertClaudeConfig(current, url));
    return {
      ok: true,
      detail:
        'Added to Claude Code (user scope). Start a new Claude Code session and the tevada-devops tools appear under /mcp.',
    };
  } catch (err) {
    return {
      ok: false,
      error: `Could not update ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function installCodex(url: string): McpInstallResult {
  const path = join(homedir(), '.codex', 'config.toml');
  try {
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
    writeFileSync(path, upsertCodexConfig(current, url));
    return {
      ok: true,
      detail:
        'Added to Codex (~/.codex/config.toml). Restart Codex and the tevada-devops tools are available. Requires a Codex CLI version with HTTP MCP support.',
    };
  } catch (err) {
    return {
      ok: false,
      error: `Could not update ${path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function installMcpClient(
  client: McpInstallClient,
  url: string,
): McpInstallResult {
  switch (client) {
    case 'claude-code':
      return installClaudeCode(url);
    case 'codex':
      return installCodex(url);
  }
}
