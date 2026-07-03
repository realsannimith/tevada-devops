import {
  Server,
  Plus,
  MessageSquare,
  Wand2,
  Settings,
  Circle,
  MoreVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useServers } from '@/hooks/useServers';
import type { ConnStatus } from '@/shared/ipc-types';
import type { View } from '@/App';

const STATUS_COLOR: Record<ConnStatus, string> = {
  connected: 'text-green-500 fill-green-500',
  connecting: 'text-yellow-500 fill-yellow-500 animate-pulse',
  error: 'text-destructive fill-destructive',
  disconnected: 'text-muted-foreground fill-transparent',
};

export function ServerSidebar({
  view,
  onNavigate,
  onAddServer,
  onOpenSettings,
}: {
  view: View;
  onNavigate: (v: View) => void;
  onAddServer: () => void;
  onOpenSettings: () => void;
}) {
  const { servers, statusOf, connect, disconnect, remove } = useServers();

  const activeServerId = view.kind === 'server' ? view.serverId : null;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex items-center gap-2 px-4 py-4">
        <Server className="h-5 w-5 text-primary" />
        <span className="font-semibold tracking-tight">EASY-HOST</span>
      </div>

      <nav className="flex flex-col gap-1 px-2">
        <NavButton
          active={view.kind === 'chat'}
          icon={<MessageSquare className="h-4 w-4" />}
          label="AI Agent"
          onClick={() => onNavigate({ kind: 'chat' })}
        />
        <NavButton
          active={view.kind === 'wizards'}
          icon={<Wand2 className="h-4 w-4" />}
          label="Wizards"
          onClick={() => onNavigate({ kind: 'wizards' })}
        />
      </nav>

      <div className="mt-4 flex items-center justify-between px-4 pb-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Servers
        </span>
        <button
          onClick={onAddServer}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Add server"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto px-2">
        {servers.length === 0 && (
          <p className="px-2 py-4 text-xs text-muted-foreground">
            No servers yet. Click + to add one.
          </p>
        )}
        {servers.map((s) => {
          const status = statusOf(s.id);
          return (
            <div
              key={s.id}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                activeServerId === s.id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
              )}
            >
              <Circle className={cn('h-2.5 w-2.5', STATUS_COLOR[status])} />
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
                  <button className="rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100">
                    <MoreVertical className="h-4 w-4" />
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

      <div className="border-t p-2">
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 text-muted-foreground"
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" /> Settings
        </Button>
      </div>
    </aside>
  );
}

function NavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-2 text-sm',
        active
          ? 'bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
