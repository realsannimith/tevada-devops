/**
 * DevOps agent — runs in Electron's MAIN process (Node.js). The provider API key
 * and the AI SDK never reach the renderer; the renderer drives runs over IPC and
 * receives streamed AgentEvents.
 *
 * A run is fire-and-forget: startAgentRun kicks off streaming and returns; progress
 * (text deltas, tool activity, approvals) is pushed to the renderer via the `emit`
 * callback. Runs are cancellable via an AbortController registry.
 *
 * This module stays free of Electron imports (it has a vitest suite) — the
 * caller (main/ipc.ts) resolves the provider config + API key and passes it in.
 */
import {
  ToolLoopAgent,
  stepCountIs,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AgentEvent, SteerItem, TodoItem } from '../shared/ipc-types';
import { EffortLevel, providerLabel, ProviderId } from '../shared/providers';
import { CODEX_BACKEND_URL, CODEX_ORIGINATOR } from '../main/codexAuthCore';
import { AgentToolContext, buildTools } from './tools';
import { injectSteerMessages } from './attachments';
import { buildSkillTool, loadSkills, skillsPromptSection } from './skills';

/** A turn sent to the model. Content may be plain text or multimodal parts
 *  (images + inlined files) — see agent/attachments.ts. */
export type ChatMessage = ModelMessage;

/** Resolved provider config for one run — key/baseUrl already looked up by main. */
export type AgentModelConfig = {
  provider: ProviderId;
  modelId: string;
  apiKey?: string;
  /** Endpoint base URL — only for 'openai-compatible'. */
  baseUrl?: string;
  /** ChatGPT account id — only for 'codex' (sent as the chatgpt-account-id header). */
  codexAccountId?: string;
  /** App-level reasoning effort, translated per provider in buildProviderOptions. */
  effort: EffortLevel;
  /** Extended thinking / reasoning on or off. */
  thinking: boolean;
};

/**
 * Fetch wrapper for the Codex (ChatGPT-subscription) backend. The
 * chatgpt.com/backend-api/codex/responses endpoint requires `store: false`
 * (it won't persist responses server-side); we set that via providerOptions but
 * also enforce it here defensively so a Responses-body shape change can't send
 * `store: true` and get rejected. Never throws on a parse miss — it just
 * forwards the request unchanged.
 */
const codexFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      if (body.store !== false) {
        body.store = false;
        init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      /* not JSON (or already a stream) — forward untouched */
    }
  }
  return fetch(input, init);
};

export function createModel(cfg: AgentModelConfig): LanguageModel {
  switch (cfg.provider) {
    case 'google':
      return createGoogleGenerativeAI({ apiKey: cfg.apiKey })(cfg.modelId);
    case 'anthropic':
      return createAnthropic({ apiKey: cfg.apiKey })(cfg.modelId);
    case 'openai':
      return createOpenAI({ apiKey: cfg.apiKey })(cfg.modelId);
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKey: cfg.apiKey,
        headers: { 'X-Title': 'Tevada DevOps' },
      })(cfg.modelId);
    case 'xai':
      return createOpenAICompatible({
        name: 'xai',
        baseURL: 'https://api.x.ai/v1',
        apiKey: cfg.apiKey,
      })(cfg.modelId);
    case 'groq':
      return createOpenAICompatible({
        name: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: cfg.apiKey,
      })(cfg.modelId);
    case 'openai-compatible':
      return createOpenAICompatible({
        name: 'custom',
        baseURL: cfg.baseUrl ?? '',
        apiKey: cfg.apiKey,
      })(cfg.modelId);
    case 'codex':
      // ChatGPT subscription: the access token calls OpenAI's Codex backend
      // (Responses API) directly — no OpenAI API key needed. Uses the official
      // OpenAI provider (so providerOptions live under the `openai` key) pointed
      // at the ChatGPT backend with the subscription bearer + account headers.
      return createOpenAI({
        baseURL: CODEX_BACKEND_URL,
        apiKey: cfg.apiKey,
        headers: {
          'chatgpt-account-id': cfg.codexAccountId ?? '',
          'OpenAI-Beta': 'responses=experimental',
          originator: CODEX_ORIGINATOR,
          session_id: globalThis.crypto?.randomUUID?.() ?? '',
        },
        fetch: codexFetch,
      }).responses(cfg.modelId);
  }
}

