import { useState } from 'react';
import { Wifi, WifiOff } from 'lucide-react';
import { ServersProvider, useServers } from '@/hooks/useServers';
import { ServerSidebar } from '@/components/ServerSidebar';
import { ServerFormDialog } from '@/components/ServerFormDialog';
import { SettingsDialog } from '@/components/SettingsDialog';
import { ChatPanel } from '@/components/ChatPanel';
import { WizardsView } from '@/components/WizardsView';
import { TerminalView } from '@/components/TerminalView';
import { MonitoringView } from '@/components/MonitoringView';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';

export type View =
  | { kind: 'server'; serverId: string; tab: 'terminal' | 'monitoring' }
  | { kind: 'chat' }
  | { kind: 'wizards' };

function Shell() {
  const [view, setView] = useState<View>({ kind: 'chat' });
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <ServerSidebar
        view={view}
        onNavigate={setView}
        onAddServer={() => setAddOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="flex-1 overflow-hidden">
        {view.kind === 'chat' && <ChatPanel />}
        {view.kind === 'wizards' && <WizardsView />}
        {view.kind === 'server' && (
          <ServerPane view={view} onNavigate={setView} />
        )}
      </main>

      <ServerFormDialog open={addOpen} onOpenChange={setAddOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}

function ServerPane({
  view,
  onNavigate,
}: {
  view: Extract<View, { kind: 'server' }>;
  onNavigate: (v: View) => void;
}) {
  const { servers, statusOf, connect, disconnect } = useServers();
  const server = servers.find((s) => s.id === view.serverId);
  if (!server) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Server not found.
      </div>
    );
  }
  const status = statusOf(server.id);
  const connected = status === 'connected';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{server.name}</h1>
          <p className="text-xs text-muted-foreground">
            {server.username}@{server.host}:{server.port} · {status}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs
            value={view.tab}
            onValueChange={(t) =>
              onNavigate({
                kind: 'server',
                serverId: server.id,
                tab: t as 'terminal' | 'monitoring',
              })
            }
          >
            <TabsList>
              <TabsTrigger value="terminal">Terminal</TabsTrigger>
              <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            </TabsList>
          </Tabs>
          {connected ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => disconnect(server.id)}
            >
              <WifiOff className="h-4 w-4" /> Disconnect
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => connect(server.id)}
              disabled={status === 'connecting'}
            >
              <Wifi className="h-4 w-4" />
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-hidden">
        {view.tab === 'terminal' ? (
          <TerminalView serverId={server.id} />
        ) : (
          <MonitoringView serverId={server.id} />
        )}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ServersProvider>
      <Shell />
    </ServersProvider>
  );
}
