import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import agentIcon from '@/assets/agent-icon.png';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AgentFeed } from '@/components/AgentFeed';
import {
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_EDITOR_CLASS_NAME,
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_PICKER_TRIGGER_CLASS_NAME,
  COMPOSER_INPUT_ROW_CLASS_NAME,
} from '@/components/chat/composerStyles';
import { ModelOptionsMenu } from '@/components/chat/ModelOptionsMenu';
import type { FeedItem } from '@/hooks/useAgentRun';
import { useServers } from '@/hooks/useServers';
import { useProjects } from '@/hooks/useProjects';
import {
  CHAT_HISTORY_UPDATED_EVENT,
  CHAT_NEW_SESSION_EVENT,
  CHAT_PREFILL_EVENT,
  CHAT_PROJECT_CHANGED_EVENT,
  CHAT_SESSION_SWITCH_EVENT,
  markInterruptedToolsDone,
  newChatSessionId,
  sessionKind,
  type ChatNewSessionDetail,
  type ChatPrefillDetail,
  type ChatProjectChangedDetail,
} from '@/lib/chatHistory';
import { chatRunManager, useChatRun } from '@/lib/chatRunManager';
import { buildAgentMessages } from '@/lib/chatMessages';
import { toast } from 'sonner';
import {
  formatBytes,
  readFileAttachment,
} from '@/lib/attachments';
import type {
  ChatAttachment,
  ChatSession,
  ChatSessionStatus,
  ChatTodoHistoryItem,
  TurnDispatchMode,
} from '@/shared/ipc-types';
import { ATTACHMENT_LIMITS } from '@/shared/ipc-types';
import {
  ClockIcon,
  ComposerSendArrowIcon,
  FileTextIcon,
  FolderIcon,
  PaperclipIcon,
  PlusIcon,
  ServerIcon,
  TrashIcon,
  XIcon,
} from '@/lib/icons';

const ALL = '__all__';
const NO_PROJECT = '__no_project__';
const COMPOSER_MAX_HEIGHT_PX = 200;

/** A message the user queued while the agent was running. */
type QueuedTurn = { id: string; text: string; attachments: ChatAttachment[] };
/** File picker filter — images plus common text/config/code files. */
const ATTACH_ACCEPT =
  'image/*,text/*,.txt,.log,.env,.yml,.yaml,.json,.toml,.ini,.conf,.cfg,.md,.sh,.bash,.dockerfile,.nginx,.service,.py,.js,.ts,.tsx,.jsx,.go,.rs,.rb,.php,.java,.sql,.html,.css,.xml,.csv';