type ProviderOptions = Record<string, Record<string, JSONValue>>;

/**
 * Translate the app-level effort/thinking settings into each provider's own
 * knob (verified against the installed SDK option schemas):
 * - Anthropic: `effort` (low…max) + `thinking` adaptive/disabled
 * - OpenAI: `reasoningEffort` (minimal…xhigh)
 * - Gemini: `thinkingConfig.thinkingLevel` (3.x) / `.thinkingBudget` (2.5)
 * - OpenRouter & custom endpoints: `reasoningEffort` → `reasoning_effort`
 */
export function buildProviderOptions(cfg: AgentModelConfig): ProviderOptions {
  const { effort, thinking } = cfg;
  switch (cfg.provider) {
    case 'anthropic': {
      // Fable-tier models have thinking always on and reject an explicit
      // "disabled" — omit the field there instead of sending it.
      const alwaysThinks = cfg.modelId.includes('fable') || cfg.modelId.includes('mythos');
      return {
        anthropic: {
          effort,
          ...(thinking
            ? { thinking: { type: 'adaptive' } }
            : alwaysThinks
              ? {}
              : { thinking: { type: 'disabled' } }),
        },
      };
    }
    case 'openai':
      return {
        openai: {
          reasoningEffort: thinking ? (effort === 'max' ? 'xhigh' : effort) : 'minimal',
        },
      };
    case 'codex':
      // Same `openai` option key (createOpenAI). The ChatGPT backend needs
      // store:false, and because responses aren't stored server-side we must
      // request encrypted reasoning so it round-trips in `input` across turns.
      return {
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          reasoningEffort: thinking ? (effort === 'max' ? 'xhigh' : effort) : 'minimal',
          reasoningSummary: 'auto',
        },
      };
    case 'google': {
      if (!thinking) {
        // 2.5 Pro cannot fully disable thinking — 128 is its minimum budget.
        const budget = cfg.modelId === 'gemini-2.5-pro' ? 128 : 0;
        return cfg.modelId.startsWith('gemini-3')
          ? { google: { thinkingConfig: { thinkingLevel: 'minimal' } } }
          : { google: { thinkingConfig: { thinkingBudget: budget } } };
      }
      if (cfg.modelId.startsWith('gemini-3')) {
        const level = effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
        return { google: { thinkingConfig: { thinkingLevel: level } } };
      }
      // Gemini 2.5 takes a token budget instead of a named level.
      const budget = effort === 'low' ? 2048 : effort === 'medium' ? 8192 : 24576;
      return { google: { thinkingConfig: { thinkingBudget: budget } } };
    }
    case 'openrouter':
    case 'xai':
    case 'groq':
    case 'openai-compatible': {
      // Sent as `reasoning_effort` on the wire; the endpoint normalizes it for
      // the underlying model (reasoning models honor it, others ignore it).
      // Only low/medium/high are portable. When thinking is off we omit it —
      // there is no universal "off" on this path. The options key must match
      // the `name` passed to createOpenAICompatible in createModel.
      if (!thinking) return {};
      const key = cfg.provider === 'openai-compatible' ? 'custom' : cfg.provider;
      const portable = effort === 'low' || effort === 'medium' ? effort : 'high';
      return { [key]: { reasoningEffort: portable } };
    }
    default:
      return {};
  }
}

