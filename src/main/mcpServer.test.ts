/**
 * End-to-end tests for the local MCP server: a real MCP client talks to
 * buildMcpServer over the SDK's in-memory transport, so these cover the same
 * wire path external agents (Claude Code, Codex) use — only the HTTP layer is
 * skipped.
 */
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer, type McpDeps } from './mcpServer';
import type { ServerProfile } from '../shared/ipc-types';
import type { Skill } from '../agent/skills';

const SERVER: ServerProfile = {
  id: 'srv-1',
  name: 'Staging',
  host: '203.0.113.7',
  port: 22,
  username: 'root',
} as ServerProfile;

const SKILLS: Skill[] = [
  {
    name: 'docker-deploy',
    description: 'Deploy an app with Docker.',
    body: '# Docker deploy\nStep 1 …',
    source: 'bundled',
  },
  {
    name: 'my-note',
    description: 'User-authored procedure.',
    body: '# My note',
    source: 'user',
  },
];

function makeDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    listServers: () => [SERVER],
    listProjects: () => [],
    getStatus: () => 'connected',
    connect: vi.fn(async () => ({ ok: true })),
    exec: vi.fn(async () => ({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
    })) as unknown as McpDeps['exec'],
    getStats: () => undefined,
    listSkills: () => SKILLS,
    sftpWriteFile: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function connect(deps: McpDeps) {
  const server = buildMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function firstText(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]?.text ?? '';
}

describe('mcp server tools', () => {
  it('exposes the full tool surface', async () => {
    const client = await connect(makeDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_server_stats',
      'list_projects',
      'list_servers',
      'list_skills',
      'load_skill',
      'run_command',
      'write_file',
    ]);
  });

  it('list_skills returns the same catalog the in-app agent gets', async () => {
    const client = await connect(makeDeps());
    const res = await client.callTool({ name: 'list_skills', arguments: {} });
    const rows = JSON.parse(firstText(res)) as Skill[];
    expect(rows).toEqual([
      { name: 'docker-deploy', description: 'Deploy an app with Docker.', source: 'bundled' },
      { name: 'my-note', description: 'User-authored procedure.', source: 'user' },
    ]);
  });

  it('load_skill returns the full body, and errors on unknown names', async () => {
    const client = await connect(makeDeps());
    const ok = await client.callTool({
      name: 'load_skill',
      arguments: { name: 'docker-deploy' },
    });
    expect(firstText(ok)).toContain('# Docker deploy');
    expect(ok.isError).toBeFalsy();

    const bad = await client.callTool({
      name: 'load_skill',
      arguments: { name: 'nope' },
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain('docker-deploy, my-note');
  });

  it('write_file writes over sftp and applies the mode', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'write_file',
      arguments: { server: 'Staging', path: '/opt/app/run.sh', content: '#!/bin/sh\n', mode: '755' },
    });
    expect(res.isError).toBeFalsy();
    expect(deps.sftpWriteFile).toHaveBeenCalledWith('srv-1', '/opt/app/run.sh', '#!/bin/sh\n');
    expect(deps.exec).toHaveBeenCalledWith(
      'srv-1',
      "chmod 755 '/opt/app/run.sh'",
      expect.anything(),
    );
  });

  it('write_file sudo path stages in /tmp then moves with sudo', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'write_file',
      arguments: { server: 'srv-1', path: '/etc/cron.d/x', content: 'line', sudo: true },
    });
    expect(res.isError).toBeFalsy();
    const staged = (deps.sftpWriteFile as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as string;
    expect(staged).toMatch(/^\/tmp\/easyhost-mcp-/);
    expect(deps.exec).toHaveBeenCalledWith(
      'srv-1',
      `sudo mv '${staged}' '/etc/cron.d/x'; echo done`,
      expect.anything(),
    );
  });

  it('write_file rejects a bad mode and unknown server', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const badMode = await client.callTool({
      name: 'write_file',
      arguments: { server: 'srv-1', path: '/x', content: 'c', mode: 'rwx' },
    });
    expect(badMode.isError).toBe(true);
    expect(deps.sftpWriteFile).not.toHaveBeenCalled();

    const badServer = await client.callTool({
      name: 'write_file',
      arguments: { server: 'ghost', path: '/x', content: 'c' },
    });
    expect(badServer.isError).toBe(true);
  });

  it('run_command connects on demand and reports exit codes', async () => {
    const connectFn = vi.fn(async () => ({ ok: true }));
    const deps = makeDeps({
      getStatus: () => 'disconnected',
      connect: connectFn,
      exec: vi.fn(async () => ({
        stdout: '',
        stderr: 'boom',
        exitCode: 2,
      })) as unknown as McpDeps['exec'],
    });
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'run_command',
      arguments: { server: 'staging', command: 'false' },
    });
    expect(connectFn).toHaveBeenCalledWith('srv-1');
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('exit code: 2');
    expect(firstText(res)).toContain('boom');
  });
});