export function ChatPanel() {
  const { servers } = useServers();
  const { projects } = useProjects();
  const [input, setInput] = useState('');
  const [target, setTarget] = useState<string>(ALL);
  const [project, setProject] = useState<string>(NO_PROJECT);
  const [historyReady, setHistoryReady] = useState(false);
  // Files/images staged in the composer, sent with the next message.
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // Messages the user queued while a run was in flight — auto-sent, in order,
  // once the run finishes (FCode's queued-turn model).
  const [queuedTurns, setQueuedTurns] = useState<QueuedTurn[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The session currently displayed in the composer. Generated locally and only
  // persisted (via upsert) once it has at least one message — an empty "new
  // chat" never shows up as a stray entry in the sidebar's history list.
  const [sessionId, setSessionId] = useState<string>(() => newChatSessionId());
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  // Saved transcript of the displayed session — what the feed shows when the
  // session has no live run tracked by chatRunManager.
  const [loadedFeed, setLoadedFeed] = useState<FeedItem[]>([]);
  // Token tally persisted with the session — shown at the transcript's tail
  // when there's no live run entry to read it from.
  const [loadedTokens, setLoadedTokens] = useState(0);
  // Confirm-before-delete for the header's trash button.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const createdAtRef = useRef<number>(Date.now());
  // Last persisted lifecycle status of the loaded session, so idle re-saves
  // (e.g. changing the target server) don't overwrite a final state.
  const statusRef = useRef<ChatSessionStatus | null>(null);
  // Holds the latest idle session write that the debounce hasn't flushed yet,
  // so we can persist it on app quit / unmount instead of dropping it.
  const pendingSessionRef = useRef<ChatSession | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;
  const projectRef = useRef(project);
  projectRef.current = project;

  // A chat's server scope is fixed by its project. A project chat can only
  // reach that project's servers (enforced in the main process via
  // allowedServerIds), so we don't offer a per-server target picker there — it
  // always runs against every server in the project. Only unscoped ("All
  // projects") chats show the target dropdown and can aim at one server.
  useEffect(() => {
    if (project !== NO_PROJECT && target !== ALL) setTarget(ALL);
  }, [project, target]);

  // Live run state for the DISPLAYED session only. Runs belong to
  // chatRunManager, not this component: starting a new chat or opening another
  // conversation leaves the old run streaming (and saving) in the background,
  // and reopening its session here reattaches to the live feed.
  const runState = useChatRun(sessionId);
  const feed = runState?.feed ?? loadedFeed;
  const running = runState?.running ?? false;
  const tokens = runState ? runState.tokens : loadedTokens;
  const error = runState?.error ?? null;
  const approval = runState?.approval ?? null;
  // Latest feed for async dispatch (queue auto-send) without stale closures.
  const feedRef = useRef(feed);
  feedRef.current = feed;

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
    setProject(session?.projectId ?? NO_PROJECT);
    setLoadedFeed(markInterruptedToolsDone(session?.items ?? []));
    setLoadedTokens(session?.tokens ?? 0);
    // Queued turns belong to the conversation you were looking at — don't carry
    // them into a different one.
    setQueuedTurns([]);
    return id;
  };

  const buildSession = (status: ChatSessionStatus, items: FeedItem[]): ChatSession => ({
    id: sessionIdRef.current,
    kind: 'chat',
    status,
    items,
    tokens: tokens > 0 ? tokens : undefined,
    targetServerId: targetRef.current === ALL ? null : targetRef.current,
    projectId: projectRef.current === NO_PROJECT ? null : projectRef.current,
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

  // The sidebar's "New chat" button — same behavior as the header button. A
  // project folder's "+" passes its project id so the draft starts pre-scoped.
  useEffect(() => {
    const handleNewChat = (event: Event) => {
      const detail = (event as CustomEvent<ChatNewSessionDetail | undefined>)
        .detail;
      newChat();
      if (detail?.projectId) setProject(detail.projectId);
    };
    window.addEventListener(CHAT_NEW_SESSION_EVENT, handleNewChat);
    return () => window.removeEventListener(CHAT_NEW_SESSION_EVENT, handleNewChat);
  }, []);

  // The sidebar moved a chat between projects. If it's the one on screen,
  // update the picker — otherwise this panel's next debounced save would write
  // the old projectId back and undo the move.
  useEffect(() => {
    const handleProjectChanged = (event: Event) => {
      const detail = (event as CustomEvent<ChatProjectChangedDetail>).detail;
      if (!detail || detail.id !== sessionIdRef.current) return;
      setProject(detail.projectId ?? NO_PROJECT);
    };
    window.addEventListener(CHAT_PROJECT_CHANGED_EVENT, handleProjectChanged);
    return () =>
      window.removeEventListener(CHAT_PROJECT_CHANGED_EVENT, handleProjectChanged);
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

  // Drain the queue: once the run settles, auto-send the oldest queued turn.
  // Guarded on chatRunManager's own running flag (fresh, not the render's), so
  // dispatching the first turn — which flips running true synchronously — blocks
  // a second dispatch until the next run-end. dispatchTurn is read from a ref so
  // the effect needn't depend on it (it's redefined every render).
  const dispatchTurnRef = useRef(dispatchTurn);
  dispatchTurnRef.current = dispatchTurn;
  useEffect(() => {
    if (!historyReady || queuedTurns.length === 0 || running) return;
    if (chatRunManager.get(sessionIdRef.current)?.running) return;
    const [next, ...rest] = queuedTurns;
    setQueuedTurns(rest);
    void dispatchTurnRef.current({
      text: next.text,
      attachments: next.attachments,
    });
  }, [running, queuedTurns, historyReady]);

  /** Read picked/pasted/dropped files into staged attachments, enforcing caps.
   *  Reads happen BEFORE the state update so the setAttachments updater stays
   *  pure (no side effects) — otherwise React StrictMode's double-invocation
   *  would stage every file twice. */
  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    const added: ChatAttachment[] = [];
    for (const file of list) {
      const res = await readFileAttachment(file);
      // Explicit `=== false`: this repo compiles without strictNullChecks,
      // where a bare truthiness check does not narrow the union.
      if (res.ok === false) toast.error(res.error);
      else added.push(res.attachment);
    }
    if (added.length === 0) return;
    setAttachments((prev) => {
      const room = Math.max(0, ATTACHMENT_LIMITS.maxCount - prev.length);
      return [...prev, ...added.slice(0, room)];
    });
    // Cap warning outside the updater (fires once, not per StrictMode pass).
    if (attachments.length + added.length > ATTACHMENT_LIMITS.maxCount) {
      toast.error(`You can attach up to ${ATTACHMENT_LIMITS.maxCount} files.`);
    }
  }

  const removeAttachment = (id: string) =>
    setAttachments((prev) => prev.filter((a) => a.id !== id));

  // Whole-panel drag-and-drop. dragenter/dragleave fire for every child the
  // cursor crosses, so a depth counter tells "left the panel" apart from
  // "moved between children" — the overlay only hides at depth zero.
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);

  function handleDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(e: React.DragEvent) {
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    }
  }

  /** Start a fresh run for a turn (text + attachments), from the current feed. */
  async function dispatchTurn(turn: { text: string; attachments: ChatAttachment[] }) {
    statusRef.current = null; // the run's own lifecycle takes over from here
    // Sending makes this the open conversation; record that explicitly since
    // background saves never move the pointer.
    void window.easyhost.chatHistory.setActive(sessionIdRef.current);
    const baseFeed = feedRef.current;
    // Carry the current task list into the run so a "continue" turn keeps the
    // plan — the transcript sent to the model is text-only, todo items aren't.
    const currentTodos = baseFeed.find(
      (it): it is ChatTodoHistoryItem => it.kind === 'todos',
    )?.todos;
    const projectId =
      projectRef.current === NO_PROJECT ? null : projectRef.current;
    await chatRunManager.start({
      sessionId: sessionIdRef.current,
      baseItems: baseFeed,
      targetServerId: targetRef.current === ALL ? null : targetRef.current,
      projectId,
      createdAt: createdAtRef.current,
      attachments: turn.attachments,
      req: {
        messages: buildAgentMessages(baseFeed, turn.text || '(see attached)'),
        serverIds: targetRef.current === ALL ? undefined : [targetRef.current],
        projectId,
        todos: currentTodos?.length ? currentTodos : undefined,
        attachments: turn.attachments.length ? turn.attachments : undefined,
      },
      userEcho: turn.text,
    });
  }

  /**
   * Submit the composer. When the agent is idle this starts a run. When it's
   * running, FCode-style: 'steer' injects the message into the live run now,
   * 'queue' parks it above the composer to auto-send when the run finishes.
   */
  function submit(mode: TurnDispatchMode) {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const turn: QueuedTurn = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      text,
      attachments,
    };
    setInput('');
    setAttachments([]);
    if (!running) {
      void dispatchTurn({ text, attachments });
      return;
    }
    if (mode === 'steer') {
      void chatRunManager.steer(sessionIdRef.current, {
        text,
        attachments: attachments.length ? attachments : undefined,
      });
      return;
    }
    setQueuedTurns((q) => [...q, turn]);
  }

  const removeQueuedTurn = (id: string) =>
    setQueuedTurns((q) => q.filter((t) => t.id !== id));

  /** Restore a queued turn back into the composer for editing. */
  const editQueuedTurn = (turn: QueuedTurn) => {
    setInput(turn.text);
    setAttachments(turn.attachments);
    removeQueuedTurn(turn.id);
    inputRef.current?.focus();
  };

  /** Send a queued turn immediately: steer it into the live run (or dispatch
   *  if the agent is somehow already idle), then drop it from the queue. */
  const steerQueuedTurn = (turn: QueuedTurn) => {
    removeQueuedTurn(turn.id);
    if (running) {
      void chatRunManager.steer(sessionIdRef.current, {
        text: turn.text,
        attachments: turn.attachments.length ? turn.attachments : undefined,
      });
    } else {
      void dispatchTurn({ text: turn.text, attachments: turn.attachments });
    }
  };

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
    setAttachments([]);
    const id = loadSession(null);
    void window.easyhost.chatHistory.setActive(id);
    inputRef.current?.focus();
  }

  // Before the first message, the ChatGPT/Claude-style empty state centers
  // the composer vertically in the canvas instead of docking it to the
  // bottom edge under an empty transcript.
  const isEmptyConversation = feed.length === 0 && !running;

  const composer = (
    <form
      className={COMPOSER_COLUMN_FRAME_CLASS_NAME}
      onSubmit={(e) => {
        e.preventDefault();
        submit('queue');
      }}
    >
      {queuedTurns.length > 0 && (
        <ComposerQueuedHeader
          turns={queuedTurns}
          onSteer={steerQueuedTurn}
          onEdit={editQueuedTurn}
          onRemove={removeQueuedTurn}
        />
      )}
      <div className="mb-2 flex items-center gap-2">
        {/* The chat's scope is fixed by where it was started (a project folder
            or the global New chat) — shown as a plain label, never a picker.
            Filing a chat elsewhere stays a sidebar action ("Move to project"). */}
        <span
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 text-[11px] font-normal text-foreground"
          title={
            project === NO_PROJECT
              ? 'This chat spans all projects'
              : 'This chat is scoped to its project'
          }
        >
          <FolderIcon
            aria-hidden
            className="size-3.5 shrink-0 text-foreground"
          />
          {project === NO_PROJECT
            ? 'All projects'
            : (projects.find((p) => p.id === project)?.name ?? 'Project')}
        </span>
        {/* Server target picker only for unscoped chats. A project chat is
            already locked to its project's servers, so it has no picker — it
            runs against all of them. */}
        {project === NO_PROJECT && (
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
        )}
        <ModelOptionsMenu />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ATTACH_ACCEPT}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = ''; // allow re-picking the same file
        }}
      />

      {/* Drops are handled once at the panel root — a handler here too would
          stage every dropped file twice as the event bubbles. */}
      <div className="composer overflow-hidden">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-2.5">
            {attachments.map((att) => (
              <AttachmentChip
                key={att.id}
                attachment={att}
                onRemove={() => removeAttachment(att.id)}
              />
            ))}
          </div>
        )}
        <div className={COMPOSER_EDITOR_PADDING_CLASS_NAME}>
          <div className={COMPOSER_INPUT_ROW_CLASS_NAME}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-7 shrink-0 rounded-full text-muted-foreground"
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= ATTACHMENT_LIMITS.maxCount}
              aria-label="Attach files"
              title="Attach images or files"
            >
              <PaperclipIcon aria-hidden className="size-4" />
            </Button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  // While a run streams: Cmd/Ctrl+Enter steers it now,
                  // plain Enter queues for after it finishes (FCode model).
                  submit(e.metaKey || e.ctrlKey ? 'steer' : 'queue');
                }
              }}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files);
                if (files.length) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              placeholder={
                running
                  ? 'Queue a message (⌘↵ to steer now)…'
                  : 'Ask anything…'
              }
              autoFocus
              rows={1}
              data-slot="composer-input"
              className={COMPOSER_EDITOR_CLASS_NAME}
            />

            {/* While running: Stop is always available; a Queue button
                appears once there's something to send. Idle: just Send. */}
            {running && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="size-7 shrink-0 rounded-full text-muted-foreground"
                onClick={() => chatRunManager.cancel(sessionId)}
                aria-label="Stop generation"
                title="Stop the current agent run"
              >
                <span
                  aria-hidden="true"
                  className="block size-2 rounded-[2px] bg-current"
                />
              </Button>
            )}
            <Button
              type="submit"
              variant="prominent"
              size="icon-xs"
              className="size-7 shrink-0 rounded-full sm:size-7"
              disabled={!input.trim() && attachments.length === 0}
              aria-label={running ? 'Queue message' : 'Send message'}
              title={
                running
                  ? 'Queue this message (⌘↵ / Ctrl+↵ to steer the run now)'
                  : 'Send message'
              }
            >
              <ComposerSendArrowIcon aria-hidden className="size-5 shrink-0" />
            </Button>
          </div>
        </div>
      </div>
    </form>
  );

  return (
    <div
      className="relative flex h-full flex-col bg-background"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {draggingFiles && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-in bg-background/80 p-4 backdrop-blur-[2px] duration-150 fade-in-0">
          <div className="pop-in flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary/50 bg-primary/5">
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <PaperclipIcon aria-hidden className="size-5" />
            </span>
            <p className="text-sm font-medium text-ink">Drop files to attach</p>
            <p className="text-[11px] text-muted-foreground">
              Images and text files · up to {ATTACHMENT_LIMITS.maxCount} files
            </p>
          </div>
        </div>
      )}
      <header className="chat-surface-divider flex shrink-0 items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2.5">
          <img
            src={agentIcon}
            alt=""
            className="size-6 shrink-0 rounded-[7px]"
          />
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
            variant="destructive"
            size="icon-sm"
            onClick={() => setConfirmDelete(true)}
            disabled={running || feed.length === 0}
            aria-label="Delete this chat"
            title="Delete this chat from History"
          >
            <TrashIcon aria-hidden className="size-4" />
          </Button>
        </div>
      </header>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              This conversation will be removed from History permanently. This
              can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmDelete(false);
                void clearHistory();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isEmptyConversation ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 pb-24">
          <img
            src={agentIcon}
            alt=""
            className="mb-4 size-10 rounded-xl"
          />
          <h2 className="mb-1 text-sm font-semibold tracking-[-0.015em] text-ink">
            What can I help you with?
          </h2>
          <p className="mb-6 max-w-sm text-center text-xs leading-relaxed text-muted-foreground/70">
            Ask the agent to check on a server, deploy something, or fix an
            issue.
          </p>
          {composer}
        </div>
      ) : (
        <>
          <AgentFeed
            feed={feed}
            error={error}
            approval={approval}
            onApprove={(approved) =>
              void chatRunManager.respondApproval(sessionId, approved)
            }
            onSubmitForm={(formId, values) =>
              void chatRunManager.respondForm(sessionId, formId, values)
            }
            running={running}
            tokens={tokens}
          />
          <div className="bg-background px-4 pt-2 pb-4">{composer}</div>
        </>
      )}
    </div>
  );
}

