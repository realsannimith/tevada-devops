/**
 * Agent tools for operating on remote servers over SSH. Built fresh per run so
 * each tool closes over that run's event emitter and approval callback.
 *
 * Gemini function-calling constraints drive the design: schemas are kept flat
 * (string/number/boolean/enum only — no unions or nested optional objects), the
 * tool set is small (<= 8), and every tool result is hard-truncated so a chatty
 * command can't blow the context window and send the loop degenerate.
 */
import { tool } from 'ai';
import { z } from 'zod';
import { ConnectionManager } from '../main/connection-manager';
import { AgentEvent, ServerStats, ServerWithStatus } from '../shared/ipc-types';
import { isCatastrophic } from './blacklist';

const MAX_TOOL_RESULT = 16 * 1024;

function truncate(s: string, max = MAX_TOOL_RESULT): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[truncated ${s.length - max} bytes]`;
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
          .max(300)
          .default(60)
          .describe('Kill the command after this many seconds.'),
        description: z
          .string()
          .describe('A short human-readable summary shown in the activity feed.'),
      }),
      execute: async ({ serverId, command, timeoutSec, description }) => {
        const toolCallId = `cmd_${serverId}_${command.length}_${command.slice(0, 8)}`;
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
