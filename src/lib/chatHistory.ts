import {
  AlertTriangleIcon,
  CheckIcon,
  Loader2Icon,
  StopIcon,
  XIcon,
  type AppIcon,
} from '@/lib/icons';
import type {
  ChatHistoryItem,
  ChatSession,
  ChatSessionKind,
  ChatSessionStatus,
} from '@/shared/ipc-types';

export const CHAT_HISTORY_UPDATED_EVENT = 'easyhost:chat-history-updated';
/** Dispatched by the sidebar when a saved session is picked, so the always-mounted
 *  ChatPanel can hot-swap its feed without a remount. */
export const CHAT_SESSION_SWITCH_EVENT = 'easyhost:chat-session-switch';
/** Dispatched by the sidebar's "New chat" button; the ChatPanel starts a fresh draft.
 *  Detail (optional) pre-scopes the draft to a project — the folder "+" action. */
export const CHAT_NEW_SESSION_EVENT = 'easyhost:chat-new-session';

export type ChatNewSessionDetail = {
  projectId?: string;
};

/** Dispatched by the sidebar after "Move to project", so an open ChatPanel can
 *  mirror the move into its project picker (its debounced saves carry projectId,
 *  and a stale picker would silently move the chat right back). */
export const CHAT_PROJECT_CHANGED_EVENT = 'easyhost:chat-project-changed';

export type ChatProjectChangedDetail = {
  id: string;
  projectId: string | null;
};
/** Dispatched when a saved wizard run is picked, so the always-mounted
 *  WizardsView can open that run's transcript. */
export const WIZARD_SESSION_SWITCH_EVENT = 'easyhost:wizard-session-switch';
/** Dispatched to open a wizard pre-filled with specific values — e.g. the
 *  Artifacts tab launching "Allow remote database access" for one database. */
export const WIZARD_LAUNCH_EVENT = 'easyhost:wizard-launch';

export type WizardLaunchDetail = {
  playbookId: string;
  serverId: string;
  values: Record<string, string>;
};

/** Dispatched to open the chat with a drafted message ready to send — e.g. the
 *  Artifacts tab's "Review with agent" on the exposed-ports strip. Always lands
 *  in a fresh chat session so it can't tack onto an unrelated conversation. */
export const CHAT_PREFILL_EVENT = 'easyhost:chat-prefill';

export type ChatPrefillDetail = {
  message: string;
  /** Scopes the run's SSH tools to one server (null/absent = all servers). */
  serverId?: string | null;
};

export type ChatHistorySummary = {
  id: string;
  kind: ChatSessionKind;
  title: string;
  status?: ChatSessionStatus;
  pinned: boolean;
  messageCount: number;
  updatedAt: number;
  /** Project this chat is tagged to (null = untagged) — drives the History
   *  project filter and the row's project chip. */
  projectId: string | null;
};

/** Sidebar/status-chip presentation for each session lifecycle state.
 *  No bare dots (product decision): working states render a spinner, terminal
 *  states a small tinted glyph — `iconClass` carries both tint and motion. */
export const SESSION_STATUS_META: Record<
  ChatSessionStatus,
  { label: string; icon: AppIcon; iconClass: string }
> = {
  running: { label: 'Running…', icon: Loader2Icon, iconClass: 'animate-spin text-skill' },
  done: { label: 'Succeeded', icon: CheckIcon, iconClass: 'text-success' },
  error: { label: 'Failed', icon: XIcon, iconClass: 'text-destructive' },
  cancelled: { label: 'Stopped', icon: StopIcon, iconClass: 'text-muted-foreground/60' },
  interrupted: { label: 'Interrupted', icon: AlertTriangleIcon, iconClass: 'text-warning' },
};

export function sessionKind(session: ChatSession): ChatSessionKind {
  return session.kind ?? 'chat';
}

export function newChatSessionId(): string {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

/**
 * A persisted transcript can contain tools frozen at 'running' — or a form
 * frozen at 'pending' — if the app died mid-run. Settle them so a reopened
 * transcript doesn't spin forever or offer a form whose run is long gone.
 */
export function markInterruptedToolsDone(items: ChatHistoryItem[]): ChatHistoryItem[] {
  return items.map((item) => {
    if (item.kind === 'tool' && item.status === 'running') {
      return { ...item, status: 'done' as const };
    }
    if (item.kind === 'form' && item.status === 'pending') {
      return { ...item, status: 'cancelled' as const };
    }
    return item;
  });
}

export function summarizeChatSession(session: ChatSession): ChatHistorySummary | null {
  const kind = sessionKind(session);
  const textItems = session.items.filter((item) => item.kind === 'text');

  if (kind === 'wizard') {
    if (session.items.length === 0) return null;
    return {
      id: session.id,
      kind,
      title: session.title?.trim() || 'Wizard run',
      status: session.status,
      pinned: session.pinned === true,
      messageCount: textItems.length,
      updatedAt: session.updatedAt,
      projectId: session.projectId ?? null,
    };
  }

  if (textItems.length === 0) return null;

  const firstUserMessage =
    textItems.find((item) => item.role === 'user')?.content.trim() ??
    textItems[0]?.content.trim() ??
    'Agent chat';
  // A user rename (explicit title) always wins over the derived one.
  const explicitTitle = session.title?.trim();

  return {
    id: session.id,
    kind,
    title: compactTitle(explicitTitle || firstUserMessage),
    status: session.status,
    pinned: session.pinned === true,
    messageCount: textItems.length,
    updatedAt: session.updatedAt,
    projectId: session.projectId ?? null,
  };
}

/**
 * Sidebar History list ordering. Pinned rows float to the top; within the
 * pinned group and within the unpinned group, most-recently-updated first.
 * Array.sort is stable, so equal `updatedAt` values keep their input order.
 */
export function compareHistorySummaries(
  a: ChatHistorySummary,
  b: ChatHistorySummary,
): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return b.updatedAt - a.updatedAt;
}

/** Full pipeline used by the sidebar: sessions -> visible, ordered summaries. */
export function summarizeChatHistory(sessions: ChatSession[]): ChatHistorySummary[] {
  return sessions
    .map(summarizeChatSession)
    .filter((s): s is ChatHistorySummary => s !== null)
    .sort(compareHistorySummaries);
}

function compactTitle(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return 'Agent chat';
  return collapsed.length > 42 ? `${collapsed.slice(0, 39).trim()}...` : collapsed;
}
