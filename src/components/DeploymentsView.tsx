/**
 * Deploys tab — the in-app window onto GitHub auto-deploys. Everything here is
 * read over SSH from what the github-auto-deploy skill leaves on the server:
 * the registry (/etc/easyhost/deploys/*.json), the event stream the
 * easyhost-notify helper appends (/var/log/easyhost/deploy-events.jsonl),
 * each app's build log, and its env file. Refreshes itself while open — cron
 * deploys land within a minute of a push, so the tab should catch them
 * without babysitting.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { View } from '@/App';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useServers } from '@/hooks/useServers';
import { GithubIcon, TelegramIcon } from '@/lib/brand-icons';
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  Loader2Icon,
  PlayIcon,
  RefreshIcon,
  XIcon,
  type AppIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { DeployEvent, DeploymentInfo } from '@/shared/ipc-types';

/** Refresh cadence while the tab is open — deploy cron runs at most 1/min. */
const REFRESH_MS = 20_000;
/** …but while a deploy is in flight, or a log panel is on screen, tighten the
 *  loop so the user watches it happen (both probes are a cheap tail/cat). */
const LIVE_REFRESH_MS = 5_000;
const LOG_REFRESH_MS = 4_000;

/** Status glyph + tinted pill per deploy state — spinner while deploying,
 *  no bare dots anywhere (product decision, Render-badge style). */
type StatusMeta = {
  icon: AppIcon;
  iconCls: string;
  pill: string;
  label: string;
  spin?: boolean;
};

const STATUS_META: Record<string, StatusMeta> = {
  ok: {
    icon: CheckIcon,
    iconCls: 'text-success',
    pill: 'bg-success/10 text-success',
    label: 'deployed',
  },
  failed: {
    icon: XIcon,
    iconCls: 'text-destructive',
    pill: 'bg-destructive/10 text-destructive',
    label: 'failed',
  },
  error: {
    icon: AlertTriangleIcon,
    iconCls: 'text-destructive',
    pill: 'bg-destructive/10 text-destructive',
    label: 'error',
  },
  rollback: {
    icon: RefreshIcon,
    iconCls: 'text-warning',
    pill: 'bg-warning/10 text-warning',
    label: 'rolled back',
  },
  start: {
    icon: Loader2Icon,
    iconCls: 'text-primary',
    pill: 'bg-primary/10 text-primary',
    label: 'deploying…',
    spin: true,
  },
  test: {
    icon: CheckIcon,
    iconCls: 'text-muted-foreground/70',
    pill: 'bg-secondary text-muted-foreground',
    label: 'test ping',
  },
};

function statusMeta(status?: string): StatusMeta {
  return (
    (status && STATUS_META[status]) || {
      icon: ClockIcon,
      iconCls: 'text-muted-foreground/50',
      pill: 'bg-secondary text-muted-foreground',
      label: status ?? 'no deploys yet',
    }
  );
}

/** A build that runs longer than this is presumed dead (script crashed or the
 *  box rebooted before it could write ok/failed) — stop presenting it live. */
const STALE_START_MS = 15 * 60_000;

/**
 * A 'start' event only reads as in-progress while it is the NEWEST event and
 * recent. Every deploy logs start → ok/failed, so historical starts are just
 * "this is when it began" records — rendering them with a spinner makes a
 * finished deploy look forever stuck (real user confusion, 2026-07-05).
 */
