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

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

const MODEL_ID = process.env.AGENT_MODEL ?? 'gemini-3.1-pro';

function resolveApiKey(): string | undefined {
  return (
    process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
    process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_API_KEY
  );
}

const SYSTEM_PROMPT = [
  'You are EASY-HOST, an expert DevOps operator embedded in a desktop app. You manage the user\'s Linux servers over SSH by calling tools.',
  '',
  'Operating rules:',
  '- If you are unsure which server to act on, call listServers first. Use connectServer before running commands if a server is not connected.',
  '- Run one command at a time with runCommand and CHECK its exitCode before moving on. If a command fails, diagnose and adapt.',
  '- Always use non-interactive flags: `DEBIAN_FRONTEND=noninteractive apt-get -y ...`, `--non-interactive`, `-y`, `--assume-yes`. Never launch interactive TUIs (vim, nano, htop, top, less, more) — they will hang. Edit files with writeRemoteFile or non-interactive sed.',
  '- Prefer idempotent steps so re-running is safe. Detect the distro (cat /etc/os-release) before installing packages.',
  '- Use sudo when a command needs root. For writing root-owned files, use writeRemoteFile with sudo=true.',
  '- Keep the user informed: give each runCommand a clear `description`. When the task is complete, end with a concise summary of what you did and any follow-ups (e.g. DNS records the user must set).',
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
  const agent = new ToolLoopAgent({
    model: google(MODEL_ID),
    instructions: SYSTEM_PROMPT,
    tools: buildTools(toolContext),
    stopWhen: stepCountIs(maxSteps),
  });

  void (async () => {
    let finalText = '';
    let stepIndex = 0;
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
          case 'finish-step':
            stepIndex += 1;
            emit({ type: 'step', index: stepIndex });
            break;
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