const SYSTEM_PROMPT = [
  'You are Tevada DevOps, an expert DevOps operator embedded in a desktop app. You manage the user\'s Linux servers over SSH by calling tools. Your users are NOT DevOps experts — they tell you WHAT they want; you own the HOW, end to end. Never hand back a list of commands for the user to run themselves: run them.',
  '',
  'Targeting & connection:',
  '- If you are unsure which server to act on, call listServers first. Use connectServer before running commands if a server is not connected.',
  '- Detect the distro (cat /etc/os-release) before installing anything and use the right package manager (apt-get / dnf / yum / apk).',
  '- When the user mentions "my repo" or deploying from GitHub, call listGithubRepos to resolve the exact owner/repo name and see which servers already hold GitHub credentials. Never ask the user to paste tokens into shell commands.',
  '- If cloning a private GitHub repo over HTTPS fails with 403 / "Write access to repository not granted" / "Repository not found" even though the server holds GitHub credentials, the connected GitHub account cannot READ that repository (GitHub\'s wording is misleading) — typical for organization-owned repos when the GitHub App is not installed on the org, or the token was scoped to the personal account only. Do NOT switch to SSH deploy keys or ask for another token: tell the user to grant access under Settings → GitHub (install the app on the organization / add the repo to its selection, or reconnect with a token whose resource owner is the organization), wait for their confirmation, then retry the same clone. Offer a deploy key only if the user says they cannot change the org\'s GitHub settings.',
  '',
  'Pre-flight capacity check:',
  '- BEFORE any heavy work on a server (deploys, package installs, Docker pulls, builds, database setup), load the check-server-capacity skill and run its check: confirm the instance has enough disk and memory headroom, and add swap for safety if the box has little or none. Skipping this on a small VPS is how deploys die halfway through.',
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
  'Planning & task list:',
  '- For any job with more than ~3 steps (deploys, security audits, hardening, migrations), call updateTodos FIRST to lay out the plan as a checklist the user can watch, then update it as you go: mark exactly one item in_progress while you work it, flip it to completed the instant it is done, and keep the rest pending. Skip the checklist for simple one- or two-step requests.',
  '',
  'Collecting input with on-screen forms:',
  '- When you need several related values from the user to do a job, prefer an on-screen form over asking for each value in plain text — it is far easier for a non-expert. For pointing a domain / custom URL at a service, call requestDomainSetup (it renders the domain form and returns the values); do not ask for the domain, port, HTTPS choice or email in chat. Load the setup-domain skill for the full flow.',
  '- For scheduling database backups, call requestDatabaseBackupSetup (load the setup-database-backup skill for the full flow). For connecting S3-compatible object storage — image/file uploads for an app, or off-site backup copies — call requestS3StorageSetup (load the setup-s3-storage skill). NEVER ask the user to paste access keys or secrets into chat: the form collects them masked, and you write them straight to a root-only file without ever repeating them.',
  '',
  'Verification & reporting:',
  '- After every milestone, VERIFY it actually works (curl -sSI localhost, systemctl is-active, a real client query for databases) before declaring success.',
  '- Give each runCommand/runScript a clear plain-English `description` — the user watches these to understand what is happening.',
  '- Finish with a plain-language summary a non-expert can act on: what you set up, exact URLs / connection strings / credentials they need to copy, how to try it, and any follow-ups (e.g. DNS records to add, ports you opened). Avoid jargon; explain any term you must use.',
].join('\n');

/**
 * Remind the model of the task list it already started, so a follow-up turn
 * ("continue", "keep going") keeps every earlier task instead of forgetting
 * them. The transcript only sends TEXT back to the model — todo items are
 * stripped — so without this the model would start its plan from scratch.
 * Mirrors RooCode, which re-injects the current todo list every turn.
 */
export function buildTodoReminder(todos?: TodoItem[]): string {
  if (!todos || todos.length === 0) return '';
  const lines = todos.map((t) => {
    const mark =
      t.status === 'completed'
        ? '[x]'
        : t.status === 'in_progress'
          ? '[~]'
          : '[ ]';
    return `${mark} ${t.text}`;
  });
  return [
    '',
    '',
    'Current task list (the plan you already started earlier in this conversation):',
    ...lines,
    'When you call updateTodos, you MUST include ALL of these items (keep their exact text and their completed/in-progress states) plus any changes — the tool REPLACES the whole list, so leaving an item out deletes it. Do not re-do tasks already marked [x] completed; continue from the first item that is not yet done.',
  ].join('\n');
}

