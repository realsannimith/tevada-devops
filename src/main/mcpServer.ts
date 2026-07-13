/**
 * Local MCP server — lets external coding agents (Claude Code, Codex, or any
 * MCP-capable client) operate on the user's servers THROUGH this app: the app
 * stays the single owner of SSH credentials and connections, and simply
 * exposes a small tool surface over Streamable HTTP on localhost.
 *
 * Security model: the endpoint binds to 127.0.0.1 only and rejects non-local
 * Host headers (DNS-rebinding protection), so only processes on this machine
 * can reach it. Starting the server is an explicit user action in Settings —
 * commands from connected agents then run with the same access the in-app
 * agent has.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// The SDK resolves its own (v3-flavoured) zod for tool schemas; zod 4 ships
// the matching implementation under this compat subpath.
import { z } from 'zod/v3';
import type {
  ConnStatus,
  ExecResult,
  McpStatus,
  Project,
  ServerProfile,
  ServerStats,
} from '../shared/ipc-types';

/** Everything the tools need, injected by ipc.ts so this file stays testable. */
export type McpDeps = {
  listServers: () => ServerProfile[];
  listProjects: () => Project[];
  getStatus: (serverId: string) => ConnStatus;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  exec: (
    serverId: string,
    command: string,
    opts: { timeoutMs?: number },
  ) => Promise<ExecResult>;
  getStats: (serverId: string) => ServerStats | undefined;
};

const MAX_COMMAND_TIMEOUT_S = 600;
const DEFAULT_COMMAND_TIMEOUT_S = 120;

const SERVER_INSTRUCTIONS = [
  'Tevada DevOps gives you SSH access to the servers the user manages in the',
  'Tevada DevOps desktop app. Call list_servers first to see what exists (and',
  'which project each server belongs to), then run_command to execute shell',
  'commands. Connections are opened on demand — you never handle credentials.',
].join(' ');

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], isError };
}

/** Result shape every tool handler returns (the SDK's CallToolResult subset). */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
};

