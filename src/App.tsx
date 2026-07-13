import { useState } from 'react';
import { ServersProvider, useServers } from '@/hooks/useServers';
import { ProjectsProvider, useProjects } from '@/hooks/useProjects';
import { ServerSidebar } from '@/components/ServerSidebar';
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
  | 'deploys';

export type View =
  | { kind: 'server'; serverId: string; tab: ServerTab }
  | { kind: 'dashboard' }
  | { kind: 'chat' }
  | { kind: 'wizards' }
  | { kind: 'settings' };

function Shell() {
  const { servers } = useServers();
  const { projects } = useProjects();
  const [view, setView] = useState<View>({ kind: 'chat' });
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
    setView({ kind: 'server', serverId, tab: 'terminal' });
  };

  const setServerDialogOpen = (open: boolean) => {
    if (open) return;
    setAddOpen(false);
    setEditingServerId(null);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Frameless titlebar: the whole top strip drags the window. */}
      <div className="drag-region fixed inset-x-0 top-0 z-50 h-8" />

      <ServerSidebar
        view={view}
        onNavigate={setView}
        onAddServer={openAddServer}
        onEditServer={openEditServer}
        onAddProject={openAddProject}
        onEditProject={openEditProject}
        onOpenSettings={() => setView({ kind: 'settings' })}
      />

      {/* Inset content card — floats with an even gutter on all sides so the
          frosted rail and the surface never crowd each other. */}
      <main className="flex-1 overflow-hidden p-1.5">
        <div className="h-full overflow-hidden rounded-2xl border border-border bg-background">
          {/* Chat and wizards stay mounted and are only hidden by CSS: their
              agent runs stream over IPC into component state, so unmounting
              them mid-run would drop the stream (and the composer draft) every
              time the user switches screens. */}
          <div className={view.kind === 'chat' ? 'h-full' : 'hidden'}>
            <ChatPanel />
          </div>
          <div className={view.kind === 'wizards' ? 'h-full' : 'hidden'}>
            <WizardsView />
          </div>
          {view.kind === 'dashboard' && <DashboardView onNavigate={setView} />}
          {view.kind === 'server' && (
            <ServerPane
              view={view}
              onNavigate={setView}
              onEditServer={openEditServer}
            />
          )}
          {view.kind === 'settings' && <SettingsView />}
        </div>
      </main>

      <ServerFormDialog
        open={serverDialogOpen}
        onOpenChange={setServerDialogOpen}
        server={editingServer}
      />

      <ProjectFormDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        project={editingProject}
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
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
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
          <Tabs
            value={view.tab}
            onValueChange={(t) =>
              onNavigate({
                kind: 'server',
                serverId: server.id,
                tab: t as ServerTab,
              })
            }
          >
            <TabsList>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
              <TabsTrigger value="files">Files</TabsTrigger>
              <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
              <TabsTrigger value="artifacts">Artifacts</TabsTrigger>
              <TabsTrigger value="deploys">Deploys</TabsTrigger>
            </TabsList>
          </Tabs>
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

      <div className="flex-1 overflow-hidden">
        {view.tab === 'terminal' ? (
          <TerminalView serverId={server.id} />
        ) : view.tab === 'files' ? (
          <FilesView serverId={server.id} />
        ) : view.tab === 'monitoring' ? (
          <MonitoringView serverId={server.id} />
        ) : view.tab === 'deploys' ? (
          <DeploymentsView serverId={server.id} onNavigate={onNavigate} />
        ) : (
          <ArtifactsView serverId={server.id} onNavigate={onNavigate} />
        )}
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
        <Shell />
      </ProjectsProvider>
    </ServersProvider>
  );
}