/**
 * Queued-message header fused onto the top of the composer (FCode's
 * ComposerQueuedHeader): one row per message waiting to send after the run
 * finishes, each with Send-now (steer) / Edit / Delete.
 */
function ComposerQueuedHeader({
  turns,
  onSteer,
  onEdit,
  onRemove,
}: {
  turns: QueuedTurn[];
  onSteer: (turn: QueuedTurn) => void;
  onEdit: (turn: QueuedTurn) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="mb-2 overflow-hidden rounded-xl border border-border bg-secondary/40">
      <div className="flex items-center gap-1.5 px-3 pt-2 pb-1">
        <ClockIcon aria-hidden className="size-3 text-muted-foreground" />
        <span className="text-[10px] font-medium tracking-[0.03em] text-muted-foreground uppercase">
          {turns.length} queued · sends when the agent finishes
        </span>
      </div>
      <div className="divide-y divide-border/60">
        {turns.map((turn) => (
          <div key={turn.id} className="group/q flex items-center gap-2 px-3 py-2">
            <ComposerSendArrowIcon
              aria-hidden
              className="size-3.5 shrink-0 rotate-90 text-muted-foreground/60"
            />
            <span className="min-w-0 flex-1 truncate text-xs text-ink">
              {turn.text || '(attachment)'}
              {turn.attachments.length > 0 && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  · {turn.attachments.length} file
                  {turn.attachments.length === 1 ? '' : 's'}
                </span>
              )}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                onClick={() => onSteer(turn)}
                title="Send this now (steer the running agent)"
              >
                Send now
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px] text-muted-foreground"
                onClick={() => onEdit(turn)}
                title="Edit this queued message"
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="icon-sm"
                className="size-6"
                onClick={() => onRemove(turn.id)}
                aria-label="Remove queued message"
                title="Remove"
              >
                <XIcon aria-hidden className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** A staged attachment in the composer: image thumbnail or file glyph, name,
 *  size, and a remove button. */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  return (
    <div className="group/att relative flex items-center gap-2 rounded-lg border border-border bg-secondary/50 py-1 pl-1 pr-2">
      {attachment.kind === 'image' && attachment.dataUrl ? (
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="size-8 shrink-0 rounded-md object-cover"
        />
      ) : (
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
          <FileTextIcon aria-hidden className="size-4 text-muted-foreground" />
        </span>
      )}
      <div className="min-w-0">
        <p className="max-w-[10rem] truncate text-[11px] font-medium text-ink">
          {attachment.name}
        </p>
        <p className="text-[10px] text-muted-foreground">
          {formatBytes(attachment.size)}
        </p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${attachment.name}`}
        className="ml-0.5 rounded-full bg-destructive p-0.5 text-white transition-colors hover:bg-destructive/90"
      >
        <XIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
