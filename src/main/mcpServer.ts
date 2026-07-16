/**
 * Local MCP server — lets external coding agents (Claude Code, Codex, or any
 * MCP-capable client) operate on the user's servers THROUGH this app: the app
 * stays the single owner of SSH credentials and connections, and simply
 * exposes a small tool surface over Streamable HTTP on localhost.
 *
 * Security model: the endpoint binds to 127.0.0.1 only, rejects non-local
 * Host headers (DNS-rebinding protection), and every request must present the
 * per-install bearer token shown in Settings — so neither remote machines nor
 * arbitrary local processes can drive it. Starting the server is an explicit
 * user action in Settings — commands from connected agents then run with the
 * same access the in-app agent has (or read-only, when that mode is on).
 * Catastrophic commands (rm -rf /, mkfs, …) are rejected outright: MCP has no
 * interactive approval channel, so the in-app confirmation seatbelt becomes a
 * hard block here.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
// The SDK resolves its own (v3-flavoured) zod for tool schemas; zod 4 ships
// the matching implementation under this compat subpath.
import { z } from 'zod/v3';
import type {
  AlertMetric,
  ArtifactsScanResult,
  ConnStatus,
  DeploymentsResult,
  DeployLogResult,
  ExecResult,
  GithubReposResult,
  McpStatus,
  Project,
  ServerProfile,
  ServerStats,
  SftpEntry,
} from '../shared/ipc-types';
import type { Skill } from '../agent/skills';
import { isCatastrophic } from '../agent/blacklist';

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
  /** The same skill library the in-app agent uses (bundled + user, user wins);
   *  called per request so user skill edits apply without a restart. */
  listSkills: () => Skill[];
  sftpWriteFile: (serverId: string, path: string, content: string) => Promise<void>;
  sftpReadFile: (
    serverId: string,
    path: string,
    maxBytes: number,
  ) => Promise<{ content: string; truncated: boolean }>;
  sftpList: (
    serverId: string,
    path: string,
  ) => Promise<{ path: string; entries: SftpEntry[] }>;
  scanArtifacts: (serverId: string) => Promise<ArtifactsScanResult>;
  listDeployments: (serverId: string) => Promise<DeploymentsResult>;
  readDeployLog: (serverId: string, logPath: string) => Promise<DeployLogResult>;
  /** Firing incidents from the background alert engine, plus whether alerting
   *  is configured at all (token + chat present). */
  getAlertsInfo: () => {
    configured: boolean;
    incidents: { serverId: string; metric: AlertMetric; firedAt: number }[];
  };
  /** Live read of the Settings toggle: true = expose only read/observe tools. */
  isReadOnly: () => boolean;
  listGithubRepos: () => Promise<GithubReposResult>;
  githubAuthorizedServerIds: () => string[];
  setupDeployNotifications: (
    serverId: string,
  ) => Promise<{ ok: boolean; telegramConfigured?: boolean; error?: string }>;
};

const MAX_COMMAND_TIMEOUT_S = 600;
const DEFAULT_COMMAND_TIMEOUT_S = 120;
const DEFAULT_READ_BYTES = 32 * 1024;
const MAX_READ_BYTES = 512 * 1024;

const SERVER_INSTRUCTIONS = [
  'Tevada DevOps gives you SSH access to the servers the user manages in the',
  'Tevada DevOps desktop app. Call list_servers first to see what exists (and',
  'which project each server belongs to), then run_command / run_script to',
  'execute shell commands. Connections are opened on demand — you never handle',
  'credentials. Use get_artifacts to discover what is running on a server',
  '(sites, containers, databases, services), list_deploys / get_deploy_log to',
  'inspect automated deployments, and get_alerts to see firing incidents.',
  'The app also ships a library of vetted DevOps skills (step-by-step',
  'procedures for deploys, hardening, backups, TLS, troubleshooting…) — the',
  'same ones its built-in agent follows. BEFORE starting work that matches a',
  'skill (call list_skills to see them), call load_skill and follow the',
  'instructions: they encode non-interactive flags, security defaults,',
  'verification steps, and rollback paths that keep servers safe.',
].join(' ');

const READ_ONLY_NOTE = [
  ' NOTE: the user has enabled read-only mode — only listing/reading tools are',
  'available; commands and writes are disabled. If a task needs changes, ask',
  'the user to disable read-only mode in Settings → Agent Access or do the',
  'change in the Tevada DevOps app itself.',
].join(' ');

function text(value: string, isError = false) {
  return { content: [{ type: 'text' as const, text: value }], isError };
}

