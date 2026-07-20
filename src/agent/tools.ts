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
  AgentFormSpec,
  DatabaseCredentialMeta,
  GithubReposResult,
  SaveDatabaseCredentialRequest,
  ServerStats,
  ServerWithStatus,
} from '../shared/ipc-types';
import {
  buildDatabaseBackupForm,
  buildDomainForm,
  buildS3StorageForm,
} from './forms';
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

/** The slice of ConnectionManager the tools actually use. main/ipc.ts can pass
 *  the real manager, or a router that sends the "This Mac" target to the local
 *  runtime (local-runtime.ts) and everything else over SSH. */
export type AgentRuntime = Pick<
  ConnectionManager,
  'exec' | 'sftpWriteFile' | 'sftpReadFile'
>;

export type AgentToolContext = {
  cm: AgentRuntime;
  approvalMode: boolean;
  /** Task-list planning (settings.aiPlanning). false removes updateTodos. */
  planning?: boolean;
  /**
   * The run's cancellation signal. Threaded into every remote exec so that
   * hitting Stop closes the in-flight command's SSH channel instead of leaving
   * it running to completion on the server. Set by startAgentRun.
   */
  abortSignal?: AbortSignal;
  /**
   * When set, the run is hard-scoped to a project: the agent may only see and
   * operate on these servers. Every server-targeting tool rejects an id outside
   * this set. Undefined = unscoped (full access, e.g. a chat with no project).
   */
  allowedServerIds?: Set<string>;
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
  /** Render an interactive form in the chat and wait for the user to fill it
   *  in. Resolves with their values (keyed by field.key), or null if they
   *  cancelled. The `formId` on the spec is assigned by main. */
  requestForm: (
    spec: Omit<AgentFormSpec, 'formId'>,
  ) => Promise<Record<string, string> | null>;
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
  /** Writes S3 credentials from the storage form straight to a root-only env
   *  file on the server (main → server), so the access keys never enter the
   *  model context / the AI provider. Returns only the env file path. Mirrors
   *  setupDeployNotifications' handling of the Telegram token. */
  writeS3Credentials: (input: {
    serverId: string;
    purpose: 'image-uploads' | 'backups';
    values: Record<string, string>;
  }) => Promise<{ ok: boolean; envPath?: string; error?: string }>;
};

