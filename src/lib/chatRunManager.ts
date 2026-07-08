/**
 * Owns every chat agent run in the renderer, independent of which session the
 * ChatPanel is currently displaying. Starting a new chat or opening another
 * conversation does NOT stop an in-flight run: its events keep streaming into
 * its own session's entry here (and keep being persisted with live status),
 * FCode-thread style, and the user reattaches simply by reopening that session
 * from History. Several sessions can run at once.
 *
 * The ChatPanel reads a session's live state with `useChatRun(sessionId)`;
 * sessions without an entry here are plain saved transcripts.
 */
import { useSyncExternalStore } from 'react';
import {
  applyTodos,
  formatAgentToolResult,
  resolveFormItem,
  type PendingApproval,
  type RunOutcome,
} from '@/hooks/useAgentRun';
import { CHAT_HISTORY_UPDATED_EVENT } from '@/lib/chatHistory';
import { feedToMessages } from '@/lib/chatMessages';
import { publishRunStatus } from '@/lib/runStatus';
import type {
  AgentEvent,
  AgentStartRequest,
  ChatAttachment,
  ChatHistoryItem,
  ChatSession,
  ChatSessionStatus,
  SteerItem,
} from '@/shared/ipc-types';

export type ChatRunSnapshot = {
  sessionId: string;
  feed: ChatHistoryItem[];
  running: boolean;
  tokens: number;
  error: string | null;
  outcome: RunOutcome | null;
  approval: PendingApproval | null;
};

type RunEntry = {
  /** Immutable per notification, so React can use it as an external-store snapshot. */
  snapshot: ChatRunSnapshot;
  runId: string | null;
  assistantId: string | null;
  sawError: boolean;
  targetServerId: string | null;
  projectId: string | null;
  createdAt: number;
  saveTimer: number | null;
  firstPendingAt: number | null;
  pendingSession: ChatSession | null;
  /** A steer arrived after the run's last step (unconsumed) — resend it as a
   *  fresh turn once this run settles. */
  resendOnDone: boolean;
  /** A thinking block just closed — the next reasoning delta starts a new
   *  paragraph inside the same card (see useAgentRun's reducer). */
  reasoningEnded: boolean;
};

const entries = new Map<string, RunEntry>();
const runIdToSession = new Map<string, string>();
const listeners = new Set<() => void>();
let wired = false;
let lastPublishedRunning = false;

function ensureWired(): void {
  if (wired) return;
  wired = true;
  window.easyhost.agent.onEvent(({ runId, event }) => {
    const sessionId = runIdToSession.get(runId);
    if (sessionId) reduce(sessionId, event);
  });
  // App quit / reload: push any pending writes over IPC before the page dies.
  window.addEventListener('pagehide', () => {
    for (const sessionId of entries.keys()) flushSave(sessionId);
  });
}

function isAnyChatRunning(): boolean {
  for (const entry of entries.values()) {
    if (entry.snapshot.running) return true;
  }
  return false;
}

function notify(): void {
  const running = isAnyChatRunning();
  if (running !== lastPublishedRunning) {
    lastPublishedRunning = running;
    publishRunStatus('chat', running);
  }
  for (const listener of listeners) listener();
}