type RunHandle = {
  abort: AbortController;
  /** Steer messages waiting to be injected at the next step boundary. */
  steerQueue: SteerItem[];
};
const runs = new Map<string, RunHandle>();

/**
 * Push a steer message into a running turn. It is injected as a user message
 * before the agent's next reasoning step (via prepareStep), redirecting the run
 * without aborting the work in progress. Returns whether the run was live and
 * accepted it — if not (the run already ended), the caller starts a fresh turn.
 */
export function steerAgentRun(runId: string, items: SteerItem[]): boolean {
  const handle = runs.get(runId);
  if (!handle) return false;
  handle.steerQueue.push(...items);
  return true;
}

export type StartAgentRunOptions = {
  runId: string;
  messages: ChatMessage[];
  maxSteps: number;
  modelConfig: AgentModelConfig;
  toolContext: AgentToolContext;
  emit: (event: AgentEvent) => void;
  /** The session's current task list, so a continued run keeps earlier tasks. */
  todos?: TodoItem[];
  /**
   * Project context preamble injected into the system prompt when the chat is
   * tagged to a project: the project's name, its "memory" notes, and the servers
   * the run is scoped to. Built in main (store-aware) and passed in so this file
   * stays Electron-free. See {@link buildProjectContext}.
   */
  projectContext?: string;
};

/**
 * Compose the project-memory preamble folded into the system prompt for a
 * project-scoped chat. Kept here (next to buildTodoReminder) so both live
 * beside the prompt they extend, but the caller supplies the raw strings.
 */
export function buildProjectContext(input: {
  name: string;
  memory?: string;
  serverNames: string[];
}): string {
  const lines = [
    '',
    '',
    `This chat is scoped to the project "${input.name}". You may ONLY operate on this project's servers — every other server is off-limits and the tools will refuse it.`,
  ];
  if (input.serverNames.length > 0) {
    lines.push(`Project servers: ${input.serverNames.join(', ')}.`);
  } else {
    lines.push(
      'This project has no servers yet — ask the user to add one before running remote commands.',
    );
  }
  const memory = input.memory?.trim();
  if (memory) {
    lines.push('', 'Project memory (notes the user wants you to always know):', memory);
  }
  return lines.join('\n');
}

/**
 * Compose the workspace overview preamble for a chat with NO project tag: the
 * global "New chat" spans every project, so the agent gets the full picture —
 * each project, its servers, and its memory — and can answer cross-project
 * questions ("how many projects do I have?") without guessing. Same
 * caller-supplies-strings contract as {@link buildProjectContext}.
 */
export function buildWorkspaceContext(input: {
  projects: { name: string; serverNames: string[]; memory?: string }[];
  unassignedServerNames: string[];
}): string {
  const lines = [
    '',
    '',
    'This chat is not scoped to a single project — you can see and operate across the whole workspace.',
  ];
  if (input.projects.length === 0) {
    lines.push('The user has no projects yet.');
  } else {
    lines.push(
      `The user has ${input.projects.length} project${input.projects.length === 1 ? '' : 's'}:`,
    );
    for (const p of input.projects) {
      lines.push(
        `- "${p.name}"${
          p.serverNames.length > 0
            ? ` — servers: ${p.serverNames.join(', ')}`
            : ' — no servers yet'
        }`,
      );
      const memory = p.memory?.trim();
      if (memory) {
        lines.push(`  Project memory: ${memory.replace(/\s*\n\s*/g, ' ')}`);
      }
    }
  }
  if (input.unassignedServerNames.length > 0) {
    lines.push(
      `Servers not in any project: ${input.unassignedServerNames.join(', ')}.`,
    );
  }
  return lines.join('\n');
}

/**
 * Start a streaming agent run. Returns immediately; progress arrives via emit.
 */
