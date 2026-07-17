import { useState } from 'react';
import { ServersProvider, useServers } from '@/hooks/useServers';
import { ProjectsProvider, useProjects } from '@/hooks/useProjects';
import { DeployWatchProvider } from '@/hooks/useDeployWatch';
import { ServerSidebar } from '@/components/ServerSidebar';
import { SessionTabStrip } from '@/components/SessionTabStrip';
import { ServerFormDialog } from '@/components/ServerFormDialog';
import { ProjectFormDialog } from '@/components/ProjectFormDialog';
import { SettingsView } from '@/components/SettingsView';
import { ChatPanel } from '@/components/ChatPanel';
import { DashboardView } from '@/components/DashboardView';
import { WizardsView } from '@/components/WizardsView';
import { TerminalView } from '@/components/TerminalView';
import { FilesView } from '@/components/FilesView';
import { MonitoringView } from '@/components/MonitoringView';
import { ArtifactsView } from '@/components/ArtifactsView';
import { DeploymentsView } from '@/components/DeploymentsView';
import { TunnelsView } from '@/components/TunnelsView';
import { Button } from '@/components/ui/button';
import {
  AlertTriangleIcon,
  CheckIcon,
  Loader2Icon,
  WifiIcon,
  WifiOffIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { ConnStatus } from '@/shared/ipc-types';

export type ServerTab =
  | 'terminal'
  | 'files'
  | 'monitoring'
  | 'artifacts'
  | 'deploys'
  | 'tunnels';

const SERVER_TAB_ITEMS: { value: ServerTab; label: string }[] = [
  { value: 'terminal', label: 'Terminal' },
  { value: 'files', label: 'Files' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'artifacts', label: 'Artifacts' },
  { value: 'deploys', label: 'Deploys' },
  { value: 'tunnels', label: 'Tunnels' },
];

export type View =
  | { kind: 'server'; serverId: string; tab: ServerTab }
  | { kind: 'dashboard' }
  | { kind: 'chat' }
  | { kind: 'wizards' }
  | { kind: 'settings' };

/** An open host session in the Termius-style tab row. Remembers which feature
 *  tab (terminal/files/…) was active so refocusing restores the user's place. */
type SessionTab = { serverId: string; tab: ServerTab };

function Shell() {
  const { servers, statusOf } = useServers();
  const { projects } = useProjects();
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [sessionTabs, setSessionTabs] = useState<SessionTab[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string | null>(null);
  const editingServer = editingServerId
    ? servers.find((server) => server.id === editingServerId)
    : null;
  const serverDialogOpen = addOpen || Boolean(editingServer);

  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const editingProject = editingProjectId
    ? projects.find((p) => p.id === editingProjectId)
    : null;
  const projectDialogOpen = addProjectOpen || Boolean(editingProject);

  /** All navigation funnels through here so opening a server (from the
   *  sidebar, dashboard, deploys, …) registers/refreshes its session tab. */
  const navigate = (v: View) => {
    if (v.kind === 'server') {
      setSessionTabs((prev) => {
        const i = prev.findIndex((t) => t.serverId === v.serverId);
        if (i === -1) return [...prev, { serverId: v.serverId, tab: v.tab }];
        const next = [...prev];
        next[i] = { serverId: v.serverId, tab: v.tab };
        return next;
      });
    }
    setView(v);
  };

  /** Close a session tab (the SSH connection is left as-is — reopening the
   *  host reattaches to the live terminal). Focus falls to the neighbor tab. */
  const closeSessionTab = (serverId: string) => {
    const idx = sessionTabs.findIndex((t) => t.serverId === serverId);
    const next = sessionTabs.filter((t) => t.serverId !== serverId);
    setSessionTabs(next);
    if (view.kind === 'server' && view.serverId === serverId) {
      const neighbor = next[Math.min(idx, next.length - 1)];
      setView(
        neighbor
          ? { kind: 'server', serverId: neighbor.serverId, tab: neighbor.tab }
          : { kind: 'chat' },
      );
    }
  };

  // Tabs for servers that were deleted while open would 404; drop them here.
  const tabItems = sessionTabs.flatMap((t) => {
    const server = servers.find((s) => s.id === t.serverId);
    if (!server) return [];
    return [
      {
        id: server.id,
        name: server.name,
        status: statusOf(server.id),
        active: view.kind === 'server' && view.serverId === server.id,
      },
    ];
  });

  const openAddProject = () => {
    setEditingProjectId(null);
    setAddProjectOpen(true);
  };
  const openEditProject = (projectId: string) => {
    setAddProjectOpen(false);
    setEditingProjectId(projectId);
  };
  const setProjectDialogOpen = (open: boolean) => {
    if (open) return;
    setAddProjectOpen(false);
    setEditingProjectId(null);
  };

  const openAddServer = () => {
    setEditingServerId(null);
    setAddOpen(true);
  };

  const openEditServer = (serverId: string) => {
    setAddOpen(false);
    setEditingServerId(serverId);
    navigate({ kind: 'server', serverId, tab: 'terminal' });
  };

  const setServerDialogOpen = (open: boolean) => {
    if (open) return;
    setAddOpen(false);
    setEditingServerId(null);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ServerSidebar
        view={view}
        onNavigate={navigate}
        onAddServer={openAddServer}
        onEditServer={openEditServer}
        onAddProject={openAddProject}
        onEditProject={openEditProject}
        onOpenSettings={() => setView({ kind: 'settings' })}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Termius-style session tabs. The strip is also the frameless
            titlebar's drag surface for the content column (the sidebar drags
            itself), replacing the old full-width overlay that swallowed
            clicks along the top edge. */}
        <SessionTabStrip
          items={tabItems}
          onSelect={(serverId) => {
            const tab = sessionTabs.find((t) => t.serverId === serverId);
            navigate({ kind: 'server', serverId, tab: tab?.tab ?? 'terminal' });
          }}
          onClose={closeSessionTab}
          onNewSession={() => navigate({ kind: 'dashboard' })}
        />

        {/* Inset content card — floats with an even gutter (the tab strip
            provides the top gap) so the frosted rail and the surface never
            crowd each other. */}
        <main className="flex-1 overflow-hidden px-1.5 pb-1.5">
          <div className="h-full overflow-hidden rounded-2xl border border-border bg-background">
            {/* Chat and wizards stay mounted and are only hidden by CSS: their
                agent runs stream over IPC into component state, so unmounting
                them mid-run would drop the stream (and the composer draft)
                every time the user switches screens. */}
            <div className={view.kind === 'chat' ? 'h-full' : 'hidden'}>
              <ChatPanel />
            </div>
            <div className={view.kind === 'wizards' ? 'h-full' : 'hidden'}>
              <WizardsView />
            </div>
            {view.kind === 'dashboard' && (
              <div className="view-enter h-full">
                <DashboardView onNavigate={navigate} />
              </div>
            )}
            {view.kind === 'server' && (
              <div key={view.serverId} className="view-enter h-full">
                <ServerPane
                  view={view}
                  onNavigate={navigate}
                  onEditServer={openEditServer}
                />
              </div>
            )}
            {view.kind === 'settings' && (
              <div className="view-enter h-full">
                <SettingsView />
              </div>
            )}
          </div>
        </main>
      </div>

      <ServerFormDialog
        open={serverDialogOpen}
        onOpenChange={setServerDialogOpen}
        server={editingServer}
      />

      <ProjectFormDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        project={editingProject}
        onAddServer={openAddServer}
      />
    </div>
  );
}