/** Builds one MCP server instance. Stateless transport = one per request. */
export function buildMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'tevada-devops', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Loosely-typed registrar: checking our zod schemas against the SDK's own
  // zod copy overflows TS's instantiation depth (zod types are deeply
  // recursive), so the schema slot is opaque and each handler types its own
  // args. Runtime validation still happens in the SDK against the zod shapes.
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: {
      title?: string;
      description?: string;
      inputSchema?: unknown;
    },
    cb: (args: unknown) => ToolResult | Promise<ToolResult>,
  ) => void;

  /** Accepts a server id OR (case-insensitive) name, so agents can say
   *  "run this on staging" without a lookup round-trip. */
  const resolveServer = (ref: string): ServerProfile | undefined => {
    const servers = deps.listServers();
    return (
      servers.find((s) => s.id === ref) ??
      servers.find((s) => s.name.toLowerCase() === ref.toLowerCase())
    );
  };

  registerTool(
    'list_servers',
    {
      title: 'List servers',
      description:
        'List every server managed in Tevada DevOps: id, name, host, user, connection status, and the projects it belongs to.',
      inputSchema: {},
    },
    () => {
      const projects = deps.listProjects();
      const rows = deps.listServers().map((s) => ({
        id: s.id,
        name: s.name,
        host: s.host,
        port: s.port,
        username: s.username,
        status: deps.getStatus(s.id),
        projects: (s.projectIds ?? [])
          .map((id) => projects.find((p) => p.id === id)?.name)
          .filter(Boolean),
      }));
      if (rows.length === 0) {
        return text(
          'No servers configured yet. Ask the user to add one in the Tevada DevOps app.',
        );
      }
      return text(JSON.stringify(rows, null, 2));
    },
  );

  registerTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        "List the user's projects: name, member servers, and the project memory notes.",
      inputSchema: {},
    },
    () => {
      const servers = deps.listServers();
      const rows = deps.listProjects().map((p) => ({
        id: p.id,
        name: p.name,
        servers: servers
          .filter((s) => s.projectIds?.includes(p.id))
          .map((s) => s.name),
        memory: p.memory || undefined,
      }));
      if (rows.length === 0) return text('The user has no projects yet.');
      return text(JSON.stringify(rows, null, 2));
    },
  );

  registerTool(
    'run_command',
    {
      title: 'Run command',
      description:
        'Run a shell command on one of the servers over SSH (connects automatically). Returns stdout, stderr, and the exit code.',
      inputSchema: {
        server: z
          .string()
          .describe('Server id or name (see list_servers).'),
        command: z.string().describe('Shell command to execute.'),
        timeoutSeconds: z
          .number()
          .optional()
          .describe(
            `Seconds before the command is aborted (default ${DEFAULT_COMMAND_TIMEOUT_S}, max ${MAX_COMMAND_TIMEOUT_S}).`,
          ),
      },
    },
    async (args: unknown) => {
      const { server: ref, command, timeoutSeconds } = args as {
        server: string;
        command: string;
        timeoutSeconds?: number;
      };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      if (deps.getStatus(profile.id) !== 'connected') {
        const conn = await deps.connect(profile.id);
        if (!conn.ok) {
          return text(
            `Could not connect to "${profile.name}": ${conn.error ?? 'unknown error'}`,
            true,
          );
        }
      }
      const timeoutMs =
        Math.min(
          Math.max(timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
          MAX_COMMAND_TIMEOUT_S,
        ) * 1000;
      try {
        const result = await deps.exec(profile.id, command, { timeoutMs });
        const parts = [
          `exit code: ${result.exitCode ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}${result.truncated ? ' (output truncated)' : ''}`,
        ];
        if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr}`);
        return text(parts.join('\n\n'), (result.exitCode ?? 1) !== 0);
      } catch (err) {
        return text(
          `Command failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  registerTool(
    'get_server_stats',
    {
      title: 'Get server stats',
      description:
        'Latest monitoring snapshot for a server (CPU, memory, disk, network) if the app has been polling it.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
      },
    },
    (args: unknown) => {
      const { server: ref } = args as { server: string };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const stats = deps.getStats(profile.id);
      if (!stats) {
        return text(
          `No stats collected for "${profile.name}" yet — the app polls a server while its dashboard or monitoring view is open. You can run_command (e.g. \`uptime\`, \`free -h\`, \`df -h\`) instead.`,
        );
      }
      return text(JSON.stringify(stats, null, 2));
    },
  );

  return server;
}

/** Owns the localhost HTTP endpoint and its lifecycle. One per app. */
export class TevadaMcpServer {
  private http: HttpServer | null = null;
  private port = 0;
  private lastError: string | undefined;

  constructor(
    private readonly deps: McpDeps,
    private readonly onStatusChange: (status: McpStatus) => void = () => {},
  ) {}

  status(): McpStatus {
    return {
      running: this.http !== null,
      port: this.port,
      url: this.http ? `http://127.0.0.1:${this.port}/mcp` : null,
      error: this.lastError,
    };
  }

  async start(port: number): Promise<McpStatus> {
    if (this.http) {
      if (this.port === port) return this.status();
      await this.stop();
    }
    this.lastError = undefined;
    const allowedHosts = [
      '127.0.0.1',
      `127.0.0.1:${port}`,
      'localhost',
      `localhost:${port}`,
    ];
    const http = createServer((req, res) => {
      void (async () => {
        if (!req.url || !req.url.startsWith('/mcp')) {
          res.writeHead(404).end('Not found');
          return;
        }
        // Stateless mode: a fresh server + transport per request keeps the
        // endpoint robust across client reconnects (no session bookkeeping).
        const mcp = buildMcpServer(this.deps);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
          enableDnsRebindingProtection: true,
          allowedHosts,
        });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      })().catch((err) => {
        console.warn('[mcp] request failed', err);
        if (!res.headersSent) res.writeHead(500).end('Internal error');
      });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        http.once('error', reject);
        http.listen(port, '127.0.0.1', () => {
          http.removeListener('error', reject);
          resolve();
        });
      });
    } catch (err) {
      this.lastError =
        err instanceof Error && 'code' in err && err.code === 'EADDRINUSE'
          ? `Port ${port} is already in use — pick another port.`
          : err instanceof Error
            ? err.message
            : String(err);
      const status = this.status();
      this.onStatusChange(status);
      return status;
    }
    this.http = http;
    this.port = port;
    const status = this.status();
    this.onStatusChange(status);
    return status;
  }

  async stop(): Promise<McpStatus> {
    const http = this.http;
    this.http = null;
    if (http) {
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        // Kick idle keep-alive sockets so close() doesn't hang.
        http.closeAllConnections?.();
      });
    }
    const status = this.status();
    this.onStatusChange(status);
    return status;
  }
}
