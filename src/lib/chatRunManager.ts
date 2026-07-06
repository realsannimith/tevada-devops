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
  type PendingApproval,
  type RunOutcome,
} from '@/hooks/useAgentRun';
import { CHAT_HISTORY_UPDATED_EVENT } from '@/lib/chatHistory';
import { publishRunStatus } from '@/lib/runStatus';
import type {
  AgentEvent,
  AgentStartRequest,
  ChatHistoryItem,
  ChatSession,
  ChatSessionStatus,
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
  createdAt: number;
  saveTimer: number | null;
  firstPendingAt: number | null;
  pendingSession: ChatSession | null;
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
    case 'usage':
      entry.snapshot = { ...snap, tokens: event.totalTokens };
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
    targetServerId: entry.targetServerId,
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
    createdAt: number;
    req: AgentStartRequest;
    userEcho: string;
  }): Promise<void> {
    ensureWired();
    if (entries.get(opts.sessionId)?.snapshot.running) return; // one run per session
    const entry: RunEntry = {
      snapshot: {
        sessionId: opts.sessionId,
        feed: [
          ...opts.baseItems,
          { kind: 'text', id: `u_${Date.now()}`, role: 'user', content: opts.userEcho },
        ],
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
      createdAt: opts.createdAt,
      saveTimer: null,
      firstPendingAt: null,
      pendingSession: null,
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

  async respondApproval(sessionId: string, approved: boolean): Promise<void> {
    const entry = entries.get(sessionId);
    const approval = entry?.snapshot.approval;
    if (!entry || !approval) return;
    await window.easyhost.agent.approve(approval.approvalId, approved);
    entry.snapshot = { ...entry.snapshot, approval: null };
    notify();
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
