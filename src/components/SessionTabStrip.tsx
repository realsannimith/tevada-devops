/**
 * Termius-style session tab row across the top of the content column: every
 * host opened from the sidebar or dashboard gets a tab, so multiple servers
 * stay one click away instead of being lost on each navigation. Tabs show the
 * live connection state, close from the close control or middle-click, and the trailing plus
 * jumps to the host list to open another session. The strip is also the
 * window-drag surface for the frameless titlebar (tabs opt out via .no-drag).
 */
import {
  AlertTriangleIcon,
  CheckIcon,
  Loader2Icon,
  PlusIcon,
  TerminalIcon,
  WifiOffIcon,
  XIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { ConnStatus } from '@/shared/ipc-types';

export type SessionTabItem = {
  id: string;
  name: string;
  status: ConnStatus;
  active: boolean;
};

const STATUS_ICON: Record<
  ConnStatus,
  { icon: typeof CheckIcon; cls: string; spin?: boolean }
> = {
  connected: { icon: CheckIcon, cls: 'text-success' },
  connecting: { icon: Loader2Icon, cls: 'text-warning', spin: true },
  error: { icon: AlertTriangleIcon, cls: 'text-destructive' },
  disconnected: { icon: WifiOffIcon, cls: 'text-muted-foreground/60' },
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
  const focusTab = (index: number) => {
    const item = items[index];
    if (!item) return;
    onSelect(item.id);
    requestAnimationFrame(() => {
      document.getElementById(`session-tab-${item.id}`)?.focus();
    });
  };

  return (
    <div className="drag-region chat-surface-divider flex h-10 shrink-0 items-center gap-1 overflow-x-auto px-2">
      <div
        role="tablist"
        aria-label="Open server sessions"
        className="flex shrink-0 items-center gap-1"
      >
        {items.map((item, index) => {
          const statusMeta = STATUS_ICON[item.status];
          const StatusIcon = statusMeta.icon;
          return (
            <div
              key={item.id}
              className={cn(
                'no-drag group flex h-7 max-w-48 shrink-0 items-center overflow-hidden rounded-lg border text-xs transition-colors',
                item.active
                  ? 'border-border bg-background text-ink'
                  : 'border-transparent text-muted-foreground hover:bg-sidebar-accent hover:text-ink',
              )}
            >
              <button
                id={`session-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={item.active}
                tabIndex={item.active ? 0 : -1}
                title={item.name}
                onClick={() => onSelect(item.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) onClose(item.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault();
                    focusTab((index - 1 + items.length) % items.length);
                  } else if (event.key === 'ArrowRight') {
                    event.preventDefault();
                    focusTab((index + 1) % items.length);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusTab(0);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    focusTab(items.length - 1);
                  }
                }}
                className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
              >
                <TerminalIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{item.name}</span>
                <StatusIcon
                  aria-hidden
                  className={cn(
                    'size-3 shrink-0',
                    statusMeta.cls,
                    statusMeta.spin && 'animate-spin',
                  )}
                />
              </button>
              <button
                type="button"
                aria-label={`Close ${item.name}`}
                title={`Close ${item.name}`}
                onClick={() => onClose(item.id)}
                className={cn(
                  'mr-1 flex size-5 shrink-0 items-center justify-center rounded-md outline-none transition-opacity hover:bg-secondary hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/40',
                  item.active
                    ? 'opacity-60 hover:opacity-100'
                    : 'opacity-0 group-hover:opacity-60 group-focus-within:opacity-60 hover:opacity-100',
                )}
              >
                <XIcon aria-hidden className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onNewSession}
        title="Open a host"
        aria-label="Open a host"
        className="no-drag flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
