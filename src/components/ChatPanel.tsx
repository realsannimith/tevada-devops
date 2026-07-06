import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgentFeed } from '@/components/AgentFeed';
import { SidebarGlyph } from '@/components/sidebarGlyphs';
import {
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_EDITOR_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
  COMPOSER_INPUT_ROW_CLASS_NAME,
} from '@/components/chat/composerStyles';
import type { FeedItem } from '@/hooks/useAgentRun';
import { useServers } from '@/hooks/useServers';
import {
  CHAT_HISTORY_UPDATED_EVENT,
  CHAT_NEW_SESSION_EVENT,
  CHAT_PREFILL_EVENT,
  CHAT_SESSION_SWITCH_EVENT,
  markInterruptedToolsDone,
  newChatSessionId,
  sessionKind,
  type ChatPrefillDetail,
} from '@/lib/chatHistory';
import { chatRunManager, useChatRun } from '@/lib/chatRunManager';
import type { ChatSession, ChatSessionStatus } from '@/shared/ipc-types';
import {
  ComposerSendArrowIcon,
  PlusIcon,
  ServerIcon,
  SparklesIcon,
  TrashIcon,
} from '@/lib/icons';

const ALL = '__all__';
const COMPOSER_MAX_HEIGHT_PX = 200;

export function ChatPanel() {
  const { servers } = useServers();
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<string>(ALL);
  const [historyReady, setHistoryReady] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The session currently displayed in the composer. Generated locally and only
  // persisted (via upsert) once it has at least one message — an empty "new
  // chat" never shows up as a stray entry in the sidebar's history list.
  const [sessionId, setSessionId] = useState<string>(() => newChatSessionId());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Saved transcript of the displayed session — what the feed shows when the
  // session has no live run tracked by chatRunManager.
  const [loadedFeed, setLoadedFeed] = useState<FeedItem[]>([]);
  const createdAtRef = useRef<number>(Date.now());
  // Last persisted lifecycle status of the loaded session, so idle re-saves
  // (e.g. changing the target server) don't overwrite a final state.
  const statusRef = useRef<ChatSessionStatus | null>(null);
  // Holds the latest idle session write that the debounce hasn't flushed yet,
  // so we can persist it on app quit / unmount instead of dropping it.
  const pendingSessionRef = useRef<ChatSession | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  // Live run state for the DISPLAYED session only. Runs belong to
  // chatRunManager, not this component: starting a new chat or opening another
  // conversation leaves the old run streaming (and saving) in the background,
  // and reopening its session here reattaches to the live feed.
  const runState = useChatRun(sessionId);
  const feed = runState?.feed ?? loadedFeed;
  const running = runState?.running ?? false;
  const tokens = runState?.tokens ?? 0;
  const error = runState?.error ?? null;
  const approval = runState?.approval ?? null;

  /** Swap the composer to a saved session (or a fresh draft). Never touches
   *  other sessions' runs. Returns the now-displayed session id. */
  const loadSession = (session: ChatSession | null): string => {
    const id = session?.id ?? newChatSessionId();
    setSessionId(id);
    sessionIdRef.current = id;
    createdAtRef.current = session?.createdAt ?? Date.now();
    statusRef.current =
      session?.status === 'running' && !chatRunManager.get(id)
        ? 'interrupted'
        : session?.status ?? null;
    setTarget(session?.targetServerId ?? ALL);
    setLoadedFeed(markInterruptedToolsDone(session?.items ?? []));
    return id;
  };

  const buildSession = (status: ChatSessionStatus, items: FeedItem[]): ChatSession => ({
    id: sessionIdRef.current,
    kind: 'chat',
    status,
    items,
    targetServerId: targetRef.current === ALL ? null : targetRef.current,
    createdAt: createdAtRef.current,
    updatedAt: Date.now(),
  });

  useEffect(() => {
    let cancelled = false;
    window.easyhost.chatHistory
      .list()
      .then((state) => {
        if (cancelled) return;
        // Wizard runs share the session store but belong to the WizardsView;
        // the composer only ever loads chat-kind sessions.
        const chats = state.sessions.filter((s) => sessionKind(s) === 'chat');
        const active =
          chats.find((s) => s.id === state.activeSessionId) ?? chats[0] ?? null;
        loadSession(active);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHistoryReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The sidebar dispatches this when a saved session is picked, so the
  // always-mounted ChatPanel can hot-swap without a remount. The session we
  // navigate away from is left completely alone — if it has a run in flight,
  // chatRunManager keeps streaming and saving it in the background.
  useEffect(() => {
    const handleSwitch = (event: Event) => {
      const id = (event as CustomEvent<string | null>).detail;
      if (id === sessionIdRef.current) return;
      void window.easyhost.chatHistory.list().then((state) => {
        loadSession(
          state.sessions.find(
            (s) => s.id === id && sessionKind(s) === 'chat',
          ) ?? null,
        );
      });
    };
    window.addEventListener(CHAT_SESSION_SWITCH_EVENT, handleSwitch);
    return () => window.removeEventListener(CHAT_SESSION_SWITCH_EVENT, handleSwitch);
  }, []);

  // The sidebar's "New chat" button — same behavior as the header button.
  useEffect(() => {
    const handleNewChat = () => {
      newChat();
    };
    window.addEventListener(CHAT_NEW_SESSION_EVENT, handleNewChat);
    return () => window.removeEventListener(CHAT_NEW_SESSION_EVENT, handleNewChat);
  }, []);

  // Other screens draft a message into the composer (e.g. Artifacts' "Review
  // with agent"). Always a fresh session — the drafted ask shouldn't inherit
  // an unrelated conversation's context — targeted at the requesting server.
  useEffect(() => {
    const handlePrefill = (event: Event) => {
      const detail = (event as CustomEvent<ChatPrefillDetail>).detail;
      if (!detail?.message) return;
      const id = loadSession(null);
      void window.easyhost.chatHistory.setActive(id);
      setTarget(detail.serverId ?? ALL);
      setInput(detail.message);
      inputRef.current?.focus();
    };
    window.addEventListener(CHAT_PREFILL_EVENT, handlePrefill);
    return () => window.removeEventListener(CHAT_PREFILL_EVENT, handlePrefill);
  }, []);

  useEffect(() => {
    if (target === ALL || servers.length === 0) return;
    if (!servers.some((server) => server.id === target)) {
      setTarget(ALL);
    }
  }, [servers, target]);

  // Idle-only persistence: while a run is live, chatRunManager saves its
  // session (even when this panel shows a different one). This effect covers
  // the rest — target changes on a loaded conversation and normalization
  // after loading.
  useEffect(() => {
    if (!historyReady || running) return;
    // Never persist an empty draft — only real conversations show up as
    // history entries in the sidebar.
    if (feed.filter((item) => item.kind === 'text').length === 0) return;
    const status: ChatSessionStatus =
      runState?.outcome ?? statusRef.current ?? 'done';
    statusRef.current = status;
    const session = buildSession(status, feed);
    pendingSessionRef.current = session;
    const timeout = window.setTimeout(() => {
      pendingSessionRef.current = null;
      void window.easyhost.chatHistory.upsert(session).then((saved) => {
        window.dispatchEvent(
          new CustomEvent(CHAT_HISTORY_UPDATED_EVENT, { detail: saved }),
        );
      });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [feed, historyReady, target, running, runState?.outcome]);

  // Flush any pending (still-debounced) idle save when the page goes away
  // (app quit, reload) or the panel unmounts. Live runs flush separately in
  // chatRunManager.
  useEffect(() => {
    const flush = () => {
      const pending = pendingSessionRef.current;
      if (pending) {
        pendingSessionRef.current = null;
        void window.easyhost.chatHistory.upsert(pending);
      }
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, [input]);

  async function send() {
    const text = input.trim();
    if (!text || running) return;
    setInput('');
    statusRef.current = null; // the run's own lifecycle takes over from here
    // Sending makes this the open conversation; record that explicitly since
    // background saves never move the pointer.
    void window.easyhost.chatHistory.setActive(sessionId);
    await chatRunManager.start({
      sessionId,
      baseItems: feed,
      targetServerId: target === ALL ? null : target,
      createdAt: createdAtRef.current,
      req: {
        messages: buildAgentMessages(feed, text),
        serverIds: target === ALL ? undefined : [target],
      },
      userEcho: text,
    });
  }

  /** Deletes the currently open session entirely (removes it from the sidebar). */
  async function clearHistory() {
    if (running) return;
    const id = sessionIdRef.current;
    // Drop any finished-run entry so a late write can't resurrect the session.
    chatRunManager.discard(id);
    loadSession(null);
    const saved = await window.easyhost.chatHistory.delete(id);
    window.dispatchEvent(
      new CustomEvent(CHAT_HISTORY_UPDATED_EVENT, { detail: saved }),
    );
  }

  /**
   * Start fresh, FCode-thread style: the current conversation is left exactly
   * as it is — if the agent is still working on it, the run keeps going in the
   * background (visible as "Running…" in History) and its reply lands in that
   * session, not in this new draft.
   */
  function newChat() {
    setInput('');
    const id = loadSession(null);
    void window.easyhost.chatHistory.setActive(id);
    inputRef.current?.focus();
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="chat-surface-divider flex shrink-0 items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="skill-chip flex size-6 items-center justify-center rounded-full">
            <SidebarGlyph icon={SparklesIcon} variant="chrome" />
          </span>
          <div>
            <h1 className="text-sm font-semibold tracking-[-0.015em] text-ink">
              DevOps Agent
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={newChat}
            disabled={!running && feed.length === 0}
            aria-label="Start a new chat"
            title="Start a new chat (keeps this one saved in History)"
          >
            <PlusIcon aria-hidden className="size-4" />
            New chat
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={clearHistory}
            disabled={running || feed.length === 0}
            aria-label="Delete this chat"
            title="Delete this chat from History"
          >
            <TrashIcon aria-hidden className="size-4" />
          </Button>
        </div>
      </header>

      <AgentFeed
        feed={feed}
        error={error}
        approval={approval}
        onApprove={(approved) =>
          void chatRunManager.respondApproval(sessionId, approved)
        }
        running={running}
        tokens={tokens}
      />

      <form
        className="bg-background px-4 pt-2 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className={COMPOSER_COLUMN_FRAME_CLASS_NAME}>
          <div className="mb-2 flex items-center">
            <Select value={target} onValueChange={setTarget}>
              <SelectTrigger
                size="sm"
                className={COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME}
                aria-label="Choose target servers"
              >
                <ServerIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-foreground"
                />
                <SelectValue />
              </SelectTrigger>
              <SelectContent side="top">
                <SelectItem value={ALL}>All servers</SelectItem>
                {servers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="composer overflow-hidden">
            <div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
              <div className={COMPOSER_INPUT_ROW_CLASS_NAME}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder="Ask anything…"
                  disabled={running}
                  autoFocus
                  rows={1}
                  data-slot="composer-input"
                  className={COMPOSER_EDITOR_CLASS_NAME}
                />

                {running ? (
                  <Button
                    type="button"
                    variant="prominent"
                    size="icon-xs"
                    className="size-7 shrink-0 rounded-full sm:size-7"
                    onClick={() => chatRunManager.cancel(sessionId)}
                    aria-label="Stop generation"
                    title="Stop the current agent run"
                  >
                    <span
                      aria-hidden="true"
                      className="block size-2 rounded-[2px] bg-current"
                    />
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="prominent"
                    size="icon-xs"
                    className="size-7 shrink-0 rounded-full sm:size-7"
                    disabled={!input.trim()}
                    aria-label="Send message"
                  >
                    <ComposerSendArrowIcon
                      aria-hidden
                      className="size-5 shrink-0"
                    />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}

function buildAgentMessages(feed: FeedItem[], nextUserMessage: string) {
  const prior = feed
    .filter((item): item is Extract<FeedItem, { kind: 'text' }> => item.kind === 'text')
    .map((item) => ({
      role: item.role,
      content: item.content.trim(),
    }))
    .filter((message) => message.content.length > 0);

  return [...prior, { role: 'user' as const, content: nextUserMessage }].slice(-40);
}

