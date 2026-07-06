import { useEffect, useRef } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import ChatMarkdown from '@/components/chat/ChatMarkdown';
import { BrailleSpinner } from '@/components/chat/RunningStatus';
import {
  CHAT_TRANSCRIPT_TEXT_CLASS_NAME,
  USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
  USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
} from '@/components/chat/chatTypography';
import {
  ChecklistIcon,
  ChevronRightIcon,
  CircleCheckFilledIcon,
  CircleIcon,
  Loader2Icon,
  TerminalIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type {
  FeedItem,
  PendingApproval,
  ToolFeedItem,
} from '@/hooks/useAgentRun';
import type { ChatTodoHistoryItem } from '@/shared/ipc-types';

export function AgentFeed({
  feed,
  error,
  approval,
  onApprove,
  running = false,
  tokens = 0,
  emptyMessage = "The agent's actions and replies will appear here.",
}: {
  feed: FeedItem[];
  error: string | null;
  approval: PendingApproval | null;
  onApprove: (approved: boolean) => void;
  running?: boolean;
  /** Live token tally for the in-flight turn — shown next to the "Running"
   *  indicator that's appended to the feed, mirroring where the assistant's
   *  next message will actually appear rather than a bar fixed elsewhere. */
  tokens?: number;
  emptyMessage?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The indicator only belongs at the tail once the agent has started
  // replying with fresh text — a bare tool call already shows its own
  // "running" spinner, so doubling up here would just be noise.
  const lastItem = feed[feed.length - 1];
  const showRunningRow =
    running &&
    (feed.length === 0 ||
      lastItem?.kind !== 'tool' ||
      lastItem.status !== 'running');
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed, error, showRunningRow]);

  return (
    <>
      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto bg-background p-4"
      >
        {feed.length === 0 && !running && (
          <p className="mx-auto max-w-sm pt-16 text-center text-xs leading-relaxed text-muted-foreground/70">
            {emptyMessage}
          </p>
        )}
        {feed.map((item, index) =>
          item.kind === 'text' ? (
            item.role === 'user' ? (
              <div key={item.id} className="flex w-full justify-end">
                <div className="group flex max-w-[80%] flex-col items-end gap-px">
                  <div
                    className={cn(
                      'w-max max-w-full min-w-0 self-end border border-border bg-[var(--app-user-message-background)]',
                      USER_MESSAGE_BUBBLE_RADIUS_CLASS_NAME,
                      USER_MESSAGE_BUBBLE_SHELL_CHROME_CLASS_NAME,
                    )}
                  >
                    <p className={cn('whitespace-pre-wrap', CHAT_TRANSCRIPT_TEXT_CLASS_NAME)}>
                      {item.content}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div key={item.id} className="flex w-full justify-start">
                <div className="min-w-0 max-w-[85%] py-0.5">
                  <ChatMarkdown
                    text={item.content}
                    isStreaming={running && index === feed.length - 1}
                  />
                </div>
              </div>
            )
          ) : item.kind === 'todos' ? (
            <TodoCard key={item.id} item={item} />
          ) : (
            <ToolCard key={item.toolCallId} item={item} />
          ),
        )}
        {showRunningRow && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 py-0.5 text-xs"
          >
            <BrailleSpinner className="text-success" />
            <span className="font-medium text-ink">Running</span>
            {tokens > 0 && (
              <span className="tabular-nums text-muted-foreground/70">
                {tokens.toLocaleString()} tokens
              </span>
            )}
          </div>
        )}
        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>

      <AlertDialog open={!!approval}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve command?</AlertDialogTitle>
            <AlertDialogDescription>{approval?.reason}</AlertDialogDescription>
          </AlertDialogHeader>
          <pre className="max-h-40 overflow-auto rounded-md bg-secondary p-3 font-mono text-xs text-ink">
            {approval?.command}
          </pre>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => onApprove(false)}>
              Reject
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => onApprove(true)}>
              Run it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/**
 * The agent's task checklist — one evolving card per session (updateTodos
 * replaces the list in place). Renders like Claude Code / Cursor's todo panel:
 * a titled list with a checkbox glyph per row that ticks off as work completes.
 * No bare status dots (product decision): pending is a hollow circle
 * (checkbox affordance), in-progress a spinner, completed a filled check.
 */
function TodoCard({ item }: { item: ChatTodoHistoryItem }) {
  const todos = item.todos;
  const done = todos.filter((t) => t.status === 'completed').length;
  const allDone = todos.length > 0 && done === todos.length;

  return (
    <div className="surface-panel min-w-0 overflow-hidden px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <ChecklistIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium text-ink">Task list</span>
        <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground/70">
          {done}/{todos.length}
        </span>
      </div>
      <ol className="space-y-1">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {todo.status === 'completed' ? (
                <CircleCheckFilledIcon className="size-4 text-success" />
              ) : todo.status === 'in_progress' ? (
                <Loader2Icon className="size-3.5 animate-spin text-skill" />
              ) : (
                <CircleIcon className="size-3.5 text-muted-foreground/40" />
              )}
            </span>
            <span
              className={cn(
                'min-w-0 flex-1 text-xs leading-5',
                todo.status === 'completed'
                  ? 'text-muted-foreground/60 line-through'
                  : todo.status === 'in_progress'
                    ? 'font-medium text-ink'
                    : 'text-muted-foreground',
              )}
            >
              {todo.text}
            </span>
          </li>
        ))}
      </ol>
      {allDone && (
        <p className="mt-2 text-[11px] font-medium text-success">
          All tasks complete
        </p>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: ToolFeedItem }) {
  const failed =
    item.status === 'done' &&
    item.exitCode !== null &&
    item.exitCode !== undefined &&
    item.exitCode !== 0;
  const label = item.description || item.command || item.tool;
  const hasDetails = Boolean(item.command || item.output);

  // Mirrors FCode's borderless tool row (SimpleWorkEntryRow / ToolDetailsDisclosure):
  // a quiet, muted line that highlights on hover and expands inline + indented,
  // rather than a heavy bordered card.
  return (
    <details className="group/tool min-w-0">
      <summary
        className={cn(
          'flex w-full list-none items-center gap-2 rounded-md px-2 py-1.5 text-left [&::-webkit-details-marker]:hidden',
          hasDetails
            ? 'cursor-pointer transition-colors hover:bg-secondary'
            : 'cursor-default',
        )}
        title={item.command || label}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center',
            item.status === 'running'
              ? 'text-skill'
              : failed
                ? 'text-destructive'
                : 'text-muted-foreground/50',
          )}
        >
          {item.status === 'running' ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <TerminalIcon className="size-4" />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs leading-6 text-muted-foreground/80">
          {label}
        </span>
        {failed && (
          <span className="shrink-0 rounded-full bg-destructive/12 px-1.5 py-0.5 text-[10px] tabular-nums text-destructive">
            exit {item.exitCode}
          </span>
        )}
        {hasDetails && (
          <ChevronRightIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-200 group-open/tool:rotate-90"
          />
        )}
      </summary>
      {hasDetails && (
        <div className="mt-1.5 ml-7 space-y-2">
          {item.command && (
            <pre className="overflow-x-auto rounded-md bg-secondary px-2 py-1.5 font-mono text-xs text-ink">
              $ {item.command}
            </pre>
          )}
          {item.output && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/60 px-2 py-1.5 font-mono text-xs text-muted-foreground">
              {item.output}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}
