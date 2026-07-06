/**
 * Agent tools for operating on remote servers over SSH. Built fresh per run so
 * each tool closes over that run's event emitter and approval callback.
 *
 * Gemini function-calling constraints drive the design: schemas are kept flat
 * (string/number/boolean/enum only — no unions or nested optional objects), the
 * tool set is small (the 8 here plus the `skill` loader from skills.ts), and
 * every tool result is hard-truncated so a chatty command can't blow the
 * context window and send the loop degenerate.
 */
import { randomBytes } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { ConnectionManager } from '../main/connection-manager';
import {
  AgentEvent,
  DatabaseCredentialMeta,
  GithubReposResult,
  SaveDatabaseCredentialRequest,
  ServerStats,
  ServerWithStatus,
} from '../shared/ipc-types';
import { isCatastrophic } from './blacklist';

const MAX_TOOL_RESULT = 16 * 1024;

function truncate(s: string, max = MAX_TOOL_RESULT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`;
}

// Tool-call ids must be unique per invocation: the renderer keys feed cards by
// them and patches the matching card on tool-end, so re-running the same command
// with a content-derived id would corrupt the activity feed.
let toolCallCounter = 0;
export function nextToolCallId(prefix: string): string {
  return `${prefix}_${Date.now()}_${toolCallCounter++}`;
}

export type AgentToolContext = {
  cm: ConnectionManager;
  approvalMode: boolean;
  listServers: () => ServerWithStatus[];
  /** Connect (loading the stored secret in main). */
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  getStats: (serverId: string) => ServerStats | undefined;
  emit: (event: AgentEvent) => void;
  /** Resolves true if the user approves the command. */
  requestApproval: (
    serverId: string,
    command: string,
    reason: string,
  ) => Promise<boolean>;
  /** Persists a database credential (encrypted) so the user can retrieve it
   *  later from the Artifacts tab. Upserts by (serverId, engine, port). */
  saveDatabaseCredential: (
    input: SaveDatabaseCredentialRequest,
  ) => DatabaseCredentialMeta;
  /** Fired every time generatePassword produces a secret. main/ipc.ts uses
   *  this as a safety net for the database wizard: if the model generates
   *  exactly one password but never calls saveDatabaseCredential itself, the
   *  run still gets saved automatically once it finishes. */
  onPasswordGenerated: (password: string) => void;
  /** Repos the connected GitHub account granted this app (github.ts routes:
   *  GitHub App installations vs everything an OAuth/PAT token can see). */
  listGithubRepos: () => Promise<GithubReposResult>;
  /** Servers whose git credential store already holds the user's GitHub token. */
  githubAuthorizedServerIds: () => string[];
  /** Installs /usr/local/bin/easyhost-notify on a server and provisions the
   *  Telegram env file from the app's encrypted alert config (main/deployments.ts).
   *  The bot token flows main → server directly and never enters the model. */
  setupDeployNotifications: (
    serverId: string,
  ) => Promise<{ ok: boolean; telegramConfigured: boolean; error?: string }>;
};

export function buildTools(ctx: AgentToolContext) {
  return {
    listServers: tool({
      description:
        'List all configured servers with their id, name, host, user, and current connection status. Call this first if you are unsure which serverId to target.',
      inputSchema: z.object({}),
      execute: async () => {
        const servers = ctx.listServers().map((s) => ({
          id: s.id,
          name: s.name,
          host: s.host,
          username: s.username,
          status: s.status,
        }));
        return { servers };
      },
    }),

    connectServer: tool({
      description:
        'Ensure an SSH connection to a server is established. Safe to call even if already connected.',
      inputSchema: z.object({
        serverId: z.string().describe('The id of the server to connect to.'),
      }),
      execute: async ({ serverId }) => {
        const res = await ctx.connect(serverId);
        return res.ok
          ? { connected: true }
          : { connected: false, error: res.error ?? 'connect failed' };
      },
    }),

    runCommand: tool({
      description:
        'Run a shell command on a server over SSH and return stdout, stderr and the exit code. Use non-interactive flags (e.g. DEBIAN_FRONTEND=noninteractive apt-get -y). Never launch interactive TUIs (vim, htop, top, less). Always check the exit code before proceeding.',
      inputSchema: z.object({
        serverId: z.string(),
        command: z.string().describe('The exact shell command to run.'),
        timeoutSec: z
          .number()
          .max(900)
          .default(60)
          .describe(
            'Kill the command after this many seconds. Raise it (up to 900) for slow operations like apt upgrades or docker pulls.',
          ),
        description: z
          .string()
          .describe('A short human-readable summary shown in the activity feed.'),
      }),
      execute: async ({ serverId, command, timeoutSec, description }) => {
        const toolCallId = nextToolCallId('cmd');
        ctx.emit({
          type: 'tool-start',
          toolCallId,
          tool: 'runCommand',
          args: { serverId, command },
          description,
        });

        // Seatbelt: catastrophic commands always require confirmation, even in
        // full-auto mode; other commands require confirmation only in approval mode.
        const cat = isCatastrophic(command);
        if (cat.blocked || ctx.approvalMode) {
          const reason = cat.blocked
            ? `Blocked by safety guard: ${cat.reason}`
            : 'Approval mode is on.';
          const approved = await ctx.requestApproval(serverId, command, reason);
          if (!approved) {
            const result = {
              approved: false,
              message: `Command not approved by user (${reason})`,
            };
            ctx.emit({ type: 'tool-end', toolCallId, result });
            return result;
          }
        }

        try {
          const res = await ctx.cm.exec(serverId, command, {
            timeoutMs: timeoutSec * 1000,
            maxOutputBytes: MAX_TOOL_RESULT,
          });
          const result = {
            exitCode: res.exitCode,
            stdout: truncate(res.stdout),
            stderr: truncate(res.stderr),
            truncated: res.truncated,
            timedOut: res.timedOut,
          };
          ctx.emit({ type: 'tool-end', toolCallId, result });
          return result;
        } catch (err) {
          const result = {
            error: err instanceof Error ? err.message : String(err),
          };
          ctx.emit({ type: 'tool-end', toolCallId, result });
          return result;
        }
      },
    }),

    runScript: tool({
      description:
        'Upload a multi-line bash script to a server and execute it, returning stdout, stderr and the exit code. Prefer this over runCommand for anything with heredocs, complex quoting, loops, or more than ~3 chained commands. The script runs with `set -euo pipefail` prepended, so it stops at the first failing line.',
      inputSchema: z.object({
        serverId: z.string(),
        script: z
          .string()
          .describe('The bash script body (no shebang needed).'),
        sudo: z.boolean().default(false).describe('Run the script as root.'),
        timeoutSec: z
          .number()
          .max(900)
          .default(120)
          .describe('Kill the script after this many seconds.'),
        description: z
          .string()
          .describe('A short human-readable summary shown in the activity feed.'),
      }),
      execute: async ({ serverId, script, sudo, timeoutSec, description }) => {
        const toolCallId = nextToolCallId('scr');
        ctx.emit({
          type: 'tool-start',
          toolCallId,
          tool: 'runScript',
          args: { serverId, script, sudo },
          description,
        });

        // Same seatbelt as runCommand — scan the whole script body.
        const cat = isCatastrophic(script);
        if (cat.blocked || ctx.approvalMode) {
          const reason = cat.blocked
            ? `Blocked by safety guard: ${cat.reason}`
            : 'Approval mode is on.';
          const approved = await ctx.requestApproval(serverId, script, reason);
          if (!approved) {
            const result = {
              approved: false,
              message: `Script not approved by user (${reason})`,
            };
            ctx.emit({ type: 'tool-end', toolCallId, result });
            return result;
          }
        }

        const remotePath = `/tmp/easyhost-script-${Date.now()}-${Math.floor(
          Math.random() * 1e6,
        )}.sh`;
        try {
          await ctx.cm.sftpWriteFile(
            serverId,
            remotePath,
            `set -euo pipefail\n${script}\n`,
          );
          const runner = sudo ? 'sudo bash' : 'bash';
          const res = await ctx.cm.exec(
            serverId,
            `${runner} ${remotePath}; rc=$?; rm -f ${remotePath}; exit $rc`,
            { timeoutMs: timeoutSec * 1000, maxOutputBytes: MAX_TOOL_RESULT },
          );
          const result = {
            exitCode: res.exitCode,
            stdout: truncate(res.stdout),
            stderr: truncate(res.stderr),
            truncated: res.truncated,
            timedOut: res.timedOut,
          };
          ctx.emit({ type: 'tool-end', toolCallId, result });
          return result;
        } catch (err) {
          const result = {
            error: err instanceof Error ? err.message : String(err),
          };
          ctx.emit({ type: 'tool-end', toolCallId, result });
          return result;
        }
      },
    }),

    generatePassword: tool({
      description:
        'Generate a cryptographically strong random secret locally (never leaves the app except where you place it). ALWAYS use this for database passwords, API tokens, and any credential you create — never invent a password yourself. Include the returned value in your final summary so the user can save it.',
      inputSchema: z.object({
        length: z
          .number()
          .min(16)
          .max(64)
          .default(24)
          .describe('Length in characters.'),
      }),
      execute: async ({ length }) => {
        // base64url → shell-safe (no quotes, $, spaces or backslashes).
        const password = randomBytes(48).toString('base64url').slice(0, length);
        ctx.onPasswordGenerated(password);
        return { password };
      },
    }),

    saveDatabaseCredential: tool({
      description:
        "Persist a database's connection details (encrypted, via the OS keychain) so the user can retrieve them later from the Artifacts tab instead of scrolling back through chat. ALWAYS call this once, right after you've created/secured a database and verified it works — in ADDITION to (never instead of) including the credentials in your final summary. Only for real databases/caches (Postgres, MySQL, MariaDB, Redis, MongoDB) — never for OS user accounts or SSH.",
      inputSchema: z.object({
        serverId: z.string(),
        engine: z
          .enum(['postgresql', 'mysql', 'mariadb', 'redis', 'mongodb'])
          .describe('The database engine you configured.'),
        host: z
          .string()
          .describe(
            "'127.0.0.1' for a local-only database. If remote access was enabled, pass this server's public host (from listServers) — it's recorded as the external endpoint and the internal 127.0.0.1 one is kept automatically, so both are shown to the user.",
          ),
        port: z.number(),
        database: z
          .string()
          .optional()
          .describe('Database name — omit for Redis.'),
        username: z
          .string()
          .optional()
          .describe('Database user — omit for Redis.'),
        password: z
          .string()
          .describe('The exact password you set (from generatePassword).'),
      }),
      execute: async ({ serverId, engine, host, port, database, username, password }) => {
        try {
          const meta = ctx.saveDatabaseCredential({
            serverId,
            engine,
            host,
            port,
            database,
            username,
            password,
          });
          return { saved: true, credentialId: meta.id };
        } catch (err) {
          return {
            saved: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    readRemoteFile: tool({
      description: 'Read the contents of a file on a server over SFTP.',
      inputSchema: z.object({
        serverId: z.string(),
        path: z.string(),
        maxBytes: z.number().default(32768),
      }),
      execute: async ({ serverId, path, maxBytes }) => {
        try {
          const { content, truncated } = await ctx.cm.sftpReadFile(
            serverId,
            path,
            maxBytes,
          );
          return { content: truncate(content), truncated };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    }),

    writeRemoteFile: tool({
      description:
        'Write text content to a file on a server. Set sudo=true to write a root-owned file (content is staged in /tmp then moved with sudo).',
      inputSchema: z.object({
        serverId: z.string(),
        path: z.string(),
        content: z.string(),
        mode: z.string().optional().describe('Optional octal mode, e.g. "644".'),
        sudo: z.boolean().default(false),
      }),
      execute: async ({ serverId, path, content, mode, sudo }) => {
        try {
          if (sudo) {
            const tmp = `/tmp/easyhost-${Date.now()}-${Math.floor(
              content.length,
            )}`;
            await ctx.cm.sftpWriteFile(serverId, tmp, content);
            const chmod = mode ? `sudo chmod ${mode} ${path}; ` : '';
            const res = await ctx.cm.exec(
              serverId,
              `sudo mv ${tmp} ${path}; ${chmod}echo done`,
              { timeoutMs: 30000 },
            );
            if (res.exitCode !== 0)
              return { ok: false, stderr: truncate(res.stderr) };
          } else {
            await ctx.cm.sftpWriteFile(serverId, path, content);
            if (mode)
              await ctx.cm.exec(serverId, `chmod ${mode} ${path}`, {
                timeoutMs: 10000,
              });
          }
          return { ok: true, path };
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),

    listGithubRepos: tool({
      description:
        'List the GitHub repositories the user connected to this app (full name, default branch, private flag). Use when the user says "my repo" / wants to deploy from GitHub, to resolve the exact owner/repo name and confirm access. Servers in authorizedServerIds can already run git clone/pull/push for these repos (credentials pre-installed); if the target server is not in that list, ask the user to enable it under Settings → GitHub instead of handling tokens in shell commands.',
      inputSchema: z.object({}),
      execute: async () => {
        const res = await ctx.listGithubRepos();
        // `=== false` (not `!res.ok`): narrowing needs the literal check here
        // because strictNullChecks is off in this repo's tsconfig.
        if (res.ok === false) return { connected: false, error: res.error };
        return {
          connected: true,
          authorizedServerIds: ctx.githubAuthorizedServerIds(),
          repos: res.repos.slice(0, 100).map((r) => ({
            fullName: r.fullName,
            private: r.private,
            defaultBranch: r.defaultBranch,
            description: r.description,
          })),
        };
      },
    }),

    setupDeployNotifications: tool({
      description:
        'Install the Tevada DevOps deploy-notification helper (/usr/local/bin/easyhost-notify) on a server. Call this once while setting up any automated deployment (e.g. GitHub auto-deploy). The helper records deploy events to /var/log/easyhost/deploy-events.jsonl (shown in the app\'s Deploys tab) and, when the user has connected Telegram in Settings → Alerts, also sends them a Telegram message on deploy success/failure — the bot token is provisioned by the app itself to a root-only file and never passes through you. After calling it, make the deploy script report transitions: /usr/local/bin/easyhost-notify "<app>" ok|failed|rollback "<short message>". If the result has telegramConfigured=false, deploy history still works — tell the user to connect Telegram under Settings → Alerts to also get push notifications.',
      inputSchema: z.object({
        serverId: z.string().describe('The server the deployment runs on.'),
      }),
      execute: async ({ serverId }) => {
        const conn = await ctx.connect(serverId);
        if (!conn.ok) return { ok: false, error: conn.error ?? 'connect failed' };
        return ctx.setupDeployNotifications(serverId);
      },
    }),

    updateTodos: tool({
      description:
        "Maintain a visible task checklist for a multi-step job — the user watches it to see what is done and what is left. Call this at the START of any task that takes more than ~3 steps (a deploy, a security audit, hardening, a migration) to lay out the plan, then call it again EVERY time a step's status changes. Rules: pass the ENTIRE list every time (it replaces the previous one); keep EXACTLY ONE item 'in_progress' at a time; mark an item 'completed' the moment it's done before starting the next; keep item text short and action-oriented (\"Install nginx\", \"Configure TLS\"). Skip this tool for simple one-or-two-step requests — a checklist there is just noise.",
      inputSchema: z.object({
        todos: z
          .array(
            z.object({
              text: z
                .string()
                .describe('Short imperative task label, e.g. "Install Docker".'),
              status: z
                .enum(['pending', 'in_progress', 'completed'])
                .describe(
                  "'in_progress' for the one step you're doing now, 'completed' when done, 'pending' otherwise.",
                ),
            }),
          )
          .max(40)
          .describe('The complete, ordered task list — replaces the previous one.'),
      }),
      execute: async ({ todos }) => {
        // Drives the transcript's todo card; no tool-start/tool-end so it never
        // shows up as a generic command row.
        ctx.emit({ type: 'todos', todos });
        const completed = todos.filter((t) => t.status === 'completed').length;
        return { ok: true, total: todos.length, completed };
      },
    }),

    getServerStats: tool({
      description:
        'Get the most recent CPU, memory, disk and network stats for a server.',
      inputSchema: z.object({ serverId: z.string() }),
      execute: async ({ serverId }) => {
        const stats = ctx.getStats(serverId);
        if (!stats)
          return {
            available: false,
            hint: 'Open the monitoring view for this server to start collecting stats.',
          };
        return {
          available: true,
          cpuPct: stats.cpuPct,
          memUsedGB: +(stats.mem.usedBytes / 1024 ** 3).toFixed(2),
          memTotalGB: +(stats.mem.totalBytes / 1024 ** 3).toFixed(2),
          disks: stats.disks.map((d) => ({
            mount: d.mount,
            usedGB: +(d.usedBytes / 1024 ** 3).toFixed(1),
            totalGB: +(d.totalBytes / 1024 ** 3).toFixed(1),
          })),
          loadAvg: stats.loadAvg,
          uptimeSec: stats.uptimeSec,
        };
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
