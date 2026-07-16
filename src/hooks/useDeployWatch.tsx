/**
 * Ambient auto-deploy watcher.
 *
 * GitHub auto-deploys fire from cron ON THE SERVER — nothing in the app asks
 * for them. So unless the user happens to be sitting on a given server's
 * Deploys tab, a deploy can start, finish, or roll back without them ever
 * noticing. This provider closes that gap: it polls every CONNECTED server's
 * deploy-event stream in the background, exposes which servers are mid-deploy
 * (so the sidebar can badge them), and raises a toast on every new
 * start / success / failure / rollback.
 *
 * Only connected servers are polled — `deploys.list` runs a command over the
 * live SSH connection, and we never open a connection just to poll for deploys.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useServers } from '@/hooks/useServers';

/** Matches the Deploys tab: a 'start' older than this is a dead build (script
 *  crashed or the box rebooted before writing ok/failed), not a live one. */
const STALE_START_MS = 15 * 60_000;
/** Background poll cadence. Deploy cron runs at most once a minute and this is
 *  a cheap read, so a relaxed interval is plenty. */
const POLL_MS = 20_000;
/** Never toast an event older than this. Guards against a newly-registered or
 *  just-reconnected app dumping its stale history into toasts on first sight. */
const RECENT_EVENT_MS = 10 * 60_000;

type DeployWatchCtx = {
  /** Servers with a deploy currently in flight (a fresh 'start', no outcome
   *  yet) — the sidebar badges these. */
  deployingServerIds: Set<string>;
};

const Ctx = createContext<DeployWatchCtx | null>(null);

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** One evolving toast per app (keyed by server+app) so "Deploying…" is replaced
 *  in place by its outcome instead of stacking two toasts. */
function notifyDeploy(
  server: string,
  app: string,
  status: string,
  message: string,
): void {
  const id = `deploy:${server}:${app}`;
  const description = message || `on ${server}`;
  switch (status) {
    case 'start':
      // A plain (self-dismissing) toast, not toast.loading — a deploy that dies
      // without writing an outcome must not leave a spinner stuck forever.
      toast(`Deploying ${app}…`, { id, description });
      break;
    case 'ok':
      toast.success(`${app} deployed`, { id, description });
      break;
    case 'failed':
    case 'error':
      toast.error(`${app} deploy failed`, { id, description, duration: 10_000 });
      break;
    case 'rollback':
      toast.warning(`${app} rolled back`, { id, description, duration: 10_000 });
      break;
    default:
      // 'test' pings and any script-defined states stay silent.
      break;
  }
}

export function DeployWatchProvider({ children }: { children: ReactNode }) {
  const { servers, statuses } = useServers();
  const [deployingServerIds, setDeployingServerIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Newest event timestamp we've already reacted to, per `${serverId}::${app}`.
  const seenRef = useRef<Map<string, number>>(new Map());
  // Servers we've polled at least once — their existing history is recorded
  // silently so opening the app never replays old deploys as toasts.
  const seededRef = useRef<Set<string>>(new Set());
  // Server display names for toast copy, read without re-subscribing the poll.
  const nameRef = useRef<Record<string, string>>({});
  nameRef.current = Object.fromEntries(servers.map((s) => [s.id, s.name]));

  // Stable key of the connected set: the poll re-subscribes only when
  // membership actually changes, not on every unrelated status tick.
  const connectedKey = servers
    .filter((s) => statuses[s.id] === 'connected')
    .map((s) => s.id)
    .sort()
    .join(',');

  useEffect(() => {
    const connectedIds = connectedKey ? connectedKey.split(',') : [];
    if (connectedIds.length === 0) {
      setDeployingServerIds((prev) => (prev.size ? new Set() : prev));
      return;
    }
    let cancelled = false;

    const poll = async () => {
      const inFlight = new Set<string>();
      await Promise.all(
        connectedIds.map(async (serverId) => {
          let res;
          try {
            res = await window.easyhost.deploys.list(serverId);
          } catch {
            return;
          }
          if (cancelled || res.ok === false) return;
          const firstSight = !seededRef.current.has(serverId);
          for (const d of res.deployments) {
            const ev = d.lastEvent;
            if (!ev) continue;
            const key = `${serverId}::${d.app}`;
            if (ev.status === 'start' && Date.now() - ev.ts <= STALE_START_MS) {
              inFlight.add(serverId);
            }
            const prevTs = seenRef.current.get(key);
            if (prevTs !== undefined && ev.ts <= prevTs) continue; // already saw it
            seenRef.current.set(key, ev.ts);
            // First poll of a server just seeds baseline; only genuinely new,
            // recent events after that raise a toast.
            if (!firstSight && Date.now() - ev.ts <= RECENT_EVENT_MS) {
              notifyDeploy(
                nameRef.current[serverId] ?? 'A server',
                d.app,
                ev.status,
                ev.message,
              );
            }
          }
          seededRef.current.add(serverId);
        }),
      );
      if (!cancelled) {
        setDeployingServerIds((prev) =>
          setsEqual(prev, inFlight) ? prev : inFlight,
        );
      }
    };

    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [connectedKey]);

  const value = useMemo(() => ({ deployingServerIds }), [deployingServerIds]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDeployWatch(): DeployWatchCtx {
  return useContext(Ctx) ?? { deployingServerIds: new Set() };
}
