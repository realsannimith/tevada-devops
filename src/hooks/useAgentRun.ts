/**
 * Drives a single agent run and reduces its event stream into a flat list of
 * feed items the ChatPanel / WizardsView render: assistant text bubbles and tool
 * activity cards (with live command output, exit code, and approval prompts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentEvent,
  AgentStartRequest,
} from '@/shared/ipc-types';

export type ToolFeedItem = {
  kind: 'tool';
  toolCallId: string;
  tool: string;
  description?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  status: 'running' | 'done';
};

export type TextFeedItem = {
  kind: 'text';
  id: string;
  role: 'user' | 'assistant';
  content: string;
};

export type FeedItem = ToolFeedItem | TextFeedItem;

export type PendingApproval = {
  approvalId: string;
  serverId: string;
  command: string;
  reason: string;
};

export function useAgentRun() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const runIdRef = useRef<string | null>(null);
  const assistantIdRef = useRef<string | null>(null);

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
                ? (event.args as { command?: string }).command
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
                  output: formatResult(event.result),
                }
              : it,
          ),
        );
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
        setError(event.message);
        break;
      case 'done':
        setRunning(false);
        runIdRef.current = null;
        break;
      case 'cancelled':
        setRunning(false);
        runIdRef.current = null;
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
    setRunning(true);
    assistantIdRef.current = null;
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

  const clear = useCallback(() => {
    setFeed([]);
    setError(null);
  }, []);

  return {
    feed,
    running,
    error,
    approval,
    start,
    cancel,
    respondApproval,
    clear,
  };
}

function formatResult(result: unknown): string {
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
