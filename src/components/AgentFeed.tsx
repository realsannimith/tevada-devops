import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Terminal as TerminalIcon, Loader2 } from 'lucide-react';
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
import { cn } from '@/lib/utils';
import type {
  FeedItem,
  PendingApproval,
  ToolFeedItem,
} from '@/hooks/useAgentRun';

export function AgentFeed({
  feed,
  error,
  approval,
  onApprove,
}: {
  feed: FeedItem[];
  error: string | null;
  approval: PendingApproval | null;
  onApprove: (approved: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [feed, error]);

  return (
    <>
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {feed.length === 0 && (
          <p className="pt-10 text-center text-sm text-muted-foreground">
            The agent's actions and replies will appear here.
          </p>
        )}
        {feed.map((item) =>
          item.kind === 'text' ? (
            <div
              key={item.id}
              className={cn(
                'flex',
                item.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              <div
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm',
                  item.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-foreground',
                )}
              >
                {item.content}
              </div>
            </div>
          ) : (
            <ToolCard key={item.toolCallId} item={item} />
          ),
        )}
        {error && (
          <p className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
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
          <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
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

function ToolCard({ item }: { item: ToolFeedItem }) {
  const [open, setOpen] = useState(false);
  const failed =
    item.status === 'done' &&
    item.exitCode !== null &&
    item.exitCode !== undefined &&
    item.exitCode !== 0;

  return (
    <div className="rounded-lg border bg-card text-sm">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        {item.status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-yellow-500" />
        ) : (
          <TerminalIcon
            className={cn(
              'h-3.5 w-3.5',
              failed ? 'text-destructive' : 'text-green-500',
            )}
          />
        )}
        <span className="flex-1 truncate">
          {item.description || item.command || item.tool}
        </span>
        {item.status === 'done' && item.exitCode !== null && (
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-xs tabular-nums',
              failed
                ? 'bg-destructive/15 text-destructive'
                : 'bg-green-500/15 text-green-500',
            )}
          >
            exit {item.exitCode}
          </span>
        )}
        <ChevronRight
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2">
          {item.command && (
            <pre className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
              $ {item.command}
            </pre>
          )}
          {item.output && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted/50 px-2 py-1 font-mono text-xs text-muted-foreground">
              {item.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