function reduce(sessionId: string, event: AgentEvent): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  const snap = entry.snapshot;
  switch (event.type) {
    case 'text-delta': {
      const feed = snap.feed.slice();
      const last = feed[feed.length - 1];
      if (
        entry.assistantId &&
        last &&
        last.kind === 'text' &&
        last.id === entry.assistantId &&
        last.role === 'assistant'
      ) {
        feed[feed.length - 1] = { ...last, content: last.content + event.text };
      } else {
        entry.assistantId = `a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        feed.push({
          kind: 'text',
          id: entry.assistantId,
          role: 'assistant',
          content: event.text,
        });
      }
      entry.snapshot = { ...snap, feed };
      break;
    }
    case 'reasoning-delta': {
      const sep = entry.reasoningEnded;
      entry.reasoningEnded = false;
      const feed = snap.feed.slice();
      const last = feed[feed.length - 1];
      // Contiguous thinking accumulates into one card; any text/tool item in
      // between starts a fresh card.
      if (last && last.kind === 'reasoning') {
        feed[feed.length - 1] = {
          ...last,
          content: last.content + (sep ? '\n\n' : '') + event.text,
        };
      } else {
        feed.push({
          kind: 'reasoning',
          id: `r_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          content: event.text,
        });
      }
      entry.snapshot = { ...snap, feed };
      break;
    }
    case 'reasoning-end':
      entry.reasoningEnded = true;
      break;
    case 'tool-start':
      entry.assistantId = null; // next text starts a fresh bubble
      entry.snapshot = {
        ...snap,
        feed: [
          ...snap.feed,
          {
            kind: 'tool',
            toolCallId: event.toolCallId,
            tool: event.tool,
            description: event.description,
            command:
              event.args && typeof event.args === 'object'
                ? ((event.args as { command?: string; script?: string }).command ??
                  (event.args as { script?: string }).script)
                : undefined,
            status: 'running',
          },
        ],
      };
      break;
    case 'tool-end':
      entry.snapshot = {
        ...snap,
        feed: snap.feed.map((it) =>
          it.kind === 'tool' && it.toolCallId === event.toolCallId
            ? {
                ...it,
                status: 'done',
                exitCode:
                  (event.result as { exitCode?: number | null })?.exitCode ?? null,
                output: formatAgentToolResult(event.result),
              }
            : it,
        ),
      };
      break;
    case 'todos':
      entry.assistantId = null; // next text starts a fresh bubble
      entry.snapshot = { ...snap, feed: applyTodos(snap.feed, event.todos) };
      break;
    case 'form-required':
      entry.assistantId = null; // next text starts a fresh bubble
      entry.snapshot = {
        ...snap,
        feed: [
          ...snap.feed,
          {
            kind: 'form',
            formId: event.form.formId,
            title: event.form.title,
            description: event.form.description,
            submitLabel: event.form.submitLabel,
            fields: event.form.fields,
            dnsGuide: event.form.dnsGuide,
            status: 'pending',
          },
        ],
      };
      break;
    case 'usage':
      entry.snapshot = { ...snap, tokens: event.totalTokens };
      break;
    case 'steer-unconsumed':
      // The steer text is already echoed in the feed (steer() added it); the
      // run just ended before injecting it. Resend from the feed once 'done'
      // settles this run to running:false.
      entry.resendOnDone = true;
      break;
    case 'approval-required':
      entry.snapshot = {
        ...snap,
        approval: {
          approvalId: event.approvalId,
          serverId: event.serverId,
          command: event.command,
          reason: event.reason,
        },
      };
      break;
    case 'error':
      entry.sawError = true;
      entry.snapshot = { ...snap, error: event.message };
      break;
    case 'done':
      if (entry.runId) runIdToSession.delete(entry.runId);
      entry.runId = null;
      entry.snapshot = {
        ...snap,
        running: false,
        outcome: entry.sawError ? 'error' : 'done',
      };
      if (entry.resendOnDone) {
        entry.resendOnDone = false;
        // After this reduce's notify/save settle the run to idle.
        window.setTimeout(() => resendSteers(sessionId), 0);
      }
      break;
    case 'cancelled':
      if (entry.runId) runIdToSession.delete(entry.runId);
      entry.runId = null;
      entry.snapshot = {
        ...snap,
        running: false,
        outcome: 'cancelled',
        feed: [
          ...snap.feed,
          {
            kind: 'text',
            id: `c_${Date.now()}`,
            role: 'assistant',
            content: '— run cancelled —',
          },
        ],
      };
      break;
    default:
      return;
  }
  scheduleSave(sessionId);
  notify();
}

/**
 * Resend the steer message(s) — already echoed at the tail of the feed — as a
 * fresh turn, used when a steer couldn't be injected because the run had ended.
 * The transcript's last user message(s) ARE the steer, so we rebuild the model
 * messages straight from the feed (no new echo).
 */