function effectiveMeta(event: DeployEvent, newest: boolean): StatusMeta {
  if (
    event.status === 'start' &&
    (!newest || Date.now() - event.ts > STALE_START_MS)
  ) {
    return {
      icon: PlayIcon,
      iconCls: 'text-muted-foreground/60',
      pill: 'bg-secondary text-muted-foreground',
      label: 'started',
    };
  }
  return statusMeta(event.status);
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function DeploymentsView({
  serverId,
  onNavigate,
}: {
  serverId: string;
  onNavigate: (v: View) => void;
}) {
  const { statusOf } = useServers();
  const connected = statusOf(serverId) === 'connected';

  const [deployments, setDeployments] = useState<DeploymentInfo[] | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [telegramReady, setTelegramReady] = useState<boolean | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const seq = ++loadSeq.current;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await window.easyhost.deploys.list(serverId);
        if (seq !== loadSeq.current) return; // stale (server switched)
        // Explicit comparison: strictNullChecks is off in this repo, a bare
        // truthiness check does not narrow the union.
        if (res.ok === false) {
          if (!silent) setError(res.error);
        } else {
          setDeployments(res.deployments);
          setLoadedAt(res.ts);
          setError(null);
        }
      } catch {
        if (seq === loadSeq.current && !silent) setError('Load failed.');
      } finally {
        if (seq === loadSeq.current && !silent) setLoading(false);
      }
    },
    [serverId],
  );

  // Fresh server ⇒ fresh list.
  useEffect(() => {
    setDeployments(null);
    setLoadedAt(null);
    setError(null);
  }, [serverId]);

  useEffect(() => {
    if (connected && deployments === null && !loading) void load();
  }, [connected, deployments, loading, load]);

  // Keep the list live while the tab is open — pushes deploy from cron, not
  // us. While something is mid-deploy (fresh 'start' with no outcome yet),
  // poll fast so the status flips in near-realtime.
  const deployInFlight = (deployments ?? []).some(
    (d) =>
      d.lastEvent?.status === 'start' &&
      Date.now() - d.lastEvent.ts <= STALE_START_MS,
  );
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(
      () => void load(true),
      deployInFlight ? LIVE_REFRESH_MS : REFRESH_MS,
    );
    return () => clearInterval(t);
  }, [connected, load, deployInFlight]);

  useEffect(() => {
    window.easyhost.alerts
      .status()
      .then((s) => setTelegramReady(s.hasToken && !!s.config.chatId))
      .catch(() => setTelegramReady(null));
  }, [serverId]);

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connect this server to see its auto-deploys.
      </div>
    );
  }

  if (deployments === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        {error ? (
          <>
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => load()}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Loader2Icon className="size-4 animate-spin" />
            Reading deploy history…
          </>
        )}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-background p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            {deployments.length === 0
              ? 'No auto-deploys on this server yet.'
              : `${deployments.length} auto-deploy${deployments.length === 1 ? '' : 's'}`}
            {loadedAt && (
              <span>
                {' '}
                · updated{' '}
                {new Date(loadedAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
            {error && <span className="text-destructive"> · {error}</span>}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => load()}
            disabled={loading}
          >
            {loading && <Loader2Icon className="size-3.5 animate-spin" />}
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {telegramReady === false && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-secondary/40 px-4 py-3">
            <TelegramIcon className="size-4 shrink-0" style={{ color: '#26A5E4' }} />
            <p className="flex-1 text-xs text-muted-foreground">
              Connect a Telegram bot to get a message every time a deploy
              succeeds, fails or rolls back — even while this app is closed.
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2.5 text-[11px] text-muted-foreground"
              onClick={() => onNavigate({ kind: 'settings' })}
            >
              Settings → Alerts
            </Button>
          </div>
        )}

        {deployments.length === 0 ? (
          <div className="surface-panel p-6 text-center">
            <p className="text-[13px] font-medium text-ink">
              Nothing deploys automatically here yet.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Ask the agent to “deploy my GitHub repo with auto-deploy” — every
              push will then go live on its own and show up here.
            </p>
          </div>
        ) : (
          <div className="surface-panel divide-y divide-border">
            {deployments.map((d) => (
              <DeploymentRow key={d.app} serverId={serverId} deployment={d} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One deployment row (expandable: events, log)
// ---------------------------------------------------------------------------

function DeploymentRow({
  serverId,
  deployment: d,
}: {
  serverId: string;
  deployment: DeploymentInfo;
}) {
  const [open, setOpen] = useState(false);
  const status = d.lastEvent
    ? effectiveMeta(d.lastEvent, true)
    : statusMeta(undefined);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
          <GithubIcon aria-hidden className="size-[15px] shrink-0 text-ink" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-medium tracking-[-0.015em] text-ink">
              {d.app}
            </span>
            {d.branch && (
              <span className="rounded bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                {d.branch}
              </span>
            )}
            {d.port && (
              <span className="rounded bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                :{d.port}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {d.repo ?? d.dir ?? 'auto-deploy'}
            {d.lastEvent && (
              <span>
                {' '}
                · {d.lastEvent.message || statusMeta(d.lastEvent.status).label} ·{' '}
                {timeAgo(d.lastEvent.ts)}
              </span>
            )}
          </p>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
            status.pill,
          )}
        >
          <status.icon
            aria-hidden
            className={cn('size-3', status.spin && 'animate-spin')}
          />
          {status.label}
        </span>
        <ChevronRightIcon
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground/60 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border/60 bg-secondary/20 px-4 py-3">
          {/* Configure a project's .env from the Artifacts tab (the ".env"
              button on its container) — this tab stays focused on history. */}
          {d.events.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                Recent deploys
              </p>
              <div className="space-y-1">
                {d.events.slice(0, 10).map((e, i) => (
                  <EventLine key={`${e.ts}-${i}`} event={e} newest={i === 0} />
                ))}
              </div>
            </div>
          )}

          {d.log && <LogSection serverId={serverId} logPath={d.log} />}
        </div>
      )}
    </div>
  );
}

function EventLine({ event, newest }: { event: DeployEvent; newest: boolean }) {
  const meta = effectiveMeta(event, newest);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <meta.icon
        aria-hidden
        className={cn('size-3 shrink-0', meta.iconCls, meta.spin && 'animate-spin')}
      />
      <span className="shrink-0 font-medium text-ink">{meta.label}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">
        {event.message}
      </span>
      <span className="shrink-0 text-muted-foreground/60">
        {timeAgo(event.ts)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deploy log — searchable, reloads itself while visible
// ---------------------------------------------------------------------------

function LogSection({ serverId, logPath }: { serverId: string; logPath: string }) {
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [query, setQuery] = useState('');
  const preRef = useRef<HTMLPreElement | null>(null);

  const loadLog = useCallback(
    async (silent = false) => {
      if (!silent) setLogLoading(true);
      setLogError(null);
      try {
        const res = await window.easyhost.deploys.log(serverId, logPath);
        if (res.ok === false) setLogError(res.error);
        else setLog(res.content.trimEnd() || '(log is empty)');
      } catch {
        if (!silent) setLogError('Could not read the log.');
      } finally {
        if (!silent) setLogLoading(false);
      }
    },
    [serverId, logPath],
  );

  // The panel only exists while its row is expanded, so a tight tail loop is
  // fine — this is what makes the log read as realtime during a build.
  useEffect(() => {
    void loadLog();
    const t = setInterval(() => void loadLog(true), LOG_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadLog]);

  // Follow the tail (like `tail -f`) unless the user is searching.
  useEffect(() => {
    if (!query && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [log, query]);

  const shown = useMemo(() => {
    if (!log) return log;
    if (!query.trim()) return log;
    const q = query.toLowerCase();
    const lines = log.split('\n').filter((l) => l.toLowerCase().includes(q));
    return lines.length > 0 ? lines.join('\n') : `(no lines match "${query}")`;
  }, [log, query]);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="shrink-0 text-[11px] font-medium text-muted-foreground">
          Deploy log
          <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground/60">
            {logPath}
          </span>
        </p>
        <div className="flex items-center gap-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs…"
            spellCheck={false}
            className="h-6 w-44 text-[11px]"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px] text-muted-foreground"
            onClick={() => void loadLog()}
            disabled={logLoading}
          >
            {logLoading && <Loader2Icon className="size-3 animate-spin" />}
            Reload
          </Button>
        </div>
      </div>
      {logError ? (
        <p className="text-[11px] text-destructive">{logError}</p>
      ) : log === null ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : (
        <pre
          ref={preRef}
          className="max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
        >
          {shown}
        </pre>
      )}
    </div>
  );
}
