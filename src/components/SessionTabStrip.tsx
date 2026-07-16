/**
 * Termius-style session tab row across the top of the content column: every
 * host opened from the sidebar or dashboard gets a tab, so multiple servers
 * stay one click away instead of being lost on each navigation. Tabs show the
 * live connection state, close on ✕ or middle-click, and the trailing “+”
 * jumps to the host list to open another session. The strip is also the
 * window-drag surface for the frameless titlebar (tabs opt out via .no-drag).
 */
import { PlusIcon, XIcon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { ConnStatus } from '@/shared/ipc-types';

export type SessionTabItem = {
  id: string;
  name: string;
  status: ConnStatus;
  active: boolean;
};

const DOT_CLS: Record<ConnStatus, string> = {
  connected: 'bg-success',
  connecting: 'bg-warning animate-pulse',
  error: 'bg-destructive',
  disconnected: 'bg-muted-foreground/40',
};

export function SessionTabStrip({
  items,
  onSelect,
  onClose,
  onNewSession,
}: {
  items: SessionTabItem[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewSession: () => void;
}) {
  return (
    <div className="drag-region flex h-9 shrink-0 items-center gap-1 overflow-x-auto px-2">
      {items.map((item) => (
        <div
          key={item.id}
          role="tab"
          aria-selected={item.active}
          tabIndex={0}
          onClick={() => onSelect(item.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onSelect(item.id);
          }}
          // Middle-click closes, like every tabbed terminal.
          onAuxClick={(e) => {
            if (e.button === 1) onClose(item.id);
          }}
          title={item.name}
          className={cn(
            'no-drag group flex h-7 max-w-44 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-md border px-2.5 text-xs',
            item.active
              ? 'border-border bg-background text-ink'
              : 'border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-ink',
          )}
        >
          <span
            aria-hidden
            className={cn('size-1.5 shrink-0 rounded-full', DOT_CLS[item.status])}
          />
          <span className="truncate">{item.name}</span>
          <span
            role="button"
            aria-label={`Close ${item.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(item.id);
            }}
            className={cn(
              'flex size-4 shrink-0 items-center justify-center rounded-sm hover:bg-secondary hover:text-ink',
              item.active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100',
            )}
          >
            <XIcon className="size-3" />
          </span>
        </div>
      ))}
      <button
        type="button"
        onClick={onNewSession}
        title="Open a host"
        aria-label="Open a host"
        className="no-drag flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-ink"
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}
