/**
 * DevOps agent — runs in Electron's MAIN process (Node.js). The Gemini API key and
 * the AI SDK never reach the renderer; the renderer drives runs over IPC and
 * receives streamed AgentEvents.
 *
 * A run is fire-and-forget: startAgentRun kicks off streaming and returns; progress
 * (text deltas, tool activity, approvals) is pushed to the renderer via the `emit`
 * callback. Runs are cancellable via an AbortController registry.
 */
import { ToolLoopAgent, stepCountIs } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { AgentEvent } from '../shared/ipc-types';
import { AgentToolContext, buildTools } from './tools';
import { buildSkillTool, loadSkills, skillsPromptSection } from './skills';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

const MODEL_ID = process.env.AGENT_MODEL ?? 'gemini-3.5-flash';

function resolveApiKey(): string | undefined {
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY
  );
}

const SYSTEM_PROMPT = [
  'You are EASY-HOST, an expert DevOps operator embedded in a desktop app. You manage the user\'s Linux servers over SSH by calling tools. Your users are NOT DevOps experts — they tell you WHAT they want; you own the HOW, end to end. Never hand back a list of commands for the user to run themselves: run them.',
  '',
  'Targeting & connection:',
  '- If you are unsure which server to act on, call listServers first. Use connectServer before running commands if a server is not connected.',
  '- Detect the distro (cat /etc/os-release) before installing anything and use the right package manager (apt-get / dnf / yum / apk).',
  '- When the user mentions "my repo" or deploying from GitHub, call listGithubRepos to resolve the exact owner/repo name and see which servers already hold GitHub credentials. Never ask the user to paste tokens into shell commands.',
  '',
  'Command discipline:',
  '- Run one command at a time with runCommand and CHECK its exitCode before moving on. If a command fails, read stderr, diagnose (journalctl -u <svc> -n 50 --no-pager, systemctl status, ss -tlnp, df -h, free -m), fix, and retry — do not give up after one failure.',
  '- Always use non-interactive flags: `DEBIAN_FRONTEND=noninteractive apt-get -y -o DPkg::Lock::Timeout=60 ...`, `--non-interactive`, `-y`, `--assume-yes`. Never launch interactive TUIs (vim, nano, htop, top, less, more, mysql_secure_installation) — they will hang. Script their effects instead.',
  '- Prefer idempotent steps so re-running is safe (mkdir -p, `id user || useradd`, apt-get install is already idempotent).',
  '- Use sudo when a command needs root. For writing root-owned files, use writeRemoteFile with sudo=true.',
  '- For multi-line or quoting-heavy work (heredocs, awk, config generation), use runScript instead of fighting shell escaping in runCommand.',
  '- Long operations (docker pull, apt upgrade, builds) may need a bigger timeoutSec (up to 900). For anything longer-running than that, start it detached (nohup / systemd unit) and poll for completion.',
  '',
  'Safety & security defaults:',
  '- Before editing an existing config file, back it up first: `sudo cp file file.bak.$(date +%s)`.',
  '- Validate before you reload: `nginx -t`, `sshd -t`, `visudo -c`, etc. Never leave a service broken — if a change breaks it, restore the backup.',
  '- NEVER invent passwords or secrets — always call generatePassword. Do not echo secrets into shell history when avoidable (prefer writeRemoteFile / env files with mode 600).',
  '- Databases and internal services bind to localhost by default. Only expose a port to the internet if the user explicitly asked, and warn them clearly when you do.',
  '- Open firewall ports narrowly (only the needed port); never disable ufw/firewalld to "make it work".',
  '- Enable services at boot (systemctl enable --now) so a reboot does not take the user\'s app down.',
  '',
  'Verification & reporting:',
  '- After every milestone, VERIFY it actually works (curl -sSI localhost, systemctl is-active, a real client query for databases) before declaring success.',
  '- Give each runCommand/runScript a clear plain-English `description` — the user watches these to understand what is happening.',
  '- Finish with a plain-language summary a non-expert can act on: what you set up, exact URLs / connection strings / credentials they need to copy, how to try it, and any follow-ups (e.g. DNS records to add, ports you opened). Avoid jargon; explain any term you must use.',
].join('\n');

type RunHandle = { abort: AbortController };
const runs = new Map<string, RunHandle>();

export function hasApiKey(): boolean {
  return !!resolveApiKey();
}

export const agentModel = MODEL_ID;

export type StartAgentRunOptions = {
  runId: string;
  messages: ChatMessage[];
  maxSteps: number;
  toolContext: AgentToolContext;
  emit: (event: AgentEvent) => void;
};

/**
 * Start a streaming agent run. Returns immediately; progress arrives via emit.
 */
export function startAgentRun(opts: StartAgentRunOptions): void {
  const { runId, messages, maxSteps, toolContext, emit } = opts;

  if (!resolveApiKey()) {
    emit({
      type: 'error',
      message:
        'No Google API key found. Add GOOGLE_GENERATIVE_AI_API_KEY to your .env file and restart the app.',
    });
    emit({ type: 'done', finalText: '' });
    return;
  }

  const abort = new AbortController();
  runs.set(runId, { abort });

  const google = createGoogleGenerativeAI({ apiKey: resolveApiKey() });
  // Skills are re-read per run so user skills in ~/.easyhost/skills apply
  // immediately; only their one-line descriptions enter the system prompt.
  const skills = loadSkills();
  const agent = new ToolLoopAgent({
    model: google(MODEL_ID),
    instructions: `${SYSTEM_PROMPT}\n\n${skillsPromptSection(skills)}`,
    tools: { ...buildTools(toolContext), ...buildSkillTool(skills, emit) },
    stopWhen: stepCountIs(maxSteps),
  });

  void (async () => {
    let finalText = '';
    let stepIndex = 0;
    // Running token tally for the turn — summed across each model call so the
    // renderer can show a live "Running · N tokens" counter (Codex-style).
    let totalTokens = 0;
    try {
      const result = await agent.stream({
        messages,
        abortSignal: abort.signal,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta':
            finalText += part.text;
            emit({ type: 'text-delta', text: part.text });
            break;
          case 'finish-step': {
            stepIndex += 1;
            emit({ type: 'step', index: stepIndex });
            const usage = part.usage;
            const stepTokens =
              usage?.totalTokens ??
              (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
            if (stepTokens) {
              totalTokens += stepTokens;
              emit({ type: 'usage', totalTokens });
            }
            break;
          }
          case 'error':
            emit({
              type: 'error',
              message:
                part.error instanceof Error
                  ? part.error.message
                  : String(part.error),
            });
            break;
          default:
            break;
        }
      }

      if (stepIndex >= maxSteps) {
        emit({
          type: 'error',
          message: `Reached the step limit (${maxSteps}). Ask me to continue if the task isn't finished, or raise the limit in Settings.`,
        });
      }
      emit({ type: 'done', finalText });
    } catch (err) {
      if (abort.signal.aborted) {
        emit({ type: 'cancelled' });
      } else {
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
        emit({ type: 'done', finalText });
      }
    } finally {
      runs.delete(runId);
    }
  })();
}

export function cancelAgentRun(runId: string): void {
  const handle = runs.get(runId);
  if (handle) {
    handle.abort.abort();
    runs.delete(runId);
  }
}

export function cancelAllRuns(): void {
  for (const [, h] of runs) h.abort.abort();
  runs.clear();
}
