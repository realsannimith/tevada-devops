/**
 * Shared server state: the profile list plus live connection statuses. Statuses
 * arrive both from the initial list() and from the ssh:status event stream.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ConnStatus, ServerWithStatus } from '@/shared/ipc-types';

type NewProfile = Omit<ServerWithStatus, 'id' | 'createdAt' | 'status'>;

type ServersCtx = {
  servers: ServerWithStatus[];
  statuses: Record<string, ConnStatus>;
  statusOf: (serverId: string) => ConnStatus;
  refresh: () => Promise<void>;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  disconnect: (serverId: string) => Promise<void>;
  remove: (serverId: string) => Promise<void>;
};

const Ctx = createContext<ServersCtx | null>(null);

export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerWithStatus[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ConnStatus>>({});

  const refresh = useCallback(async () => {
    const list = await window.easyhost.servers.list();
    setServers(list);
    setStatuses((prev) => {
      const next = { ...prev };
      for (const s of list) if (!(s.id in next)) next[s.id] = s.status;
      return next;
    });
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = window.easyhost.ssh.onStatus(({ serverId, status }) => {
      setStatuses((prev) => ({ ...prev, [serverId]: status }));
    });
    return unsub;
  }, [refresh]);

  const connect = useCallback(
    (serverId: string) => window.easyhost.ssh.connect(serverId),
    [],
  );
  const disconnect = useCallback(async (serverId: string) => {
    await window.easyhost.ssh.disconnect(serverId);
  }, []);
  const remove = useCallback(
    async (serverId: string) => {
      await window.easyhost.servers.remove(serverId);
      await refresh();
    },
    [refresh],
  );

  const statusOf = useCallback(
    (serverId: string) => statuses[serverId] ?? 'disconnected',
    [statuses],
  );

  const value = useMemo(
    () => ({
      servers,
      statuses,
      statusOf,
      refresh,
      connect,
      disconnect,
      remove,
    }),
    [servers, statuses, statusOf, refresh, connect, disconnect, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServers(): ServersCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useServers must be used within ServersProvider');
  return ctx;
}

export type { NewProfile };