function ServerPane({
  view,
  onNavigate,
  onEditServer,
}: {
  view: Extract<View, { kind: 'server' }>;
  onNavigate: (v: View) => void;
  onEditServer: (serverId: string) => void;
}) {
  const { servers, statusOf, errorOf, connect, disconnect } = useServers();
  const server = servers.find((s) => s.id === view.serverId);
  if (!server) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Server not found.
      </div>
    );
  }
  const status = statusOf(server.id);
  const error = errorOf(server.id);
  const connected = status === 'connected';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-2.5">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-semibold tracking-[-0.015em] text-ink">
                {server.name}
              </h1>
              <ConnStatusPill status={status} />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              {server.username}@{server.host}:{server.port}
            </p>
            {status === 'error' && error && (
              <div className="mt-1 flex max-w-xl flex-wrap items-center gap-2">
                <p className="text-[11px] leading-snug text-destructive">
                  {error}
                </p>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onEditServer(server.id)}
                >
                  Update credentials
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnect(server.id)}
            >
              <WifiOffIcon className="size-4" /> Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => connect(server.id)}
              disabled={status === 'connecting'}
            >
              <WifiIcon className="size-4" />
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </Button>
          )}
        </div>
      </header>

      {/* Underline tab row (the header's divider doubles as its baseline) —
          full-width with a 2px accent on the active tab, instead of the old
          pill TabsList squeezed into the header. */}
      <nav role="tablist" className="flex shrink-0 gap-1 border-b border-border px-3">
        {SERVER_TAB_ITEMS.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={view.tab === value}
            onClick={() =>
              onNavigate({ kind: 'server', serverId: server.id, tab: value })
            }
            className={cn(
              '-mb-px border-b-2 px-2.5 py-2 text-xs transition-colors',
              view.tab === value
                ? 'border-primary text-ink'
                : 'border-transparent text-muted-foreground hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-hidden">
        {/* Keyed so each tab switch replays the soft entrance. */}
        <div key={view.tab} className="view-enter h-full">
          {view.tab === 'terminal' ? (
            <TerminalView serverId={server.id} />
          ) : view.tab === 'files' ? (
            <FilesView serverId={server.id} />
          ) : view.tab === 'monitoring' ? (
            <MonitoringView serverId={server.id} />
          ) : view.tab === 'deploys' ? (
            <DeploymentsView serverId={server.id} onNavigate={onNavigate} />
          ) : view.tab === 'tunnels' ? (
            <TunnelsView serverId={server.id} />
          ) : (
            <ArtifactsView serverId={server.id} onNavigate={onNavigate} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Render-style connection badge ("✓ Connected") — replaces the old status
 *  dot; working states get a spinner instead of a pulse. */
const CONN_PILL: Record<
  ConnStatus,
  { label: string; cls: string; icon?: typeof CheckIcon; spin?: boolean }
> = {
  connected: { label: 'Connected', cls: 'bg-success/10 text-success', icon: CheckIcon },
  connecting: {
    label: 'Connecting…',
    cls: 'bg-warning/10 text-warning',
    icon: Loader2Icon,
    spin: true,
  },
  error: { label: 'Error', cls: 'bg-destructive/10 text-destructive', icon: AlertTriangleIcon },
  disconnected: { label: 'Offline', cls: 'bg-secondary text-muted-foreground' },
};

function ConnStatusPill({ status }: { status: ConnStatus }) {
  const meta = CONN_PILL[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
        meta.cls,
      )}
    >
      {Icon && (
        <Icon aria-hidden className={cn('size-3', meta.spin && 'animate-spin')} />
      )}
      {meta.label}
    </span>
  );
}

export default function App() {
  return (
    <ServersProvider>
      <ProjectsProvider>
        <DeployWatchProvider>
          <Shell />
        </DeployWatchProvider>
      </ProjectsProvider>
    </ServersProvider>
  );
}