export function buildTools(ctx: AgentToolContext) {
  // Hard project scope: reject any serverId outside the allowed set so the
  // agent physically cannot touch out-of-project servers, even if it guesses an
  // id listServers never showed it.
  const ensureAllowed = (serverId: string) => {
    if (ctx.allowedServerIds && !ctx.allowedServerIds.has(serverId)) {
      throw new Error(
        `Server "${serverId}" is outside this chat's project scope. This chat is limited to its project's servers — call listServers to see which servers you may use.`,
      );
    }
  };
  const tools = {
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
        ensureAllowed(serverId);
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
        ensureAllowed(serverId);
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
            signal: ctx.abortSignal,
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
        ensureAllowed(serverId);
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
            {
              timeoutMs: timeoutSec * 1000,
              maxOutputBytes: MAX_TOOL_RESULT,
              signal: ctx.abortSignal,
            },
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
        } finally {
          // Safety net: the in-band `rm -f` above only runs if the exec
          // completes. On timeout, abort, or a dropped connection the staging
          // script leaks under /tmp — clean it up out of band. Fire-and-forget
          // (no signal, short timeout) so it neither blocks the tool return nor
          // gets cancelled by the same Stop that aborted the run.
          void ctx.cm
            .exec(serverId, `rm -f ${remotePath}`, { timeoutMs: 5000 })
            .catch((): void => {});
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
        ensureAllowed(serverId);
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
        ensureAllowed(serverId);
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
        ensureAllowed(serverId);
        // Staged path for the sudo branch; cleaned up in finally so a failed
        // `sudo mv` doesn't leave the (possibly sensitive) content under /tmp.
        let stagedTmp: string | undefined;
        try {
          if (sudo) {
            const tmp = `/tmp/easyhost-${Date.now()}-${Math.floor(
              content.length,
            )}`;
            stagedTmp = tmp;
            await ctx.cm.sftpWriteFile(serverId, tmp, content);
            const chmod = mode ? `sudo chmod ${mode} ${path}; ` : '';
            const res = await ctx.cm.exec(
              serverId,
              `sudo mv ${tmp} ${path}; ${chmod}echo done`,
              { timeoutMs: 30000, signal: ctx.abortSignal },
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
        } finally {
          // If a sudo write failed or was aborted after staging, the raw
          // content is still sitting in /tmp. Best-effort remove it out of band.
          if (stagedTmp) {
            void ctx.cm
              .exec(serverId, `rm -f ${stagedTmp}`, { timeoutMs: 5000 })
              .catch((): void => {});
          }
        }
      },
    }),

    listGithubRepos: tool({
      description:
        'List the GitHub repositories the user connected to this app (full name, default branch, private flag). Use when the user says "my repo" / wants to deploy from GitHub, to resolve the exact owner/repo name and confirm access. Servers in authorizedServerIds can already run git clone/pull/push for these repos (credentials pre-installed); if the target server is not in that list, ask the user to enable it under Settings → GitHub instead of handling tokens in shell commands. If the repo the user wants is MISSING from this list, the connected account cannot reach it (common for organization-owned repos) and cloning will fail with a misleading 403 "Write access to repository not granted" — do not work around it with deploy keys or pasted tokens; tell the user to grant access under Settings → GitHub, then call this tool again to confirm before cloning.',
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
        ensureAllowed(serverId);
        const conn = await ctx.connect(serverId);
        if (!conn.ok) return { ok: false, error: conn.error ?? 'connect failed' };
        return ctx.setupDeployNotifications(serverId);
      },
    }),

    requestDomainSetup: tool({
      description:
        "Show the user an interactive form to configure a custom domain for a deployed service, then return the values they enter. Call this FIRST whenever the user wants to point a domain / custom URL at an app or service — do NOT ask for the domain, port, HTTPS preference, or email in plain text; this on-screen form collects them all at once and is far easier for a non-expert than typing answers. IMPORTANT: figure out the port yourself FIRST (`docker ps` / `ss -tlnp` — you deployed it, so you know where it listens) and ALWAYS pass it as `suggestedPort` — the user should never have to know or type the port; the form shows them the port you detected, pre-filled. Also pass `appName`. It's good practice to first tell the user, in one line, which server IP their DNS A-record should point at (from listServers). After the user submits, use the returned values with the setup-domain skill to configure the reverse proxy and TLS. If the user cancels, ask how they'd like to proceed instead.",
      inputSchema: z.object({
        appName: z
          .string()
          .optional()
          .describe('The app/service the domain is for — shown in the form title.'),
        suggestedPort: z
          .number()
          .optional()
          .describe(
            'REQUIRED in practice: the local port you detected the service listening on. Pre-filled in the form and shown to the user as the detected port — always provide it so they don’t have to.',
          ),
        serverIp: z
          .string()
          .optional()
          .describe(
            "This server's public IP (from listServers, or `curl -4 -s ifconfig.me`). Shown in the form's built-in DNS guide as the exact A-record value the user must add at their registrar. Always provide it.",
          ),
      }),
      execute: async ({ appName, suggestedPort, serverIp }) => {
        const values = await ctx.requestForm(
          buildDomainForm({ appName, suggestedPort, serverIp }),
        );
        if (!values) {
          return {
            submitted: false,
            note: 'The user cancelled the domain setup form. Ask how they want to proceed.',
          };
        }
        return { submitted: true, values };
      },
    }),

    requestDatabaseBackupSetup: tool({
      description:
        "Show the user an interactive form to configure automatic database backups (engine, database, schedule, retention, optional off-site S3 copy), then return the values they enter. Call this FIRST whenever the user wants to back up / protect / schedule dumps of a database — do NOT ask for the schedule or retention in plain text. IMPORTANT: detect the database yourself FIRST (`docker ps`, `ss -tlnp`) and pass it as `detectedEngine` so the form is pre-filled — the user should never have to identify their own database engine. After the user submits, load the setup-database-backup skill and follow it with the returned values. If `offsite` comes back 'true', you will additionally call requestS3StorageSetup (purpose 'backups') as that skill directs. If the user cancels, ask how they'd like to proceed instead.",
      inputSchema: z.object({
        detectedEngine: z
          .enum(['postgresql', 'mysql', 'mariadb', 'mongodb', 'redis'])
          .optional()
          .describe(
            'REQUIRED in practice: the database engine you detected running on the server. Pre-selects the form field so the user doesn’t have to know it.',
          ),
        suggestedDatabase: z
          .string()
          .optional()
          .describe(
            'A specific database name you detected (e.g. from the app you deployed). Leave unset to default to backing up all databases.',
          ),
      }),
      execute: async ({ detectedEngine, suggestedDatabase }) => {
        const values = await ctx.requestForm(
          buildDatabaseBackupForm({ detectedEngine, suggestedDatabase }),
        );
        if (!values) {
          return {
            submitted: false,
            note: 'The user cancelled the backup setup form. Ask how they want to proceed.',
          };
        }
        return { submitted: true, values };
      },
    }),

    requestS3StorageSetup: tool({
      description:
        "Show the user an interactive form to connect an S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, MinIO) — provider, bucket, region, endpoint, and access keys. Call this FIRST whenever the user wants object storage: image/file uploads for an app (purpose 'image-uploads') or off-site backup copies (purpose 'backups'). NEVER ask for access keys in plain chat — this form collects them with the secret masked. SECURITY: the tool writes the access keys straight to a root-only env file ON THE SERVER itself and returns you only its path (`envPath`) plus the non-secret values (bucket, region, endpoint) — you never receive the secret, so you cannot leak it. To use the keys, `source` the env file inside a runScript (see the setup-s3-storage skill); never re-collect, echo, or write the keys yourself. Requires `serverId`. If the user cancels, ask how they'd like to proceed instead.",
      inputSchema: z.object({
        serverId: z
          .string()
          .describe(
            'The server the storage is set up on (from listServers). Required — the tool writes the credentials env file here.',
          ),
        purpose: z
          .enum(['image-uploads', 'backups'])
          .describe(
            "'image-uploads' when an app will store uploaded images/files in the bucket; 'backups' when database backups will be copied there.",
          ),
        appName: z
          .string()
          .optional()
          .describe(
            'For image-uploads: the app the storage is for — shown in the form title.',
          ),
      }),
      execute: async ({ serverId, purpose, appName }) => {
        ensureAllowed(serverId);
        const values = await ctx.requestForm(
          buildS3StorageForm({ purpose, appName }),
        );
        if (!values) {
          return {
            submitted: false,
            note: 'The user cancelled the storage setup form. Ask how they want to proceed.',
          };
        }
        // main writes the keys directly to a root-only file on the server; the
        // secret never round-trips through the model / the AI provider.
        const stored = await ctx.writeS3Credentials({ serverId, purpose, values });
        if (!stored.ok) {
          return {
            submitted: true,
            secretStored: false,
            error: stored.error ?? 'Failed to write the credentials file.',
            note: 'The form was submitted but writing the credentials file failed. Diagnose (is the server connected? sudo available?) and retry, or ask the user how to proceed.',
          };
        }
        // Return ONLY non-secret fields — the access keys live in envPath.
        const nonSecret: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) {
          if (k !== 'accessKeyId' && k !== 'secretAccessKey') nonSecret[k] = v;
        }
        return {
          submitted: true,
          secretStored: true,
          envPath: stored.envPath,
          values: nonSecret,
        };
      },
    }),

    updateTodos: tool({
      description:
        "Maintain a visible task checklist for a multi-step job — the user watches it to see what is done and what is left. Call this at the START of any task that takes more than ~3 steps (a deploy, a security audit, hardening, a migration) to lay out the plan, then call it again EVERY time a step's status changes. Rules: pass the ENTIRE list every time — this tool REPLACES the previous list, so an item you leave out is DELETED; keep EXACTLY ONE item 'in_progress' at a time; mark an item 'completed' the moment it's done before starting the next; keep item text short and action-oriented (\"Install nginx\", \"Configure TLS\"). If the conversation already has a task list (shown to you as 'Current task list'), carry ALL of those items forward with their existing statuses and continue from the first unfinished one — never restart or drop earlier tasks. Skip this tool for simple one-or-two-step requests — a checklist there is just noise.",
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
        ensureAllowed(serverId);
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
  // Planning off: the checklist tool doesn't exist at all — its schema and
  // description never enter the request, and the model can't call it.
  if (ctx.planning === false) {
    const { updateTodos: _omitted, ...withoutTodos } = tools;
    return withoutTodos as typeof tools;
  }
  return tools;
}

export type AgentTools = ReturnType<typeof buildTools>;
