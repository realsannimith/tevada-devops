import { useEffect, useRef, useState, type MouseEvent } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import appIcon from "@/assets/app-icon.png";
import { SidebarLeadingIcon } from "@/components/SidebarLeadingIcon";
import { SidebarGlyph } from "@/components/sidebarGlyphs";
import { BrailleSpinner } from "@/components/chat/RunningStatus";
import { ThemeToggleButton } from "@/components/ThemeToggle";
import { useServers } from "@/hooks/useServers";
import { useProjects } from "@/hooks/useProjects";
import {
  CHAT_HISTORY_UPDATED_EVENT,
  CHAT_NEW_SESSION_EVENT,
  CHAT_SESSION_SWITCH_EVENT,
  SESSION_STATUS_META,
  WIZARD_SESSION_SWITCH_EVENT,
  summarizeChatHistory,
  type ChatHistorySummary,
} from "@/lib/chatHistory";
import { chatRunManager } from "@/lib/chatRunManager";
import {
  ChartBarIcon,
  ChevronRightIcon,
  ClockIcon,
  EllipsisIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  Loader2Icon,
  PencilIcon,
  PinFilledIcon,
  PinIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
  WizardsIcon,
  XIcon,
} from "@/lib/icons";
import { cn } from "@/lib/utils";
import type {
  ChatHistoryState,
  ConnStatus,
  Project,
  ServerWithStatus,
} from "@/shared/ipc-types";
import type { View } from "@/App";

const HISTORY_ALL = "__all__";
const HISTORY_NONE = "__none__";

/** Connection state shown by the terminal glyph itself — tint for terminal
 *  states, spinner while connecting. No floating dots (product decision). */
const STATUS_GLYPH_CLASS: Record<ConnStatus, string | undefined> = {
  connected: "text-success",
  connecting: "animate-spin text-warning",
  error: "text-destructive",
  disconnected: undefined,
};

