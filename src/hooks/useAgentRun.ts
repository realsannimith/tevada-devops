/**
 * Drives a single agent run and reduces its event stream into a flat list of
 * feed items the ChatPanel / WizardsView render: assistant text bubbles and tool
 * activity cards (with live command output, exit code, and approval prompts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentStartRequest,
  ChatHistoryItem,
  ChatTextHistoryItem,
  ChatToolHistoryItem,
  TodoItem,
} from '@/shared/ipc-types';

export type ToolFeedItem = ChatToolHistoryItem;
export type TextFeedItem = ChatTextHistoryItem;
export type FeedItem = ChatHistoryItem;

export type PendingApproval = {
  approvalId: string;
  serverId: string;
  command: string;
  reason: string;
};

/** How the last attached run ended; null while running or before any run. */
export type RunOutcome = 'done' | 'error' | 'cancelled';

export function useAgentRun() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [running, setRunning] = useState(false);
  // Live token tally for the in-flight turn (0 when idle) — drives the
  // "Running · N tokens" status indicator.
  const [tokens, setTokens] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const runIdRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);
  // A thinking block just closed — the next reasoning delta starts a new
  // paragraph inside the same card instead of running the blocks together.
  const reasoningEndedRef = useRef(false);
  // The agent emits 'error' mid-stream and still closes with 'done'; remember
  // the failure so the final outcome reads 'error', not 'done'.
  const sawErrorRef = useRef(false);

  useEffect(() => {
    const unsub = window.easyhost.agent.onEvent(({ runId, event }) => {
      if (runId !== runIdRef.current) return;
      reduce(event);
    });
    return unsub;
  }, []);

  const reduce = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'text-delta': {
        setFeed((f) => {
          const id = assistantIdRef.current;
          const last = f[f.length - 1];
          if (
            id &&
            last &&
            last.kind === 'text' &&
            last.id === id &&
            last.role === 'assistant'
          ) {
            const copy = f.slice();
            copy[copy.length - 1] = {
              ...last,
              content: last.content + event.text,
            };
            return copy;
          }
          const newId = `a_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          assistantIdRef.current = newId;
          return [
            ...f,
            { kind: 'text', id: newId, role: 'assistant', content: event.text },
          ];
        });
        break;
      }
      case 'reasoning-delta': {
        const sep = reasoningEndedRef.current;
        reasoningEndedRef.current = false;
        setFeed((f) => {
          const last = f[f.length - 1];
          // Contiguous thinking accumulates into one card; any text/tool item
          // in between starts a fresh card.
          if (last && last.kind === 'reasoning') {
            const copy = f.slice();
            copy[copy.length - 1] = {
              ...last,
              content: last.content + (sep ? '\n\n' : '') + event.text,
            };
            return copy;
          }
          return [
            ...f,
            {
              kind: 'reasoning',
              id: `r_${Date.now()}_${Math.random().toString(36).slice(2)}`,
              content: event.text,
            },
          ];
        });
        break;
      }
      case 'reasoning-end':
        reasoningEndedRef.current = true;
        break;
      case 'tool-start':
        assistantIdRef.current = null; // next text starts a fresh bubble
        setFeed((f) => [
          ...f,
          {
            kind: 'tool',
            toolCallId: event.toolCallId,
            tool: event.tool,
            description: event.description,
            command:
              event.args && typeof event.args === 'object'
                ? ((event.args as { command?: string; script?: string })
                    .command ??
                  (event.args as { script?: string }).script)
                : undefined,
            status: 'running',
          },
        ]);
        break;
      case 'tool-end':
        setFeed((f) =>
          f.map((it) =>
            it.kind === 'tool' && it.toolCallId === event.toolCallId
              ? {
                  ...it,
                  status: 'done',
                  exitCode:
                    (event.result as { exitCode?: number | null })?.exitCode ??
                    null,
                  output: formatAgentToolResult(event.result),
                }
              : it,
          ),
        );
        break;
      case 'todos':
        assistantIdRef.current = null; // next text starts a fresh bubble
        setFeed((f) => applyTodos(f, event.todos));
        break;
      case 'form-required':
        assistantIdRef.current = null; // next text starts a fresh bubble
        setFeed((f) => [
          ...f,
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
        ]);
        break;
      case 'usage':
        setTokens(event.totalTokens);
        break;
      case 'approval-required':
        setApproval({
          approvalId: event.approvalId,
          serverId: event.serverId,
          command: event.command,
          reason: event.reason,
        });
        break;
      case 'error':
        sawErrorRef.current = true;
        setError(event.message);
        break;
      case 'done':
        setRunning(false);
        runIdRef.current = null;
        setOutcome(sawErrorRef.current ? 'error' : 'done');
        break;
      case 'cancelled':
        setRunning(false);
        runIdRef.current = null;
        setOutcome('cancelled');
        setFeed((f) => [
          ...f,
          {
            kind: 'text',
            id: `c_${Date.now()}`,
            role: 'assistant',
            content: '— run cancelled —',
          },
        ]);
        break;
      default:
        break;
    }
  }, []);

  const start = useCallback(async (req: AgentStartRequest, userEcho?: string) => {
    setError(null);
    setOutcome(null);
    setTokens(0);
    sawErrorRef.current = false;
    setRunning(true);
    assistantIdRef.current = null;
    reasoningEndedRef.current = false;
    if (userEcho) {
      setFeed((f) => [
        ...f,
        {
          kind: 'text',
          id: `u_${Date.now()}`,
          role: 'user',
          content: userEcho,
        },
      ]);
    }
    const { runId } = await window.easyhost.agent.start(req);
    runIdRef.current = runId;
  }, []);

  const cancel = useCallback(async () => {
    if (runIdRef.current) await window.easyhost.agent.cancel(runIdRef.current);
  }, []);

  const respondApproval = useCallback(
    async (approved: boolean) => {
      if (!approval) return;
      await window.easyhost.agent.approve(approval.approvalId, approved);
      setApproval(null);
    },
    [approval],
  );

  const respondForm = useCallback(
    async (formId: string, values: Record<string, string> | null) => {
      setFeed((f) =>
        resolveFormItem(f, formId, values ? 'submitted' : 'cancelled', values ?? undefined),
      );
      await window.easyhost.agent.respondForm(formId, values);
    },
    [],
  );

  const clear = useCallback(() => {
    // Full reset: also detach from any in-flight run so its late events
    // (cancelled marker, trailing tool-ends) can't leak into a fresh chat.
    runIdRef.current = null;
    assistantIdRef.current = null;
    reasoningEndedRef.current = false;
    sawErrorRef.current = false;
    setRunning(false);
    setApproval(null);
    setFeed([]);
    setError(null);
    setOutcome(null);
    setTokens(0);
  }, []);

  const replaceFeed = useCallback((items: FeedItem[]) => {
    setFeed(items);
    setTokens(0);
    setError(null);
    // Loading a transcript means the previous live run's outcome no longer
    // describes what's on screen.
    setOutcome(null);
    sawErrorRef.current = false;
    assistantIdRef.current = null;
  }, []);

  return {
    feed,
    running,
    tokens,
    error,
    outcome,
    approval,
    start,
    cancel,
    respondApproval,
    respondForm,
    clear,
    replaceFeed,
  };
}

/**
 * Fold a `todos` event into the feed: the agent keeps ONE evolving checklist,
 * so update the existing todos card in place (preserving its position + id) and
 * only append a fresh one the first time. Shared with chatRunManager so
 * foreground and background runs reduce identically.
 */
export function applyTodos(feed: FeedItem[], todos: TodoItem[]): FeedItem[] {
  const idx = feed.findIndex((it) => it.kind === 'todos');
  if (idx === -1) {
    return [
      ...feed,
      { kind: 'todos', id: `todo_${Date.now()}`, todos },
    ];
  }
  const copy = feed.slice();
  copy[idx] = { ...(copy[idx] as Extract<FeedItem, { kind: 'todos' }>), todos };
  return copy;
}

/**
 * Mark a form feed item submitted/cancelled in place, stamping the values —
 * turns the interactive form into a read-only record. Shared by the foreground
 * and background reducers so both settle a form the same way.
 */
export function resolveFormItem(
  feed: FeedItem[],
  formId: string,
  status: 'submitted' | 'cancelled',
  values?: Record<string, string>,
): FeedItem[] {
  return feed.map((it) =>
    it.kind === 'form' && it.formId === formId
      ? { ...it, status, values }
      : it,
  );
}

/** Render a tool call's raw result object into the transcript's output text.
 *  Shared with chatRunManager, which reduces background runs the same way. */
export function formatAgentToolResult(result: unknown): string {
  if (result == null) return '';
  const r = result as Record<string, unknown>;
  if (typeof r.error === 'string') return `error: ${r.error}`;
  if (r.approved === false) return String(r.message ?? 'not approved');
  const parts: string[] = [];
  if (typeof r.stdout === 'string' && r.stdout) parts.push(r.stdout);
  if (typeof r.stderr === 'string' && r.stderr)
    parts.push(`[stderr]\n${r.stderr}`);
  if (r.timedOut) parts.push('[timed out]');
  if (parts.length === 0) return JSON.stringify(result, null, 2);
  return parts.join('\n');
}
