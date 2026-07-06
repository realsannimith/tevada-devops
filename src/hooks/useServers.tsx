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
import { toast } from 'sonner';
import type { ConnStatus, ServerWithStatus } from '@/shared/ipc-types';

type NewProfile = Omit<ServerWithStatus, 'id' | 'createdAt' | 'status'>;

type ServersCtx = {
  servers: ServerWithStatus[];
  statuses: Record<string, ConnStatus>;
  errors: Record<string, string>;
  statusOf: (serverId: string) => ConnStatus;
  errorOf: (serverId: string) => string | undefined;
  refresh: () => Promise<void>;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  disconnect: (serverId: string) => Promise<void>;
  remove: (serverId: string) => Promise<void>;
};

const Ctx = createContext<ServersCtx | null>(null);

export function ServersProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<ServerWithStatus[]>([]);
  const [statuses, setStatuses] = useState<Record<string, ConnStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    const unsub = window.easyhost.ssh.onStatus(({ serverId, status, error }) => {
      setStatuses((prev) => ({ ...prev, [serverId]: status }));
      setErrors((prev) => {
        if (status !== 'error') {
          const { [serverId]: _removed, ...rest } = prev;
          return rest;
        }
        return { ...prev, [serverId]: error ?? 'Connection failed.' };
      });
    });
    return unsub;
  }, [refresh]);

  const connect = useCallback(async (serverId: string) => {
    setErrors((prev) => {
      const { [serverId]: _removed, ...rest } = prev;
      return rest;
    });
    try {
      const result = await window.easyhost.ssh.connect(serverId);
      if (!result.ok) {
        const error = result.error ?? 'Connection failed.';
        setErrors((prev) => ({ ...prev, [serverId]: error }));
        toast.error('Could not connect to server', { description: error });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatuses((prev) => ({ ...prev, [serverId]: 'error' }));
      setErrors((prev) => ({ ...prev, [serverId]: message }));
      toast.error('Could not connect to server', { description: message });
      return { ok: false, error: message };
    }
  }, []);
  const disconnect = useCallback(async (serverId: string) => {
    await window.easyhost.ssh.disconnect(serverId);
    setErrors((prev) => {
      const { [serverId]: _removed, ...rest } = prev;
      return rest;
    });
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
  const errorOf = useCallback(
    (serverId: string) => errors[serverId],
    [errors],
  );

  const value = useMemo(
    () => ({
      servers,
      statuses,
      errors,
      statusOf,
      errorOf,
      refresh,
      connect,
      disconnect,
      remove,
    }),
    [servers, statuses, errors, statusOf, errorOf, refresh, connect, disconnect, remove],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServers(): ServersCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useServers must be used within ServersProvider');
  return ctx;
}

export type { NewProfile };