export function ServerSidebar({
  view,
  onNavigate,
  onAddServer,
  onEditServer,
  onAddProject,
  onEditProject,
  onOpenSettings,
}: {
  view: View;
  onNavigate: (v: View) => void;
  onAddServer: () => void;
  onEditServer: (serverId: string) => void;
  onAddProject: () => void;
  onEditProject: (projectId: string) => void;
  onOpenSettings: () => void;
}) {
  const { servers, statusOf, connect, disconnect, remove, refresh } =
    useServers();
  const { projects, remove: removeProject } = useProjects();
  const [sessions, setSessions] = useState<ChatHistorySummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  // Wizard run last opened from History (the store's active pointer is chat-only).
  const [activeWizardSessionId, setActiveWizardSessionId] = useState<
    string | null
  >(null);
  // Session awaiting delete confirmation — drives the confirm dialog.
  const [pendingDelete, setPendingDelete] = useState<ChatHistorySummary | null>(
    null,
  );
  // Project awaiting delete confirmation.
  const [pendingProjectDelete, setPendingProjectDelete] =
    useState<Project | null>(null);
  // Server awaiting remove confirmation.
  const [pendingServerDelete, setPendingServerDelete] =
    useState<ServerWithStatus | null>(null);
  // History project filter: HISTORY_ALL, HISTORY_NONE, or a project id.
  const [historyFilter, setHistoryFilter] = useState<string>(HISTORY_ALL);
  // Project folders default to expanded; a project id lands here once collapsed.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );

  const toggleProjectCollapsed = (projectId: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const activeServerId = view.kind === "server" ? view.serverId : null;

  const projectById = (id: string | null) =>
    id ? (projects.find((p) => p.id === id) ?? null) : null;

  // Toggle a server's membership in a project (a server may be in several).
  const toggleServerProject = async (
    server: ServerWithStatus,
    projectId: string,
  ) => {
    const current = server.projectIds ?? [];
    const projectIds = current.includes(projectId)
      ? current.filter((id) => id !== projectId)
      : [...current, projectId];
    await window.easyhost.servers.update(server.id, { projectIds });
    await refresh();
  };

  const visibleSessions = sessions.filter((s) => {
    if (historyFilter === HISTORY_ALL) return true;
    if (historyFilter === HISTORY_NONE) return s.projectId === null;
    return s.projectId === historyFilter;
  });

  // Servers grouped for display: one bucket per project (a server appears under
  // every project it belongs to), plus an "Unassigned" bucket for the rest.
  const unassignedServers = servers.filter(
    (s) => !s.projectIds || s.projectIds.length === 0,
  );

  const renderServerRow = (s: ServerWithStatus) => {
    const status = statusOf(s.id);
    return (
      <div
        key={s.id}
        className={cn(
          "group flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors",
          activeServerId === s.id
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <SidebarLeadingIcon size="sm" className="relative">
          <SidebarGlyph
            icon={status === "connecting" ? Loader2Icon : TerminalIcon}
            variant="leading"
            className={STATUS_GLYPH_CLASS[status]}
          />
        </SidebarLeadingIcon>
        <button
          className="flex-1 truncate text-left"
          onClick={() =>
            onNavigate({ kind: "server", serverId: s.id, tab: "terminal" })
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
            {status === "connected" ? (
              <DropdownMenuItem onClick={() => disconnect(s.id)}>
                Disconnect
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => connect(s.id)}>
                Connect
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => onEditServer(s.id)}>
              Edit server
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onNavigate({
                  kind: "server",
                  serverId: s.id,
                  tab: "monitoring",
                })
              }
            >
              Monitoring
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                onNavigate({ kind: "server", serverId: s.id, tab: "artifacts" })
              }
            >
              Artifacts
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {projects.length === 0 ? (
              <DropdownMenuItem onClick={onAddProject}>
                New project…
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Projects</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuLabel>In projects</DropdownMenuLabel>
                  {projects.map((p) => (
                    <DropdownMenuCheckboxItem
                      key={p.id}
                      checked={s.projectIds?.includes(p.id) ?? false}
                      onSelect={(e) => {
                        e.preventDefault();
                        void toggleServerProject(s, p.id);
                      }}
                    >
                      {p.name}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={onAddProject}>
                    New project…
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setPendingServerDelete(s)}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

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
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      unsubChanged();
      window.removeEventListener(
        CHAT_HISTORY_UPDATED_EVENT,
        handleHistoryUpdated,
      );
      window.removeEventListener("focus", load);
    };
  }, []);

  /** Picking a saved session opens it in its own always-mounted view: chats
   *  hot-swap the ChatPanel (and move the store's active pointer), wizard runs
   *  open their transcript in the WizardsView. */
  const selectSession = (summary: ChatHistorySummary) => {
    if (summary.kind === "wizard") {
      onNavigate({ kind: "wizards" });
      setActiveWizardSessionId(summary.id);
      window.dispatchEvent(
        new CustomEvent(WIZARD_SESSION_SWITCH_EVENT, { detail: summary.id }),
      );
      return;
    }
    onNavigate({ kind: "chat" });
    window.dispatchEvent(
      new CustomEvent(CHAT_SESSION_SWITCH_EVENT, { detail: summary.id }),
    );
    void window.easyhost.chatHistory.setActive(summary.id);
  };

  /** Starts a fresh conversation — the current one stays saved in History. */
  const newChat = () => {
    onNavigate({ kind: "chat" });
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

  /** Actually removes a session — only ever called after the user confirms. */
  const deleteSession = async (summary: ChatHistorySummary) => {
    // Deleting a session with a background run also stops that run — otherwise
    // its next debounced save would resurrect the entry we just removed.
    if (summary.kind !== "wizard") chatRunManager.discard(summary.id);
    const saved = await window.easyhost.chatHistory.delete(summary.id);
    applyChatState(saved);
    if (summary.kind === "wizard") return;
    // If the deleted session was open in the ChatPanel, tell it to fall back
    // to whatever is now active (or a fresh draft if nothing is left).
    window.dispatchEvent(
      new CustomEvent(CHAT_SESSION_SWITCH_EVENT, {
        detail: saved.activeSessionId,
      }),
    );
  };

  const renameSession = async (summary: ChatHistorySummary, title: string) => {
    if (title.trim() === summary.title) return; // no-op rename
    const saved = await window.easyhost.chatHistory.rename(summary.id, title);
    applyChatState(saved);
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
          active={view.kind === "dashboard"}
          icon={<SidebarGlyph icon={ChartBarIcon} variant="leading" />}
          label="Dashboard"
          onClick={() => onNavigate({ kind: "dashboard" })}
        />
        <NavRow
          active={view.kind === "chat"}
          icon={<SidebarGlyph icon={PlusIcon} variant="leading" />}
          label="New chat"
          onClick={newChat}
        />
        <NavRow
          active={view.kind === "wizards"}
          icon={<SidebarGlyph icon={WizardsIcon} variant="leading" />}
          label="Wizards"
          onClick={() => onNavigate({ kind: "wizards" })}
        />
      </nav>

      {sessions.length > 0 && (
        <>
          <div className="no-drag mt-5 flex items-center justify-between px-4 pb-1">
            <span className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
              History
            </span>
            <div className="flex items-center gap-1">
              {projects.length > 0 && (
                <Select value={historyFilter} onValueChange={setHistoryFilter}>
                  <SelectTrigger
                    size="sm"
                    className="h-6 gap-1 border-none bg-transparent px-1 text-[10px] text-muted-foreground shadow-none hover:text-foreground"
                    aria-label="Filter history by project"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value={HISTORY_ALL}>All projects</SelectItem>
                    <SelectItem value={HISTORY_NONE}>No project</SelectItem>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <button
                onClick={newChat}
                className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                title="New chat"
              >
                <SidebarGlyph icon={PlusIcon} variant="chrome" />
              </button>
            </div>
          </div>
          <div className="no-drag max-h-48 space-y-0.5 overflow-y-auto px-2">
            {visibleSessions.length === 0 ? (
              <p className="px-2 py-2 text-[11px] text-muted-foreground">
                No chats in this project yet.
              </p>
            ) : (
              visibleSessions.map((summary) => (
                <HistoryRow
                  key={summary.id}
                  active={
                    summary.kind === "wizard"
                      ? view.kind === "wizards" &&
                        summary.id === activeWizardSessionId
                      : view.kind === "chat" && summary.id === activeSessionId
                  }
                  summary={summary}
                  project={projectById(summary.projectId)}
                  onClick={() => selectSession(summary)}
                  onTogglePin={(event) => togglePin(summary, event)}
                  onRename={(title) => void renameSession(summary, title)}
                  onDelete={() => setPendingDelete(summary)}
                />
              ))
            )}
          </div>
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{pendingDelete?.title}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.status === "running"
                ? "This conversation has a run still in progress — deleting it also stops that run. This can’t be undone."
                : "This conversation will be removed from History permanently. This can’t be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const summary = pendingDelete;
                setPendingDelete(null);
                if (summary) void deleteSession(summary);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingProjectDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingProjectDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete project “{pendingProjectDelete?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The project and its memory are removed. Its servers and chats are
              kept — they just lose this project tag. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const project = pendingProjectDelete;
                setPendingProjectDelete(null);
                if (project) {
                  if (historyFilter === project.id)
                    setHistoryFilter(HISTORY_ALL);
                  void removeProject(project.id);
                }
              }}
            >
              Delete project
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingServerDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingServerDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove “{pendingServerDelete?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This server is removed from EASY-HOST, including its saved
              connection details. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const server = pendingServerDelete;
                setPendingServerDelete(null);
                if (server) void remove(server.id);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="no-drag mt-5 flex items-center justify-between px-4 pb-1">
        <span className="text-[10px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
          Servers
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onAddProject}
            className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            title="New project"
          >
            <SidebarGlyph icon={FolderPlusIcon} variant="chrome" />
          </button>
          <button
            onClick={onAddServer}
            className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
            title="Add server"
          >
            <SidebarGlyph icon={PlusIcon} variant="chrome" />
          </button>
        </div>
      </div>

      <div className="no-drag flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {servers.length === 0 && projects.length === 0 && (
          <p className="px-2 py-3 text-[11px] leading-relaxed text-muted-foreground">
            No servers yet. Click + to add one, or the folder to group them into
            a project.
          </p>
        )}

        {projects.map((project) => {
          const members = servers.filter((s) =>
            s.projectIds?.includes(project.id),
          );
          const expanded = !collapsedProjects.has(project.id);
          return (
            <div key={project.id} className="pt-0.5">
              <ProjectHeader
                project={project}
                serverCount={members.length}
                expanded={expanded}
                onToggle={() => toggleProjectCollapsed(project.id)}
                onEdit={() => onEditProject(project.id)}
                onDelete={() => setPendingProjectDelete(project)}
                onFilterHistory={() => setHistoryFilter(project.id)}
              />
              {/* Members read as children of the folder: indented under the
                  folder glyph with a faint guide line, and hidden when the
                  folder is collapsed. */}
              {expanded && (
                <div className="ml-[15px] mt-0.5 space-y-0.5 border-l border-sidebar-border/70 pl-1.5">
                  {members.length === 0 ? (
                    <p className="px-2 py-1 text-[10px] text-muted-foreground/70">
                      No servers yet
                    </p>
                  ) : (
                    members.map(renderServerRow)
                  )}
                </div>
              )}
            </div>
          );
        })}

        {unassignedServers.length > 0 && (
          <div className="pt-0.5">
            {projects.length > 0 && (
              <div className="px-2 pt-1 pb-0.5">
                <span className="text-[10px] font-medium tracking-[0.03em] text-muted-foreground/70 uppercase">
                  Unassigned
                </span>
              </div>
            )}
            {unassignedServers.map(renderServerRow)}
          </div>
        )}
      </div>

      <div className="no-drag flex items-center gap-1 border-t border-sidebar-border p-2">
        <button
          onClick={onOpenSettings}
          className={cn(
            "flex h-7 flex-1 items-center gap-2 rounded-md px-2 text-xs transition-colors",
            view.kind === "settings"
              ? "bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <SidebarLeadingIcon
            size="sm"
            tone={view.kind === "settings" ? "text-inherit" : undefined}
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

/** A collapsible project header above its server group. Clicking it toggles
 *  the folder open/closed; a chevron + open/closed folder glyph advertise the
 *  state. Trailing actions menu handles edit memory / filter history / delete. */
function ProjectHeader({
  project,
  serverCount,
  expanded,
  onToggle,
  onEdit,
  onDelete,
  onFilterHistory,
}: {
  project: Project;
  serverCount: number;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onFilterHistory: () => void;
}) {
  return (
    <div className="group flex h-6 items-center gap-1 px-2">
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? "Collapse project" : "Expand project"}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform",
            expanded && "rotate-90",
          )}
        />
        {expanded ? (
          <FolderOpenIcon
            aria-hidden
            className="size-3.5 shrink-0"
            style={{ color: project.color ?? undefined }}
          />
        ) : (
          <FolderIcon
            aria-hidden
            className="size-3.5 shrink-0"
            style={{ color: project.color ?? undefined }}
          />
        )}
        <span className="flex-1 truncate text-[11px] font-semibold tracking-[-0.01em] text-foreground">
          {project.name}
        </span>
      </button>
      <span className="text-[10px] tabular-nums text-muted-foreground/70">
        {serverCount}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="rounded-sm p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100">
            <SidebarGlyph icon={EllipsisIcon} variant="chrome" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            Edit project &amp; memory
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onFilterHistory}>
            Show chats
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            Delete project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function HistoryRow({
  active,
  summary,
  project,
  onClick,
  onTogglePin,
  onRename,
  onDelete,
}: {
  active: boolean;
  summary: ChatHistorySummary;
  /** The tagged project (if any), for the row's chip. */
  project: Project | null;
  onClick: () => void;
  onTogglePin: (event: MouseEvent) => void;
  /** Commit an inline rename (already trimmed of the no-change case upstream). */
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  // Inline rename: the title swaps to an input; Enter/blur commits, Esc cancels.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = (event: MouseEvent) => {
    event.stopPropagation();
    setDraft(summary.title);
    setEditing(true);
    // Focus after the input mounts.
    window.setTimeout(() => inputRef.current?.select(), 0);
  };

  const commit = () => {
    setEditing(false);
    if (draft.trim()) onRename(draft);
  };

  return (
    <div
      className={cn(
        "group/history flex min-h-10 items-start gap-1 rounded-md px-2 py-1.5 transition-colors",
        active
          ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <button
        onClick={onClick}
        title={summary.title}
        disabled={editing}
        className="flex min-w-0 flex-1 items-start gap-2 text-left"
      >
        <SidebarLeadingIcon
          size="sm"
          tone={active ? "text-inherit" : undefined}
          className="relative"
        >
          {/* A running session announces itself with the same braille "dots"
              spinner the agent shows while generating — the leading glyph IS the
              loading indicator, so the status line below stays a plain label
              (no second spinner). */}
          {summary.status === "running" ? (
            <BrailleSpinner className="text-skill" />
          ) : (
            <SidebarGlyph
              icon={summary.kind === "wizard" ? WizardsIcon : ClockIcon}
              variant="leading"
            />
          )}
        </SidebarLeadingIcon>
        <span className="min-w-0 flex-1">
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              aria-label="Chat name"
              className="block w-full rounded-sm border border-border bg-background px-1 py-0.5 text-xs font-medium text-foreground outline-none focus:border-ring"
            />
          ) : (
            <span className="block truncate text-xs font-medium">
              {summary.title}
            </span>
          )}
          {project && (
            <span className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: project.color ?? "currentColor" }}
              />
              <span className="truncate">{project.name}</span>
            </span>
          )}
          {summary.status === "running" ? (
            <span className="block truncate text-[10px] text-muted-foreground">
              Running…
            </span>
          ) : summary.status &&
            (summary.kind === "wizard" || summary.status !== "done") ? (
            <SessionStatusLine status={summary.status} />
          ) : (
            <span className="block truncate text-[10px] text-muted-foreground">
              {summary.messageCount} saved message
              {summary.messageCount === 1 ? "" : "s"}
            </span>
          )}
        </span>
      </button>
      <div className="mt-0.5 flex shrink-0 items-start gap-0.5">
        <button
          onClick={startEditing}
          title="Rename this chat"
          aria-label="Rename this chat"
          className="rounded-sm p-0.5 text-muted-foreground/60 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/history:opacity-100"
        >
          <SidebarGlyph icon={PencilIcon} variant="chrome" />
        </button>
        <button
          onClick={onTogglePin}
          title={summary.pinned ? "Unpin this chat" : "Pin this chat"}
          aria-label={summary.pinned ? "Unpin this chat" : "Pin this chat"}
          aria-pressed={summary.pinned}
          className={cn(
            "rounded-sm p-0.5 transition-opacity hover:bg-accent hover:text-foreground",
            summary.pinned
              ? "text-foreground opacity-100"
              : "text-muted-foreground/60 opacity-0 focus-visible:opacity-100 group-hover/history:opacity-100",
          )}
        >
          <SidebarGlyph
            icon={summary.pinned ? PinFilledIcon : PinIcon}
            variant="chrome"
          />
        </button>
        <button
          onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}
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
        "flex h-7 items-center gap-2 rounded-md px-2 text-xs transition-colors",
        active
          ? "bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <SidebarLeadingIcon
        size="sm"
        tone={active ? "text-inherit" : undefined}
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
  status: NonNullable<ChatHistorySummary["status"]>;
}) {
  const meta = SESSION_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
      <Icon aria-hidden className={cn("size-2.5 shrink-0", meta.iconClass)} />
      {meta.label}
    </span>
  );
}