function resendSteers(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry || entry.snapshot.running) return; // a run is (again) live
  const feed = entry.snapshot.feed;
  const messages = feedToMessages(feed).slice(-40);
  if (messages.length === 0) return;
  const lastUser = [...feed]
    .reverse()
    .find((i): i is Extract<ChatHistoryItem, { kind: 'text' }> =>
      i.kind === 'text' && i.role === 'user',
    );
  const attachments = lastUser?.attachments;
  const todos = feed.find((i) => i.kind === 'todos');
  void chatRunManager.start({
    sessionId,
    baseItems: feed,
    echoUser: false,
    targetServerId: entry.targetServerId,
    projectId: entry.projectId,
    createdAt: entry.createdAt,
    userEcho: '',
    attachments,
    req: {
      messages,
      attachments: attachments?.length ? attachments : undefined,
      serverIds: entry.targetServerId ? [entry.targetServerId] : undefined,
      projectId: entry.projectId,
      todos: todos && todos.kind === 'todos' && todos.todos.length ? todos.todos : undefined,
    },
  });
}

function buildSession(entry: RunEntry): ChatSession {
  const snap = entry.snapshot;
  const status: ChatSessionStatus = snap.running
    ? 'running'
    : snap.outcome ?? 'done';
  return {
    id: snap.sessionId,
    kind: 'chat',
    status,
    items: snap.feed,
    tokens: snap.tokens > 0 ? snap.tokens : undefined,
    targetServerId: entry.targetServerId,
    projectId: entry.projectId,
    createdAt: entry.createdAt,
    updatedAt: Date.now(),
  };
}

/** Debounced 250ms with a 1s max-wait so a busy stream can't starve saves;
 *  flushes immediately once the run settles. */
function scheduleSave(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  entry.pendingSession = buildSession(entry);
  if (entry.firstPendingAt === null) entry.firstPendingAt = Date.now();
  if (entry.saveTimer !== null) window.clearTimeout(entry.saveTimer);
  const overdue = Date.now() - entry.firstPendingAt >= 1000;
  entry.saveTimer = window.setTimeout(
    () => flushSave(sessionId),
    overdue || !entry.snapshot.running ? 0 : 250,
  );
}

function flushSave(sessionId: string): void {
  const entry = entries.get(sessionId);
  if (!entry) return;
  if (entry.saveTimer !== null) {
    window.clearTimeout(entry.saveTimer);
    entry.saveTimer = null;
  }
  const pending = entry.pendingSession;
  entry.pendingSession = null;
  entry.firstPendingAt = null;
  if (!pending) return;
  void window.easyhost.chatHistory.upsert(pending).then((saved) => {
    window.dispatchEvent(
      new CustomEvent(CHAT_HISTORY_UPDATED_EVENT, { detail: saved }),
    );
  });
}

