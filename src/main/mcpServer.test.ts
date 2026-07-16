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
    sftpReadFile: vi.fn(async () => ({ content: 'file body', truncated: false })),
    sftpList: vi.fn(async () => ({
      path: '/opt/app',
      entries: [
        {
          name: 'run.sh',
          path: '/opt/app/run.sh',
          type: 'file' as const,
          size: 42,
          mtime: 1700000000000,
          mode: 0o100755,
        },
      ],
    })),
    scanArtifacts: vi.fn(async () => ({
      ok: true as const,
      ts: 1,
      artifacts: [
        {
          id: 'container:web',
          kind: 'container' as const,
          name: 'web',
          status: 'running' as const,
          ports: [8080],
        },
      ],
    })),
    listDeployments: vi.fn(async () => ({
      ok: true as const,
      ts: 1,
      deployments: [
        {
          app: 'site',
          repo: 'acme/site',
          log: '/var/log/site-deploy.log',
          events: [],
        },
      ],
    })),
    readDeployLog: vi.fn(async () => ({
      ok: true as const,
      content: 'build ok',
    })),
    getAlertsInfo: () => ({
      configured: true,
      incidents: [
        { serverId: 'srv-1', metric: 'disk' as const, firedAt: 1700000000000 },
      ],
    }),
    isReadOnly: () => false,
    listGithubRepos: vi.fn(async () => ({
      ok: true as const,
      repos: [
        {
          fullName: 'acme/site',
          private: true,
          defaultBranch: 'main',
          description: 'Site',
        },
      ],
    })) as unknown as McpDeps['listGithubRepos'],
    githubAuthorizedServerIds: () => ['srv-1'],
    setupDeployNotifications: vi.fn(async () => ({
      ok: true,
      telegramConfigured: false,
    })),
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
      'get_alerts',
      'get_artifacts',
      'get_deploy_log',
      'get_server_stats',
      'list_deploys',
      'list_directory',
      'list_github_repos',
      'list_projects',
      'list_servers',
      'list_skills',
      'load_skill',
      'read_file',
      'run_command',
      'run_script',
      'setup_deploy_notifications',
      'write_file',
    ]);
  });

  it('read-only mode drops every command/write tool', async () => {
    const client = await connect(makeDeps({ isReadOnly: () => true }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const banned of [
      'run_command',
      'run_script',
      'write_file',
      'setup_deploy_notifications',
    ]) {
      expect(names).not.toContain(banned);
    }
    expect(names).toContain('list_servers');
    expect(names).toContain('read_file');
    expect(names).toContain('get_artifacts');
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

  it('load_skill returns the body with the MCP tool-name mapping, and errors on unknown names', async () => {
    const client = await connect(makeDeps());
    const ok = await client.callTool({
      name: 'load_skill',
      arguments: { name: 'docker-deploy' },
    });
    expect(firstText(ok)).toContain('# Docker deploy');
    expect(firstText(ok)).toContain('runCommand → run_command');
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

  it('list_github_repos returns repos plus credentialed servers, and surfaces errors', async () => {
    const client = await connect(makeDeps());
    const ok = await client.callTool({ name: 'list_github_repos', arguments: {} });
    const parsed = JSON.parse(firstText(ok)) as {
      authorizedServerIds: string[];
      repos: { fullName: string }[];
    };
    expect(parsed.authorizedServerIds).toEqual(['srv-1']);
    expect(parsed.repos[0].fullName).toBe('acme/site');

    const deps = makeDeps({
      listGithubRepos: async () => ({ ok: false as const, error: 'GitHub is not connected.' }),
    });
    const bad = await (await connect(deps)).callTool({
      name: 'list_github_repos',
      arguments: {},
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain('Settings → GitHub');
  });

  it('setup_deploy_notifications connects and returns the provision result', async () => {
    const deps = makeDeps({ getStatus: () => 'disconnected' });
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'setup_deploy_notifications',
      arguments: { server: 'DGO' },
    });
    // "DGO" doesn't resolve — unknown server error path.
    expect(res.isError).toBe(true);

    const ok = await client.callTool({
      name: 'setup_deploy_notifications',
      arguments: { server: 'Staging' },
    });
    expect(ok.isError).toBeFalsy();
    expect(deps.connect).toHaveBeenCalledWith('srv-1');
    expect(deps.setupDeployNotifications).toHaveBeenCalledWith('srv-1');
    expect(JSON.parse(firstText(ok))).toEqual({ ok: true, telegramConfigured: false });
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

  it('run_command hard-rejects catastrophic commands without executing them', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'run_command',
      arguments: { server: 'Staging', command: 'rm -rf /' },
    });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('safety guard');
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it('run_script stages the script, runs it, and cleans up', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'run_script',
      arguments: { server: 'Staging', script: 'echo one\necho two', sudo: true },
    });
    expect(res.isError).toBeFalsy();
    const [, staged, body] = (deps.sftpWriteFile as ReturnType<typeof vi.fn>)
      .mock.calls[0] as [string, string, string];
    expect(staged).toMatch(/^\/tmp\/easyhost-mcp-script-.*\.sh$/);
    expect(body).toBe('set -euo pipefail\necho one\necho two\n');
    expect(deps.exec).toHaveBeenCalledWith(
      'srv-1',
      `sudo bash ${staged}; rc=$?; rm -f ${staged}; exit $rc`,
      expect.anything(),
    );
  });

  it('run_script rejects catastrophic scripts', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const res = await client.callTool({
      name: 'run_script',
      arguments: { server: 'Staging', script: 'echo hi\nmkfs.ext4 /dev/sda1' },
    });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('safety guard');
    expect(deps.sftpWriteFile).not.toHaveBeenCalled();
  });

  it('read_file returns content and marks truncation', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const ok = await client.callTool({
      name: 'read_file',
      arguments: { server: 'Staging', path: '/etc/nginx/nginx.conf' },
    });
    expect(ok.isError).toBeFalsy();
    expect(firstText(ok)).toBe('file body');
    expect(deps.sftpReadFile).toHaveBeenCalledWith(
      'srv-1',
      '/etc/nginx/nginx.conf',
      32 * 1024,
    );

    const truncatedDeps = makeDeps({
      sftpReadFile: vi.fn(async () => ({ content: 'partial', truncated: true })),
    });
    const truncated = await (await connect(truncatedDeps)).callTool({
      name: 'read_file',
      arguments: { server: 'Staging', path: '/big.log', maxBytes: 1024 },
    });
    expect(firstText(truncated)).toContain('partial');
    expect(firstText(truncated)).toContain('truncated at 1024 bytes');
  });

  it('list_directory returns structured entries with octal modes', async () => {
    const client = await connect(makeDeps());
    const res = await client.callTool({
      name: 'list_directory',
      arguments: { server: 'Staging', path: '/opt/app' },
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(firstText(res)) as {
      path: string;
      entries: { name: string; mode: string; mtime: string }[];
    };
    expect(parsed.path).toBe('/opt/app');
    expect(parsed.entries[0].name).toBe('run.sh');
    expect(parsed.entries[0].mode).toBe('755');
    expect(parsed.entries[0].mtime).toBe(new Date(1700000000000).toISOString());
  });

  it('get_artifacts scans and surfaces errors', async () => {
    const client = await connect(makeDeps());
    const ok = await client.callTool({
      name: 'get_artifacts',
      arguments: { server: 'Staging' },
    });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(firstText(ok))[0].name).toBe('web');

    const bad = await (
      await connect(
        makeDeps({
          scanArtifacts: vi.fn(async () => ({
            ok: false as const,
            error: 'scan blew up',
          })),
        }),
      )
    ).callTool({ name: 'get_artifacts', arguments: { server: 'Staging' } });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain('scan blew up');
  });

  it('list_deploys and get_deploy_log read the deploy registry and log', async () => {
    const deps = makeDeps();
    const client = await connect(deps);
    const deploys = await client.callTool({
      name: 'list_deploys',
      arguments: { server: 'Staging' },
    });
    expect(JSON.parse(firstText(deploys))[0].app).toBe('site');

    const log = await client.callTool({
      name: 'get_deploy_log',
      arguments: { server: 'Staging', logPath: '/var/log/site-deploy.log' },
    });
    expect(firstText(log)).toBe('build ok');
    expect(deps.readDeployLog).toHaveBeenCalledWith(
      'srv-1',
      '/var/log/site-deploy.log',
    );
  });

  it('get_alerts maps incidents to server names and reports unconfigured alerting', async () => {
    const client = await connect(makeDeps());
    const res = await client.callTool({ name: 'get_alerts', arguments: {} });
    const parsed = JSON.parse(firstText(res)) as {
      incidents: { server: string; metric: string; state: string }[];
    };
    expect(parsed.incidents).toEqual([
      {
        server: 'Staging',
        metric: 'disk',
        state: 'firing',
        since: new Date(1700000000000).toISOString(),
      },
    ]);

    const off = await (
      await connect(
        makeDeps({ getAlertsInfo: () => ({ configured: false, incidents: [] }) }),
      )
    ).callTool({ name: 'get_alerts', arguments: {} });
    expect(off.isError).toBeFalsy();
    expect(firstText(off)).toContain('not configured');
  });
});