/** Result shape every tool handler returns (the SDK's CallToolResult subset). */
type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
};

/** Builds one MCP server instance. Stateless transport = one per request, so
 *  the read-only toggle is read fresh here and applies without a restart. */
export function buildMcpServer(deps: McpDeps): McpServer {
  const readOnly = deps.isReadOnly();
  const server = new McpServer(
    { name: 'tevada-devops', version: '1.0.1' },
    {
      instructions: readOnly
        ? SERVER_INSTRUCTIONS + READ_ONLY_NOTE
        : SERVER_INSTRUCTIONS,
    },
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

  // Write/execute tools are simply not registered in read-only mode, so
  // clients see an accurate tool list instead of runtime refusals.
  const registerWriteTool: typeof registerTool = readOnly
    ? () => {}
    : registerTool;

  /** The in-app agent's catastrophic-command seatbelt asks the user to
   *  confirm; MCP has no approval channel, so a match is a hard reject. */
  const guardMessage = (reason?: string) =>
    `Blocked by the Tevada DevOps safety guard: ${reason ?? 'catastrophic command.'} ` +
    'This MCP endpoint has no interactive approval flow, so commands the in-app agent ' +
    'would ask a human to confirm are rejected here. If this is genuinely intended, ' +
    'ask the user to run it themselves in the Tevada DevOps app (its chat has an approval flow).';

  /** Accepts a server id OR (case-insensitive) name, so agents can say
   *  "run this on staging" without a lookup round-trip. */
  const resolveServer = (ref: string): ServerProfile | undefined => {
    const servers = deps.listServers();
    return (
      servers.find((s) => s.id === ref) ??
      servers.find((s) => s.name.toLowerCase() === ref.toLowerCase())
    );
  };

  /** Connect on demand; returns an error string instead of throwing. */
  const ensureConnected = async (
    profile: ServerProfile,
  ): Promise<string | undefined> => {
    if (deps.getStatus(profile.id) === 'connected') return undefined;
    const conn = await deps.connect(profile.id);
    return conn.ok
      ? undefined
      : `Could not connect to "${profile.name}": ${conn.error ?? 'unknown error'}`;
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

  registerWriteTool(
    'run_command',
    {
      title: 'Run command',
      description:
        'Run a shell command on one of the servers over SSH (connects automatically). Returns stdout, stderr, and the exit code. Prefer run_script for anything multi-line or with complex quoting.',
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
      const cat = isCatastrophic(command);
      if (cat.blocked) return text(guardMessage(cat.reason), true);
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
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

  registerWriteTool(
    'run_script',
    {
      title: 'Run script',
      description:
        'Upload a multi-line bash script to a server and execute it, returning stdout, stderr, and the exit code. Prefer this over run_command for anything with heredocs, complex quoting, loops, or more than ~3 chained commands. The script runs with `set -euo pipefail` prepended, so it stops at the first failing line.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
        script: z.string().describe('The bash script body (no shebang needed).'),
        sudo: z
          .boolean()
          .optional()
          .describe('Run the script as root (default false).'),
        timeoutSeconds: z
          .number()
          .optional()
          .describe(
            `Seconds before the script is aborted (default ${DEFAULT_COMMAND_TIMEOUT_S}, max ${MAX_COMMAND_TIMEOUT_S}).`,
          ),
      },
    },
    async (args: unknown) => {
      const { server: ref, script, sudo, timeoutSeconds } = args as {
        server: string;
        script: string;
        sudo?: boolean;
        timeoutSeconds?: number;
      };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const cat = isCatastrophic(script);
      if (cat.blocked) return text(guardMessage(cat.reason), true);
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      const timeoutMs =
        Math.min(
          Math.max(timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_S, 1),
          MAX_COMMAND_TIMEOUT_S,
        ) * 1000;
      const remotePath = `/tmp/easyhost-mcp-script-${Date.now()}-${script.length}.sh`;
      try {
        await deps.sftpWriteFile(
          profile.id,
          remotePath,
          `set -euo pipefail\n${script}\n`,
        );
        const runner = sudo ? 'sudo bash' : 'bash';
        const result = await deps.exec(
          profile.id,
          `${runner} ${remotePath}; rc=$?; rm -f ${remotePath}; exit $rc`,
          { timeoutMs },
        );
        const parts = [
          `exit code: ${result.exitCode ?? 'unknown'}${result.timedOut ? ' (timed out)' : ''}${result.truncated ? ' (output truncated)' : ''}`,
        ];
        if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr}`);
        return text(parts.join('\n\n'), (result.exitCode ?? 1) !== 0);
      } catch (err) {
        return text(
          `Script failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      } finally {
        // The in-band `rm -f` only runs when the exec completes; on timeout or
        // a dropped connection the staged script would leak under /tmp.
        void deps
          .exec(profile.id, `rm -f ${remotePath}`, { timeoutMs: 5000 })
          .catch((): void => {});
      }
    },
  );

  registerTool(
    'read_file',
    {
      title: 'Read file',
      description:
        'Read the contents of a text file on a server over SFTP (connects automatically). Prefer this over `cat` via run_command — it is reliable for large files and returns a clean truncation marker. For root-only files, fall back to run_command with sudo cat.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
        path: z.string().describe('Absolute file path.'),
        maxBytes: z
          .number()
          .optional()
          .describe(
            `Read at most this many bytes (default ${DEFAULT_READ_BYTES}, max ${MAX_READ_BYTES}).`,
          ),
      },
    },
    async (args: unknown) => {
      const { server: ref, path, maxBytes } = args as {
        server: string;
        path: string;
        maxBytes?: number;
      };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      const cap = Math.min(Math.max(maxBytes ?? DEFAULT_READ_BYTES, 1), MAX_READ_BYTES);
      try {
        const { content, truncated } = await deps.sftpReadFile(
          profile.id,
          path,
          cap,
        );
        return text(
          truncated
            ? `${content}\n…[truncated at ${cap} bytes — pass a larger maxBytes to read more]`
            : content,
        );
      } catch (err) {
        return text(
          `Read failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }
    },
  );

  registerTool(
    'list_directory',
    {
      title: 'List directory',
      description:
        'List a directory on a server over SFTP (connects automatically). Returns name, type, size, mtime, and permissions for each entry — more reliable than parsing `ls` output.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
        path: z
          .string()
          .describe('Absolute directory path (or "." for the login home).'),
      },
    },
    async (args: unknown) => {
      const { server: ref, path } = args as { server: string; path: string };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      try {
        const { path: resolved, entries } = await deps.sftpList(
          profile.id,
          path,
        );
        const rows = entries.map((e) => ({
          name: e.name,
          type: e.type,
          size: e.size,
          mtime: new Date(e.mtime).toISOString(),
          mode: (e.mode & 0o7777).toString(8).padStart(3, '0'),
        }));
        return text(JSON.stringify({ path: resolved, entries: rows }, null, 2));
      } catch (err) {
        return text(
          `List failed: ${err instanceof Error ? err.message : String(err)}`,
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

  registerTool(
    'get_artifacts',
    {
      title: 'Get artifacts',
      description:
        "Scan a server for what is deployed and running — websites, Docker containers, databases, systemd services, and scheduled backups — with status, ports, and whether each port is reachable from outside the server. Call this before exploratory shell commands: it answers \"what's on this box?\" in one call.",
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
      },
    },
    async (args: unknown) => {
      const { server: ref } = args as { server: string };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      const res = await deps.scanArtifacts(profile.id);
      if (res.ok === false) return text(`Scan failed: ${res.error}`, true);
      return text(JSON.stringify(res.artifacts, null, 2));
    },
  );

  registerTool(
    'list_deploys',
    {
      title: 'List deploys',
      description:
        'List the automated deployments registered on a server (GitHub auto-deploys set up through this app): app name, repo, branch, checkout dir, port, redeploy script, env file, plus recent deploy events (ok/failed/rollback, newest first). Use the returned `log` path with get_deploy_log to read build output.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
      },
    },
    async (args: unknown) => {
      const { server: ref } = args as { server: string };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      const res = await deps.listDeployments(profile.id);
      if (res.ok === false) return text(`Listing failed: ${res.error}`, true);
      if (res.deployments.length === 0) {
        return text(
          'No automated deployments are registered on this server (the github-auto-deploy skill registers them under /etc/easyhost/deploys/).',
        );
      }
      return text(JSON.stringify(res.deployments, null, 2));
    },
  );

  registerTool(
    'get_deploy_log',
    {
      title: 'Get deploy log',
      description:
        'Read the build/deploy log of an automated deployment (the `log` path from list_deploys). Use this to debug a failed deploy.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
        logPath: z
          .string()
          .describe('The deploy log path, from list_deploys (`log` field).'),
      },
    },
    async (args: unknown) => {
      const { server: ref, logPath } = args as {
        server: string;
        logPath: string;
      };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      const res = await deps.readDeployLog(profile.id, logPath);
      if (res.ok === false) return text(`Read failed: ${res.error}`, true);
      return text(res.content || '(log is empty)');
    },
  );

  registerTool(
    'get_alerts',
    {
      title: 'Get alerts',
      description:
        "Currently-firing incidents from the app's background alert engine (server unreachable, high CPU/memory/disk/load). Call this when the user asks why they were alerted, or to check fleet health before/after a change. Empty incidents = nothing firing right now.",
      inputSchema: {},
    },
    () => {
      const info = deps.getAlertsInfo();
      if (!info.configured) {
        return text(
          'Alerting is not configured — the user can connect Telegram under Settings → Alerts in the Tevada DevOps app. No incident state is tracked until then.',
        );
      }
      const servers = deps.listServers();
      const incidents = info.incidents.map((i) => ({
        server: servers.find((s) => s.id === i.serverId)?.name ?? i.serverId,
        metric: i.metric,
        state: 'firing' as const,
        since: i.firedAt > 0 ? new Date(i.firedAt).toISOString() : undefined,
      }));
      return text(JSON.stringify({ incidents }, null, 2));
    },
  );

  registerTool(
    'list_skills',
    {
      title: 'List skills',
      description:
        "List the DevOps skills available (the same library the app's built-in agent uses): name, one-line description, and whether it is bundled or user-authored. Call load_skill before doing work a skill covers.",
      inputSchema: {},
    },
    () => {
      const rows = deps.listSkills().map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
      }));
      return text(JSON.stringify(rows, null, 2));
    },
  );

  registerTool(
    'load_skill',
    {
      title: 'Load skill',
      description:
        'Load the full step-by-step instructions for a skill before doing work it covers. The instructions encode hard-won details (non-interactive flags, security defaults, verification steps, rollback paths) — follow them.',
      inputSchema: {
        name: z.string().describe('The skill name, exactly as in list_skills.'),
      },
    },
    (args: unknown) => {
      const { name } = args as { name: string };
      const skills = deps.listSkills();
      const found = skills.find((s) => s.name === name.trim());
      if (!found) {
        return text(
          `Unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(', ')}`,
          true,
        );
      }
      // Skills are written for the in-app agent, whose tools have different
      // names (and a few that don't exist over MCP) — translate up front so
      // external agents don't stall looking for `runCommand`.
      const mapping = [
        'Note — this skill was written for the app\'s built-in agent; in this MCP context map its tool names as follows:',
        '- runCommand → run_command; runScript → run_script; readRemoteFile → read_file; writeRemoteFile → write_file; listGithubRepos → list_github_repos; setupDeployNotifications → setup_deploy_notifications.',
        '- generatePassword → generate one yourself (e.g. `openssl rand -base64 24` via run_command) and avoid echoing secrets into shell history.',
        '- updateTodos and request…Setup form tools → not available here; track your own plan and ask the user for those values in your own conversation.',
        '',
      ].join('\n');
      return text(mapping + found.body);
    },
  );

  registerTool(
    'list_github_repos',
    {
      title: 'List GitHub repos',
      description:
        'List the GitHub repositories the user connected to the Tevada DevOps app (full name, default branch, private flag), plus authorizedServerIds — the servers whose git credential store already holds the user\'s GitHub token, so git clone/pull/push for these repos just works there. If a repo the user wants is MISSING from the list, the connected account cannot reach it (cloning would fail with a misleading 403 "Write access to repository not granted") — tell the user to grant access in the app under Settings → GitHub instead of working around it with deploy keys or pasted tokens.',
      inputSchema: {},
    },
    async () => {
      const res = await deps.listGithubRepos();
      if (res.ok === false) {
        return text(
          `GitHub is not available: ${res.error}. The user can connect it in the app under Settings → GitHub.`,
          true,
        );
      }
      return text(
        JSON.stringify(
          {
            authorizedServerIds: deps.githubAuthorizedServerIds(),
            repos: res.repos.slice(0, 100).map((r) => ({
              fullName: r.fullName,
              private: r.private,
              defaultBranch: r.defaultBranch,
              description: r.description,
            })),
          },
          null,
          2,
        ),
      );
    },
  );

  registerWriteTool(
    'setup_deploy_notifications',
    {
      title: 'Set up deploy notifications',
      description:
        'Install the Tevada DevOps deploy-notification helper (/usr/local/bin/easyhost-notify) on a server. Call this once while setting up any automated deployment (e.g. GitHub auto-deploy). The helper records deploy events for the app\'s Deploys tab and, when the user has connected Telegram in the app, also messages them on deploy success/failure — the bot token is provisioned by the app itself and never passes through you. Afterwards make the deploy script report transitions: /usr/local/bin/easyhost-notify "<app>" ok|failed|rollback "<short message>". If the result has telegramConfigured=false, deploy history still works — tell the user to connect Telegram under Settings → Alerts for push notifications.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
      },
    },
    async (args: unknown) => {
      const { server: ref } = args as { server: string };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      const res = await deps.setupDeployNotifications(profile.id);
      if (!res.ok) {
        return text(`Install failed: ${res.error ?? 'unknown error'}`, true);
      }
      return text(JSON.stringify(res, null, 2));
    },
  );

  registerWriteTool(
    'write_file',
    {
      title: 'Write file',
      description:
        'Write text content to a file on a server over SFTP (connects automatically). Set sudo=true to write a root-owned file (content is staged in /tmp then moved with sudo). Prefer this over heredocs in run_command for scripts and config files.',
      inputSchema: {
        server: z.string().describe('Server id or name (see list_servers).'),
        path: z.string().describe('Absolute destination path.'),
        content: z.string().describe('Full file content to write.'),
        mode: z
          .string()
          .optional()
          .describe('Optional octal mode, e.g. "644" or "755".'),
        sudo: z
          .boolean()
          .optional()
          .describe('Write as root via a staged sudo move (default false).'),
      },
    },
    async (args: unknown) => {
      const { server: ref, path, content, mode, sudo } = args as {
        server: string;
        path: string;
        content: string;
        mode?: string;
        sudo?: boolean;
      };
      const profile = resolveServer(ref);
      if (!profile) {
        return text(
          `Unknown server "${ref}". Call list_servers to see available servers.`,
          true,
        );
      }
      const connError = await ensureConnected(profile);
      if (connError) return text(connError, true);
      if (mode && !/^[0-7]{3,4}$/.test(mode)) {
        return text(`Invalid mode "${mode}" — use octal like 644 or 755.`, true);
      }
      const dest = path.replace(/'/g, '');
      let stagedTmp: string | undefined;
      try {
        if (sudo) {
          const tmp = `/tmp/easyhost-mcp-${Date.now()}-${content.length}`;
          stagedTmp = tmp;
          await deps.sftpWriteFile(profile.id, tmp, content);
          const chmod = mode ? `sudo chmod ${mode} '${dest}'; ` : '';
          const res = await deps.exec(
            profile.id,
            `sudo mv '${tmp}' '${dest}'; ${chmod}echo done`,
            { timeoutMs: 30_000 },
          );
          if (res.exitCode !== 0) {
            return text(`Write failed: ${res.stderr || res.stdout}`, true);
          }
        } else {
          await deps.sftpWriteFile(profile.id, dest, content);
          if (mode) {
            await deps.exec(profile.id, `chmod ${mode} '${dest}'`, {
              timeoutMs: 10_000,
            });
          }
        }
        return text(`Wrote ${content.length} bytes to ${dest}`);
      } catch (err) {
        return text(
          `Write failed: ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      } finally {
        // If a sudo write failed after staging, don't leave the (possibly
        // sensitive) content sitting in /tmp.
        if (stagedTmp) {
          void deps
            .exec(profile.id, `rm -f '${stagedTmp}'`, { timeoutMs: 5000 })
            .catch((): void => {});
        }
      }
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
    /** The per-install bearer token every request must present. `null` only
     *  when token storage failed entirely — the endpoint then refuses all
     *  requests rather than running open. */
    private readonly getToken: () => string | null,
    private readonly onStatusChange: (status: McpStatus) => void = () => {},
  ) {}

  status(): McpStatus {
    return {
      running: this.http !== null,
      port: this.port,
      url: this.http ? `http://127.0.0.1:${this.port}/mcp` : null,
      token: this.getToken(),
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
        // Bearer auth: localhost binding keeps other MACHINES out; the token
        // keeps other local PROCESSES out. Constant shape either way — a 401
        // never reveals whether the path or the token was the problem.
        const token = this.getToken();
        if (!token || req.headers.authorization !== `Bearer ${token}`) {
          res
            .writeHead(401, { 'content-type': 'application/json' })
            .end(
              JSON.stringify({
                error:
                  'Unauthorized: pass the auth token from Tevada DevOps Settings → Agent Access as "Authorization: Bearer <token>".',
              }),
            );
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
