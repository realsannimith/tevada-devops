import { useEffect, useState, type MouseEvent } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import appIcon from '@/assets/app-icon.png';
import { SidebarLeadingIcon } from '@/components/SidebarLeadingIcon';
import { SidebarGlyph } from '@/components/sidebarGlyphs';
import { ThemeToggleButton } from '@/components/ThemeToggle';
import { useServers } from '@/hooks/useServers';
import {
  CHAT_HISTORY_UPDATED_EVENT,
  CHAT_NEW_SESSION_EVENT,
  CHAT_SESSION_SWITCH_EVENT,
  SESSION_STATUS_META,
  WIZARD_SESSION_SWITCH_EVENT,
  summarizeChatHistory,
  type ChatHistorySummary,
} from '@/lib/chatHistory';
import { chatRunManager } from '@/lib/chatRunManager';
import {
  RUN_STATUS_EVENT,
  type RunStatusDetail,
  type RunSurface,
} from '@/lib/runStatus';
import {
  ChatBubbleIcon,
  ClockIcon,
  EllipsisIcon,
  Loader2Icon,
  PinFilledIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
  WizardsIcon,
  XIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { ChatHistoryState, ConnStatus } from '@/shared/ipc-types';
import type { View } from '@/App';

/** Connection state shown by the terminal glyph itself — tint for terminal
 *  states, spinner while connecting. No floating dots (product decision). */
const STATUS_GLYPH_CLASS: Record<ConnStatus, string | undefined> = {
  connected: 'text-success',
  connecting: 'animate-spin text-warning',
  error: 'text-destructive',
  disconnected: undefined,
};

export function ServerSidebar({
  view,
  onNavigate,
  onAddServer,
  onEditServer,
  onOpenSettings,
}: {
  view: View;
  onNavigate: (v: View) => void;
  onAddServer: () => void;
  onEditServer: (serverId: string) => void;
  onOpenSettings: () => void;
}) {
  const { servers, statusOf, connect, disconnect, remove } = useServers();
  const [sessions, setSessions] = useState<ChatHistorySummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Wizard run last opened from History (the store's active pointer is chat-only).
  const [activeWizardSessionId, setActiveWizardSessionId] = useState<string | null>(null);
  // Live "is a run streaming right now" flags published by the always-mounted
  // chat panel / wizards view — drives the pulsing dot on the nav rows.
  const [liveRuns, setLiveRuns] = useState<Record<RunSurface, boolean>>({
    chat: false,
    wizard: false,
  });

  const activeServerId = view.kind === 'server' ? view.serverId : null;

  useEffect(() => {
    const handleRunStatus = (event: Event) => {
      const { surface, running } = (event as CustomEvent<RunStatusDetail>).detail;
      setLiveRuns((prev) =>
        prev[surface] === running ? prev : { ...prev, [surface]: running },
      );
    };
    window.addEventListener(RUN_STATUS_EVENT, handleRunStatus);
    return () => window.removeEventListener(RUN_STATUS_EVENT, handleRunStatus);
  }, []);

  const applyChatState = (state: ChatHistoryState) => {
    setSessions(summarizeChatHistory(state.sessions));
    setActiveSessionId(state.activeSessionId);
  };

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const state = await window.easyhost.chatHistory.list();
        if (!cancelled) applyChatState(state);
      } catch {
        if (!cancelled) setSessions([]);
      }
    };

    const handleHistoryUpdated = (event: Event) => {
      const state = (event as CustomEvent<ChatHistoryState>).detail;
      if (state) applyChatState(state);
    };

    void load();
    // Primary, reliable sync: main broadcasts on every persisted write, so the
    // sidebar reflects the store even when the ChatPanel is unmounted.
    const unsubChanged = window.easyhost.chatHistory.onChanged((state) => {
      if (!cancelled && state) applyChatState(state);
    });
    // Kept as a same-window fast path and OS-refocus fallback.
    window.addEventListener(CHAT_HISTORY_UPDATED_EVENT, handleHistoryUpdated);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      unsubChanged();
      window.removeEventListener(CHAT_HISTORY_UPDATED_EVENT, handleHistoryUpdated);
      window.removeEventListener('focus', load);
    };
  }, []);

  /** Picking a saved session opens it in its own always-mounted view: chats
   *  hot-swap the ChatPanel (and move the store's active pointer), wizard runs
   *  open their transcript in the WizardsView. */
  const selectSession = (summary: ChatHistorySummary) => {
    if (summary.kind === 'wizard') {
      onNavigate({ kind: 'wizards' });
      setActiveWizardSessionId(summary.id);
      window.dispatchEvent(
        new CustomEvent(WIZARD_SESSION_SWITCH_EVENT, { detail: summary.id }),
      );
      return;
    }
    onNavigate({ kind: 'chat' });
    window.dispatchEvent(
      new CustomEvent(CHAT_SESSION_SWITCH_EVENT, { detail: summary.id }),
    );
    void window.easyhost.chatHistory.setActive(summary.id);
  };

  /** Starts a fresh conversation — the current one stays saved in History. */
  const newChat = () => {
    onNavigate({ kind: 'chat' });
    window.dispatchEvent(new CustomEvent(CHAT_NEW_SESSION_EVENT));
  };

  const togglePin = async (summary: ChatHistorySummary, event: MouseEvent) => {
    event.stopPropagation();
    const saved = await window.easyhost.chatHistory.setPinned(
      summary.id,
      !summary.pinned,
    );
    applyChatState(saved);
  };

  const deleteSession = async (summary: ChatHistorySummary, event: MouseEvent) => {
    event.stopPropagation();
    // Deleting a session with a background run also stops that run — otherwise
    // its next debounced save would resurrect the entry we just removed.
    if (summary.kind !== 'wizard') chatRunManager.discard(summary.id);
    const saved = await window.easyhost.chatHistory.delete(summary.id);
    applyChatState(saved);
    if (summary.kind === 'wizard') return;
    // If the deleted session was open in the ChatPanel, tell it to fall back
    // to whatever is now active (or a fresh draft if nothing is left).
    window.dispatchEvent(
      new CustomEvent(CHAT_SESSION_SWITCH_EVENT, { detail: saved.activeSessionId }),
    );
  };

  return (
    <aside className="glass drag-region flex h-full w-60 shrink-0 flex-col border-r border-sidebar-border text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 pt-9 pb-3">
        <img
          src={appIcon}
          alt=""
          aria-hidden
          className="size-5 shrink-0 rounded-[5px]"
        />
        <span className="text-[13px] font-semibold tracking-[-0.015em] text-ink">
          Tevada DevOps
        </span>
      </div>

      <nav className="no-drag flex flex-col gap-0.5 px-2">
        <NavRow
          active={view.kind === 'chat'}
          icon={<SidebarGlyph icon={ChatBubbleIcon} variant="leading" />}
          label="DevOps Agent"
          running={liveRuns.chat}
          onClick={() => onNavigate({ kind: 'chat' })}
        />
        <NavRow
          active={false}
          icon={<SidebarGlyph icon={PlusIcon} variant="leading" />}
          label="New chat"
          onClick={newChat}
        />
        <NavRow
          active={view.kind === 'wizards'}
          icon={<SidebarGlyph icon={WizardsIcon} variant="leading" />}
          label="Wizards"
          running={liveRuns.wizard}
          onClick={() => onNavigate({ kind: 'wizards' })}
        />
      </nav>

      {sessions.length > 0 && (
        <>
          <div className="no-drag mt-5 flex items-center justify-between px-4 pb-1">
            <span className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
              History
            </span>
            <button
              onClick={newChat}
              className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
              title="New chat"
            >
              <SidebarGlyph icon={PlusIcon} variant="chrome" />
            </button>
          </div>
          <div className="no-drag max-h-48 space-y-0.5 overflow-y-auto px-2">
            {sessions.map((summary) => (
              <HistoryRow
                key={summary.id}
                active={
                  summary.kind === 'wizard'
                    ? view.kind === 'wizards' && summary.id === activeWizardSessionId
                    : view.kind === 'chat' && summary.id === activeSessionId
                }
                summary={summary}
                onClick={() => selectSession(summary)}
                onTogglePin={(event) => togglePin(summary, event)}
                onDelete={(event) => deleteSession(summary, event)}
              />
            ))}
          </div>
        </>
      )}

      <div className="no-drag mt-5 flex items-center justify-between px-4 pb-1">
        <span className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
          Servers
        </span>
        <button
          onClick={onAddServer}
          className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
          title="Add server"
        >
          <SidebarGlyph icon={PlusIcon} variant="chrome" />
        </button>
      </div>

      <div className="no-drag flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {servers.length === 0 && (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
            No servers yet. Click + to add one.
          </p>
        )}
        {servers.map((s) => {
          const status = statusOf(s.id);
          return (
            <div
              key={s.id}
              className={cn(
                'group flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors',
                activeServerId === s.id
                  ? 'bg-black/[0.06] text-foreground dark:bg-white/[0.08]'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <SidebarLeadingIcon size="sm" className="relative">
                <SidebarGlyph
                  icon={status === 'connecting' ? Loader2Icon : TerminalIcon}
                  variant="leading"
                  className={STATUS_GLYPH_CLASS[status]}
                />
              </SidebarLeadingIcon>
              <button
                className="flex-1 truncate text-left"
                onClick={() =>
                  onNavigate({
                    kind: 'server',
                    serverId: s.id,
                    tab: 'terminal',
                  })
                }
                title={`${s.username}@${s.host}`}
              >
                {s.name}
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rounded-sm p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100">
                    <SidebarGlyph icon={EllipsisIcon} variant="chrome" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {status === 'connected' ? (
                    <DropdownMenuItem onClick={() => disconnect(s.id)}>
                      Disconnect
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => connect(s.id)}>
                      Connect
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => onEditServer(s.id)}
                  >
                    Edit server
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      onNavigate({
                        kind: 'server',
                        serverId: s.id,
                        tab: 'monitoring',
                      })
                    }
                  >
                    Monitoring
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      onNavigate({
                        kind: 'server',
                        serverId: s.id,
                        tab: 'artifacts',
                      })
                    }
                  >
                    Artifacts
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => remove(s.id)}
                  >
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      <div className="no-drag flex items-center gap-1 border-t border-sidebar-border p-2">
        <button
          onClick={onOpenSettings}
          className={cn(
            'flex h-7 flex-1 items-center gap-2 rounded-md px-2 text-xs transition-colors',
            view.kind === 'settings'
              ? 'bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <SidebarLeadingIcon
            size="sm"
            tone={view.kind === 'settings' ? 'text-inherit' : undefined}
          >
            <SidebarGlyph icon={SettingsIcon} variant="leading" />
          </SidebarLeadingIcon>
          Settings
        </button>
        <ThemeToggleButton />
      </div>
    </aside>
  );
}

function HistoryRow({
  active,
  summary,
  onClick,
  onTogglePin,
  onDelete,
}: {
  active: boolean;
  summary: ChatHistorySummary;
  onClick: () => void;
  onTogglePin: (event: MouseEvent) => void;
  onDelete: (event: MouseEvent) => void;
}) {
  return (
    <div
      className={cn(
        'group/history flex min-h-10 items-start gap-1 rounded-md px-2 py-1.5 transition-colors',
        active
          ? 'bg-black/[0.06] text-foreground dark:bg-white/[0.08]'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <button
        onClick={onClick}
        title={summary.title}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <SidebarLeadingIcon
          size="sm"
          tone={active ? 'text-inherit' : undefined}
          className="relative"
        >
          {/* A running session announces itself with a spinner in place of the
              glyph; finished states speak through the status line below. */}
          {summary.status === 'running' ? (
            <SidebarGlyph
              icon={Loader2Icon}
              variant="leading"
              className="animate-spin text-skill"
            />
          ) : (
            <SidebarGlyph
              icon={summary.kind === 'wizard' ? WizardsIcon : ClockIcon}
              variant="leading"
            />
          )}
        </SidebarLeadingIcon>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{summary.title}</span>
          {summary.status && (summary.kind === 'wizard' || summary.status !== 'done') ? (
            <SessionStatusLine status={summary.status} />
          ) : (
            <span className="block truncate text-[10px] text-muted-foreground">
              {summary.messageCount} saved message
              {summary.messageCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </button>
      <div className="mt-0.5 flex shrink-0 items-start gap-0.5">
        <button
          onClick={onTogglePin}
          title={summary.pinned ? 'Unpin this chat' : 'Pin this chat'}
          aria-label={summary.pinned ? 'Unpin this chat' : 'Pin this chat'}
          aria-pressed={summary.pinned}
          className={cn(
            'rounded-sm p-0.5 transition-opacity hover:bg-accent hover:text-foreground',
            summary.pinned
              ? 'text-foreground opacity-100'
              : 'text-muted-foreground/60 opacity-0 focus-visible:opacity-100 group-hover/history:opacity-100',
          )}
        >
          <SidebarGlyph
            icon={summary.pinned ? PinFilledIcon : PinIcon}
            variant="chrome"
          />
        </button>
        <button
          onClick={onDelete}
          title="Delete this chat"
          aria-label="Delete this chat"
          className="rounded-sm p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/history:opacity-100"
        >
          <SidebarGlyph icon={XIcon} variant="chrome" />
        </button>
      </div>
    </div>
  );
}

function NavRow({
  active,
  icon,
  label,
  running,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  /** Shows a pulsing dot while this surface has an agent run streaming. */
  running?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors',
        active
          ? 'bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <SidebarLeadingIcon
        size="sm"
        tone={active ? 'text-inherit' : undefined}
        className="relative"
      >
        {icon}
        {running && (
          <Loader2Icon
            aria-hidden
            className="absolute -right-1 -top-1 size-2.5 animate-spin text-skill"
          />
        )}
      </SidebarLeadingIcon>
      {label}
    </button>
  );
}

/** Status line under a history row's title: tiny tinted glyph + word — the
 *  no-dots replacement for the old colored corner badge. */
function SessionStatusLine({
  status,
}: {
  status: NonNullable<ChatHistorySummary['status']>;
}) {
  const meta = SESSION_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
      <Icon aria-hidden className={cn('size-2.5 shrink-0', meta.iconClass)} />
      {meta.label}
    </span>
  );
}