export const chatRunManager = {
  /** Start a run for a session. Its transcript begins from `baseItems` (the
   *  conversation so far) plus the echoed user message. */
  async start(opts: {
    sessionId: string;
    baseItems: ChatHistoryItem[];
    targetServerId: string | null;
    projectId: string | null;
    createdAt: number;
    req: AgentStartRequest;
    userEcho: string;
    /** Files/images the user attached to this turn — shown on the user bubble
     *  and sent to the model as multimodal content (via req.attachments). */
    attachments?: ChatAttachment[];
    /** When false, `baseItems` is used as-is (the user bubble is already in it —
     *  e.g. a steer fallback where the steer message was echoed earlier). */
    echoUser?: boolean;
  }): Promise<void> {
    ensureWired();
    if (entries.get(opts.sessionId)?.snapshot.running) return; // one run per session
    const feed: ChatHistoryItem[] =
      opts.echoUser === false
        ? [...opts.baseItems]
        : [
            ...opts.baseItems,
            {
              kind: 'text',
              id: `u_${Date.now()}`,
              role: 'user',
              content: opts.userEcho,
              attachments: opts.attachments?.length
                ? opts.attachments
                : undefined,
            },
          ];
    const entry: RunEntry = {
      snapshot: {
        sessionId: opts.sessionId,
        feed,
        running: true,
        tokens: 0,
        error: null,
        outcome: null,
        approval: null,
      },
      runId: null,
      assistantId: null,
      sawError: false,
      targetServerId: opts.targetServerId,
      projectId: opts.projectId,
      createdAt: opts.createdAt,
      saveTimer: null,
      firstPendingAt: null,
      pendingSession: null,
      resendOnDone: false,
      reasoningEnded: false,
    };
    entries.set(opts.sessionId, entry);
    scheduleSave(opts.sessionId); // History shows "Running…" right away
    notify();
    let runId: string;
    try {
      ({ runId } = await window.easyhost.agent.start(opts.req));
    } catch (err) {
      entry.sawError = true;
      entry.snapshot = {
        ...entry.snapshot,
        running: false,
        outcome: 'error',
        error: err instanceof Error ? err.message : String(err),
      };
      scheduleSave(opts.sessionId);
      notify();
      return;
    }
    // The session may have been deleted (discarded) while starting.
    if (entries.get(opts.sessionId) !== entry) {
      void window.easyhost.agent.cancel(runId);
      return;
    }
    entry.runId = runId;
    runIdToSession.set(runId, opts.sessionId);
  },

  /** Ask main to stop this session's run; the 'cancelled' event finishes the
   *  bookkeeping (marker, status, final save). */
  cancel(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (entry?.runId) void window.easyhost.agent.cancel(entry.runId);
  },

  /**
   * Steer a live run: echo the message into the transcript (with the "steer"
   * marker) and inject it into the running turn so the agent redirects without
   * aborting its work. If the run already ended, fall back to a fresh turn so
   * the message is never lost.
   */
  async steer(sessionId: string, item: SteerItem): Promise<void> {
    const entry = entries.get(sessionId);
    if (!entry) return;
    entry.snapshot = {
      ...entry.snapshot,
      feed: [
        ...entry.snapshot.feed,
        {
          kind: 'text',
          id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          role: 'user',
          content: item.text,
          attachments: item.attachments?.length ? item.attachments : undefined,
          dispatchMode: 'steer',
        },
      ],
    };
    scheduleSave(sessionId);
    notify();
    if (entry.runId) {
      const { accepted } = await window.easyhost.agent.steer(entry.runId, [item]);
      if (accepted) return; // prepareStep will fold it into the live run
    }
    // The run already ended — resend the steer(s) as a fresh continuation turn.
    resendSteers(sessionId);
  },

  async respondApproval(sessionId: string, approved: boolean): Promise<void> {
    const entry = entries.get(sessionId);
    const approval = entry?.snapshot.approval;
    if (!entry || !approval) return;
    await window.easyhost.agent.approve(approval.approvalId, approved);
    entry.snapshot = { ...entry.snapshot, approval: null };
    notify();
  },

  /** Submit (values) or cancel (null) an in-chat form. Settles the form item in
   *  the feed and unblocks the paused run in main. */
  async respondForm(
    sessionId: string,
    formId: string,
    values: Record<string, string> | null,
  ): Promise<void> {
    const entry = entries.get(sessionId);
    if (entry) {
      entry.snapshot = {
        ...entry.snapshot,
        feed: resolveFormItem(
          entry.snapshot.feed,
          formId,
          values ? 'submitted' : 'cancelled',
          values ?? undefined,
        ),
      };
      scheduleSave(sessionId);
      notify();
    }
    await window.easyhost.agent.respondForm(formId, values);
  },

  /** Stop tracking (and stop) a session's run WITHOUT a final save — used when
   *  the user deletes the session, so a late write can't resurrect it. */
  discard(sessionId: string): void {
    const entry = entries.get(sessionId);
    if (!entry) return;
    if (entry.saveTimer !== null) window.clearTimeout(entry.saveTimer);
    if (entry.runId) {
      runIdToSession.delete(entry.runId);
      void window.easyhost.agent.cancel(entry.runId);
    }
    entries.delete(sessionId);
    notify();
  },

  get(sessionId: string): ChatRunSnapshot | undefined {
    return entries.get(sessionId)?.snapshot;
  },

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

/** Live run state for one session; undefined when it has no tracked run. */
export function useChatRun(sessionId: string): ChatRunSnapshot | undefined {
  return useSyncExternalStore(chatRunManager.subscribe, () =>
    chatRunManager.get(sessionId),
  );
}
