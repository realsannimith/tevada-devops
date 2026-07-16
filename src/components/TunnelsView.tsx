/**
 * Tunnels tab — local port forwards over this server's SSH connection
 * (`ssh -L` without the terminal). A running tunnel listens on
 * 127.0.0.1:<localPort> on THIS machine and forwards each connection to
 * <remoteHost>:<remotePort> as seen from the server, so a local-only database
 * is reachable by a desktop GUI without opening its port to the internet.
 * Configs persist; whether a tunnel runs is per-app-session state.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  CheckIcon,
  CopyIcon,
  NetworkIcon,
  PlusIcon,
  TrashIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { TunnelState } from '@/shared/ipc-types';

export function TunnelsView({ serverId }: { serverId: string }) {
  const [states, setStates] = useState<TunnelState[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void window.easyhost.tunnels.list().then(setStates);
    return window.easyhost.tunnels.onState(setStates);
  }, []);

  const mine = (states ?? []).filter((t) => t.config.serverId === serverId);

  async function toggle(state: TunnelState, on: boolean) {
    setBusyId(state.config.id);
    try {
      if (on) {
        const res = await window.easyhost.tunnels.start(state.config.id);
        if (res.ok === false) toast.error(res.error ?? 'Could not start the tunnel.');
      } else {
        await window.easyhost.tunnels.stop(state.config.id);
      }
    } finally {
      setBusyId(null);
    }
  }

  async function remove(state: TunnelState) {
    await window.easyhost.tunnels.remove(state.config.id);
  }

  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mx-auto grid max-w-3xl gap-4">
        <div>
          <h2 className="text-sm font-semibold tracking-[-0.015em] text-ink">
            SSH tunnels
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Forward a local port to a service on (or reachable from) this server
            — like <span className="font-mono">ssh -L</span>, without a
            terminal. Point your database GUI at the local address while the
            tunnel is running.
          </p>
        </div>

        {mine.length > 0 && (
          <div className="surface-panel divide-y divide-border">
            {mine.map((t) => (
              <TunnelRow
                key={t.config.id}
                state={t}
                busy={busyId === t.config.id}
                onToggle={(on) => void toggle(t, on)}
                onRemove={() => void remove(t)}
              />
            ))}
          </div>
        )}

        <AddTunnel serverId={serverId} />
      </div>
    </div>
  );
}

function TunnelRow({
  state,
  busy,
  onToggle,
  onRemove,
}: {
  state: TunnelState;
  busy: boolean;
  onToggle: (on: boolean) => void;
  onRemove: () => void;
}) {
  const { config, active, connections, error } = state;
  const localAddr = `127.0.0.1:${config.localPort}`;
  const [copied, setCopied] = useState(false);

  return (
    <div className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <NetworkIcon
          className={cn(
            'size-4 shrink-0',
            active ? 'text-success' : 'text-muted-foreground/60',
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-ink">
            {config.name || `${config.remoteHost}:${config.remotePort}`}
          </p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {localAddr} → {config.remoteHost}:{config.remotePort}
          </p>
        </div>
        {active && (
          <span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] text-success">
            {connections > 0
              ? `forwarding · ${connections} conn${connections === 1 ? '' : 's'}`
              : 'listening'}
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Copy local address"
          onClick={() => {
            void navigator.clipboard.writeText(localAddr);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? (
            <CheckIcon className="size-4 text-success" />
          ) : (
            <CopyIcon className="size-4" />
          )}
        </Button>
        <Switch
          checked={active}
          disabled={busy}
          onCheckedChange={onToggle}
          aria-label={`Run tunnel to ${config.remoteHost}:${config.remotePort}`}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Delete tunnel"
          onClick={onRemove}
        >
          <TrashIcon className="size-4" />
        </Button>
      </div>
      {error && (
        <p className="mt-1.5 text-[11px] leading-snug text-destructive">{error}</p>
      )}
    </div>
  );
}

function AddTunnel({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [localPort, setLocalPort] = useState('');
  const [remoteHost, setRemoteHost] = useState('127.0.0.1');
  const [remotePort, setRemotePort] = useState('');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const res = await window.easyhost.tunnels.save({
        serverId,
        name: name.trim() || undefined,
        localPort: Number(localPort),
        remoteHost: remoteHost.trim() || '127.0.0.1',
        remotePort: Number(remotePort),
      });
      if (res.ok === false) {
        toast.error(res.error);
        return;
      }
      setOpen(false);
      setName('');
      setLocalPort('');
      setRemoteHost('127.0.0.1');
      setRemotePort('');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div>
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <PlusIcon className="size-4" /> New tunnel
        </Button>
      </div>
    );
  }

  return (
    <div className="surface-panel grid gap-3 p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="grid gap-1">
          <span className="text-[11px] text-muted-foreground">Name (optional)</span>
          <Input
            placeholder="Postgres"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] text-muted-foreground">Local port</span>
          <Input
            type="number"
            inputMode="numeric"
            placeholder="5433"
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value)}
            className="h-8"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] text-muted-foreground">
            Remote host (from the server)
          </span>
          <Input
            placeholder="127.0.0.1"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
            className="h-8"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] text-muted-foreground">Remote port</span>
          <Input
            type="number"
            inputMode="numeric"
            placeholder="5432"
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
            className="h-8"
          />
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Keep the remote host <span className="font-mono">127.0.0.1</span> for a
        service bound to localhost on the server (the safe default for
        databases).
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void save()}
          disabled={saving || !localPort || !remotePort}
        >
          Save tunnel
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