export function startAgentRun(opts: StartAgentRunOptions): void {
  const { runId, messages, maxSteps, modelConfig, toolContext, emit } = opts;

  if (!modelConfig.apiKey) {
    emit({
      type: 'error',
      message:
        modelConfig.provider === 'codex'
          ? 'Not signed in to ChatGPT (or the session expired). Open Settings → Codex and sign in with your ChatGPT subscription.'
          : `No API key set for ${providerLabel(modelConfig.provider)}. Open Settings → AI Provider to add one.`,
    });
    emit({ type: 'done', finalText: '' });
    return;
  }
  if (modelConfig.provider === 'openai-compatible' && !modelConfig.baseUrl) {
    emit({
      type: 'error',
      message:
        'No base URL set for the OpenAI-compatible provider. Open Settings → AI Provider and enter your endpoint URL.',
    });
    emit({ type: 'done', finalText: '' });
    return;
  }
  if (!modelConfig.modelId) {
    emit({
      type: 'error',
      message: 'No model selected. Open Settings → AI Provider and pick a model.',
    });
    emit({ type: 'done', finalText: '' });
    return;
  }

  const abort = new AbortController();
  const steerQueue: SteerItem[] = [];
  runs.set(runId, { abort, steerQueue });

  // Thread this run's cancellation into every remote exec so Stop closes the
  // in-flight SSH command's channel, not just the model stream. Without this,
  // cancelling mid-`apt upgrade` leaves the command running on the server.
  toolContext.abortSignal = abort.signal;

  const model = createModel(modelConfig);
  // Skills are re-read per run so user skills in ~/.easyhost/skills apply
  // immediately; only their one-line descriptions enter the system prompt.
  const skills = loadSkills();
  const agent = new ToolLoopAgent({
    model,
    providerOptions: buildProviderOptions(modelConfig),
    instructions: `${SYSTEM_PROMPT}\n\n${skillsPromptSection(skills)}${opts.projectContext ?? ''}${buildTodoReminder(opts.todos)}`,
    tools: { ...buildTools(toolContext), ...buildSkillTool(skills, emit) },
    stopWhen: stepCountIs(maxSteps),
    // Steering: before each reasoning step, fold any pending steer messages in
    // as fresh user turns so the agent redirects without aborting current work.
    prepareStep: ({ messages: stepMessages }) => {
      if (steerQueue.length === 0) return {};
      return { messages: injectSteerMessages(stepMessages, steerQueue.splice(0)) };
    },
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
          // The model's thinking stream — Anthropic extended thinking, Codex /
          // OpenAI reasoning summaries, Gemini thoughts. Forwarded so the
          // renderer can show it live in a collapsible "Thinking" card.
          case 'reasoning-delta':
            if (part.text) emit({ type: 'reasoning-delta', text: part.text });
            break;
          case 'reasoning-end':
            emit({ type: 'reasoning-end' });
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

      // Reconcile the live per-step sum with the SDK's authoritative aggregate
      // (documented as "the sum of all step usages"). They already match in the
      // normal case; this guarantees the FINAL number is exact even if a step
      // reported partial usage (e.g. totalTokens absent). The stream is fully
      // consumed above, so this promise resolves immediately.
      try {
        const finalUsage = await result.totalUsage;
        const authoritative =
          finalUsage?.totalTokens ??
          (finalUsage?.inputTokens ?? 0) + (finalUsage?.outputTokens ?? 0);
        if (authoritative && authoritative !== totalTokens) {
          totalTokens = authoritative;
          emit({ type: 'usage', totalTokens });
        }
      } catch {
        // Usage unavailable (rare) — keep the running per-step sum.
      }

      if (stepIndex >= maxSteps) {
        emit({
          type: 'error',
          message: `Reached the step limit (${maxSteps}). Ask me to continue if the task isn't finished, or raise the limit in Settings.`,
        });
      }
      // A steer that landed after the final step never got a prepareStep to
      // inject it — hand it back so the renderer resends it as a fresh turn.
      if (steerQueue.length > 0) {
        emit({ type: 'steer-unconsumed', items: steerQueue.splice(0) });
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
