/**
 * Artifacts tab — the "what is actually running on this server" inventory.
 * One SSH probe (main/artifacts.ts) discovers hosted sites, containers,
 * databases, services and cron backups; this view groups them with the same
 * brand glyphs the wizards use so a Postgres container reads as Postgres.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { View } from '@/App';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DatabaseCredentialDialog,
  type CredentialDialogTarget,
} from '@/components/DatabaseCredentialDialog';
import { EnvFileDialog, type EnvTarget } from '@/components/EnvFileDialog';
import { useServers } from '@/hooks/useServers';
import {
  CHAT_PREFILL_EVENT,
  WIZARD_LAUNCH_EVENT,
  type ChatPrefillDetail,
  type WizardLaunchDetail,
} from '@/lib/chatHistory';
import {
  ArchiveIcon,
  DatabaseIcon,
  DockerIcon,
  MariadbIcon,
  MongodbIcon,
  MysqlIcon,
  NodejsIcon,
  PostgresqlIcon,
  RedisIcon,
  WorldIcon,
} from '@/lib/brand-icons';
import {
  AlertTriangleIcon,
  ClockIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  KeyIcon,
  Loader2Icon,
  PlayIcon,
  RefreshIcon,
  SettingsIcon,
  StopIcon,
  TerminalIcon,
  WifiIcon,
  type AppIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type {
  ArtifactAction,
  ArtifactKind,
  ArtifactRuntime,
  ArtifactStatus,
  DatabaseCredentialMeta,
  DeploymentInfo,
  ServerArtifact,
} from '@/shared/ipc-types';

/** Maps a scanner-reported engine key back to the label the "Allow remote
 *  database access" wizard's engine select expects (see agent/playbooks.ts). */
const ENGINE_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  redis: 'Redis',
  mongodb: 'MongoDB',
};

const ENGINE_GLYPHS: Record<string, { icon: AppIcon; color?: string }> = {
  postgresql: { icon: PostgresqlIcon, color: '#4169E1' },
  mysql: { icon: MysqlIcon, color: '#F29111' },
  mariadb: { icon: MariadbIcon, color: '#003545' },
  redis: { icon: RedisIcon, color: '#FF4438' },
  mongodb: { icon: MongodbIcon, color: '#47A248' },
  docker: { icon: DockerIcon, color: '#2496ED' },
  node: { icon: NodejsIcon, color: '#5FA04E' },
  web: { icon: WorldIcon },
};

const KIND_GLYPHS: Record<ArtifactKind, AppIcon> = {
  website: WorldIcon,
  container: DockerIcon,
  database: DatabaseIcon,
  service: SettingsIcon,
  backup: ArchiveIcon,
};

const SECTIONS: Array<{ kind: ArtifactKind; title: string; blurb: string }> = [
  { kind: 'website', title: 'Websites', blurb: 'nginx sites & reverse proxies' },
  { kind: 'container', title: 'Containers', blurb: 'docker' },
  { kind: 'database', title: 'Databases', blurb: 'native & containerized' },
  { kind: 'service', title: 'Services', blurb: 'systemd units' },
  { kind: 'backup', title: 'Backups', blurb: 'scheduled cron jobs' },
];

/** Fallback when a native install's port didn't show up in the ss probe. */
const DEFAULT_PORTS: Record<string, number> = {
  postgresql: 5432,
  mysql: 3306,
  mariadb: 3306,
  redis: 6379,
  mongodb: 27017,
};

/** Status glyph + word — no bare dots (product decision). */
const STATUS_META: Record<
  ArtifactStatus,
  { icon: AppIcon; cls: string; label: string }
> = {
  running: { icon: PlayIcon, cls: 'text-success', label: 'running' },
  stopped: { icon: StopIcon, cls: 'text-muted-foreground/60', label: 'stopped' },
  scheduled: { icon: ClockIcon, cls: 'text-primary', label: 'scheduled' },
  unknown: { icon: EllipsisIcon, cls: 'text-muted-foreground/50', label: 'unknown' },
};

/** Rescan cadence while the tab is open — containers started/stopped outside
 *  the app (agent runs, cron deploys) should show up without babysitting. */
const AUTO_RESCAN_MS = 60_000;

/** What can start/stop/tail this artifact — from the scanner's id scheme
 *  ("container:<name>:<i>" / "service:<unit>"); websites & backups get null. */
function runtimeOf(a: ServerArtifact): ArtifactRuntime | null {
  if (a.id.startsWith('container:')) return 'container';
  if (a.id.startsWith('service:')) return 'service';
  return null;
}

/** Best URL for a website artifact: its server_name when it's a real domain,
 *  otherwise the server's address; https only when 443 is in its listen set. */
function websiteUrl(
  a: ServerArtifact,
  serverHost: string | undefined,
): string | null {
  if (a.kind !== 'website') return null;
  const domainish = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(
    a.name,
  );
  const host = domainish ? a.name : serverHost;
  if (!host) return null;
  const ports = a.ports ?? [];
  if (ports.includes(443)) return `https://${host}`;
  if (ports.includes(80) || ports.length === 0) return `http://${host}`;
  return `http://${host}:${ports[0]}`;
}

export function ArtifactsView({
  serverId,
  onNavigate,
}: {
  serverId: string;
  onNavigate: (v: View) => void;
}) {
  const { servers, statusOf } = useServers();
  const server = servers.find((s) => s.id === serverId);
  const connected = statusOf(serverId) === 'connected';

  const [artifacts, setArtifacts] = useState<ServerArtifact[] | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanSeq = useRef(0);
  // Saved by the setup-database wizard — matched onto database artifacts by
  // engine + port so "View credentials" only shows up where we actually have
  // something saved.
  const [credentials, setCredentials] = useState<DatabaseCredentialMeta[]>([]);
  const [dialogTarget, setDialogTarget] = useState<CredentialDialogTarget | null>(null);
  // Apps registered as deployments (name → its registry entry). Containers
  // deployed by the app carry the app's name, so a match means this artifact's
  // project can be configured right here via the .env dialog.
  const [deployByApp, setDeployByApp] = useState<Map<string, DeploymentInfo>>(
    new Map(),
  );
  const [envTarget, setEnvTarget] = useState<EnvTarget | null>(null);
  // Rows with their logs panel expanded (artifact ids) + the one row action
  // currently in flight — one at a time keeps the SSH exec channel calm.
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set());
  const [acting, setActing] = useState<{
    id: string;
    action: ArtifactAction;
  } | null>(null);

  const loadDeployments = useCallback(() => {
    window.easyhost.deploys
      .list(serverId)
      .then((res): void => {
        if (res.ok === false) return;
        setDeployByApp(new Map(res.deployments.map((d) => [d.app, d])));
      })
      .catch((): void => undefined);
  }, [serverId]);

  useEffect(() => {
    setDeployByApp(new Map());
    loadDeployments();
  }, [serverId, loadDeployments]);

  // Open the .env editor for a project, resolving its env-file path (registered
  // envFile, or the docker-deploy <dir>/.env convention) and deploy script.
  const openEnvFor = useCallback(
    (appName: string) => {
      const d = deployByApp.get(appName);
      if (!d) return;
      setEnvTarget({
        serverId,
        appName,
        envFile: d.envFile ?? `${d.dir ?? `/opt/${d.app}`}/.env`,
        registered: !!d.envFile,
        script: d.script,
      });
    },
    [deployByApp, serverId],
  );

  const loadCredentials = useCallback(() => {
    window.easyhost.credentials
      .list(serverId)
      .then(setCredentials)
      .catch(() => setCredentials([]));
  }, [serverId]);

  useEffect(() => {
    loadCredentials();
  }, [loadCredentials]);

  // Jumps to the "Allow remote database access" wizard, pre-filled for this
  // one artifact — same pattern the sidebar uses to reopen a saved run.
  const requestRemoteAccess = useCallback(
    (a: ServerArtifact) => {
      const port = a.ports?.[0];
      if (!port) return;
      onNavigate({ kind: 'wizards' });
      window.dispatchEvent(
        new CustomEvent<WizardLaunchDetail>(WIZARD_LAUNCH_EVENT, {
          detail: {
            playbookId: 'enable-db-remote-access',
            serverId,
            values: {
              engine: ENGINE_LABELS[a.engine ?? ''] ?? 'PostgreSQL',
              port: String(port),
              identifier: a.id.startsWith('container:') ? a.name : '',
            },
          },
        }),
      );
    },
    [onNavigate, serverId],
  );

  // Silent scans (auto-refresh, post-action) keep the current list on screen
  // and never flash the button spinner or surface transient errors.
  const scan = useCallback(
    async (silent = false) => {
      const seq = ++scanSeq.current;
      if (!silent) {
        setScanning(true);
        setError(null);
      }
      loadCredentials();
      loadDeployments();
      try {
        const res = await window.easyhost.artifacts.scan(serverId);
        if (seq !== scanSeq.current) return; // stale response (server switched)
        // Explicit comparison: this repo compiles without strictNullChecks,
        // where a bare truthiness check does not narrow the union.
        if (res.ok === false) {
          if (!silent) setError(res.error);
        } else {
          setArtifacts(res.artifacts);
          setScannedAt(res.ts);
          setError(null);
        }
      } catch {
        if (seq === scanSeq.current && !silent) setError('Scan failed.');
      } finally {
        if (seq === scanSeq.current && !silent) setScanning(false);
      }
    },
    [serverId, loadCredentials, loadDeployments],
  );

  // Fresh server ⇒ fresh inventory; scan as soon as we're connected.
  useEffect(() => {
    setArtifacts(null);
    setScannedAt(null);
    setError(null);
    setOpenLogs(new Set());
    setActing(null);
  }, [serverId]);

  useEffect(() => {
    if (connected && artifacts === null && !scanning) void scan();
  }, [connected, artifacts, scanning, scan]);

  // Keep the inventory live while the tab is open. Skips while a manual scan
  // or a row action is in flight — each of those triggers its own refresh.
  useEffect(() => {
    if (!connected) return;
    const t = setInterval(() => {
      if (!scanning && !acting) void scan(true);
    }, AUTO_RESCAN_MS);
    return () => clearInterval(t);
  }, [connected, scanning, acting, scan]);

  /** Start/stop/restart one container or unit, then refresh its status. */
  const runAction = useCallback(
    async (a: ServerArtifact, runtime: ArtifactRuntime, action: ArtifactAction) => {
      setActing({ id: a.id, action });
      try {
        const res = await window.easyhost.artifacts.action({
          serverId,
          runtime,
          name: a.name,
          action,
        });
        if (res.ok === false) {
          toast.error(`Could not ${action} ${a.name}`, {
            description: res.error,
          });
        }
      } catch {
        toast.error(`Could not ${action} ${a.name}`);
      } finally {
        setActing(null);
        void scan(true);
      }
    },
    [serverId, scan],
  );

  const toggleLogs = useCallback((id: string) => {
    setOpenLogs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** Hand a service off to the agent to put a domain in front of it — the agent
   *  answers with the on-screen domain form (requestDomainSetup). */
  const setupDomain = useCallback(
    (a: ServerArtifact) => {
      const port = a.ports?.[0];
      onNavigate({ kind: 'chat' });
      window.dispatchEvent(
        new CustomEvent<ChatPrefillDetail>(CHAT_PREFILL_EVENT, {
          detail: {
            serverId,
            message: `Set up a custom domain for "${a.name}"${
              port ? ` (listening on port ${port})` : ''
            }.`,
          },
        }),
      );
    },
    [onNavigate, serverId],
  );

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connect this server to see what&rsquo;s running on it.
      </div>
    );
  }

  if (artifacts === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        {error ? (
          <>
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => scan()}>
              Retry
            </Button>
          </>
        ) : (
          <>
            <Loader2Icon className="size-4 animate-spin" />
            Scanning server…
          </>
        )}
      </div>
    );
  }

  const sections = SECTIONS.map((s) => ({
    ...s,
    items: artifacts.filter((a) => a.kind === s.kind),
  })).filter((s) => s.items.length > 0);

  return (
    <div className="h-full overflow-y-auto bg-background p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[11px] text-muted-foreground">
            {artifacts.length === 0
              ? 'Nothing detected yet.'
              : `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'} found`}
            {scannedAt && (
              <span>
                {' '}
                · scanned{' '}
                {new Date(scannedAt).toLocaleTimeString([], {
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
            onClick={() => scan()}
            disabled={scanning}
          >
            {scanning && <Loader2Icon className="size-3.5 animate-spin" />}
            {scanning ? 'Scanning…' : 'Refresh'}
          </Button>
        </div>

        <ExposureStrip
          artifacts={artifacts}
          onReview={(message) => {
            // ChatPanel is always mounted, so navigating and dispatching in
            // the same tick is safe — same pattern as the wizard launch above.
            onNavigate({ kind: 'chat' });
            window.dispatchEvent(
              new CustomEvent<ChatPrefillDetail>(CHAT_PREFILL_EVENT, {
                detail: { serverId, message },
              }),
            );
          }}
        />

        {artifacts.length === 0 ? (
          <div className="surface-panel p-6 text-center">
            <p className="text-[13px] font-medium text-ink">
              No websites, containers, databases or backups detected.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Run a wizard or ask the agent to host something — everything it
              sets up will show here.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {sections.map((s) => (
              <section key={s.kind}>
                <div className="mb-1.5 flex items-baseline gap-2 px-0.5">
                  <h3 className="text-[11px] font-medium tracking-[-0.015em] text-muted-foreground">
                    {s.title}
                  </h3>
                  <span className="text-[10px] text-muted-foreground/60">
                    {s.blurb}
                  </span>
                </div>
                <div className="surface-panel divide-y divide-border">
                  {s.items.map((a) => (
                    <ArtifactRow
                      key={a.id}
                      serverId={serverId}
                      artifact={a}
                      credential={matchCredential(a, credentials)}
                      hasEnvFile={deployByApp.has(a.name)}
                      siteUrl={websiteUrl(a, server?.host)}
                      acting={acting?.id === a.id ? acting.action : null}
                      logsOpen={openLogs.has(a.id)}
                      onToggleLogs={() => toggleLogs(a.id)}
                      onAction={runAction}
                      onSetupDomain={() => setupDomain(a)}
                      onOpenEnv={() => openEnvFor(a.name)}
                      onRequestRemoteAccess={requestRemoteAccess}
                      onOpenCredentials={(meta) =>
                        setDialogTarget(
                          meta
                            ? { mode: 'view', meta }
                            : {
                                mode: 'add',
                                serverId,
                                engine: a.engine ?? 'postgresql',
                                host: a.remoteAccessible
                                  ? server?.host ?? '127.0.0.1'
                                  : '127.0.0.1',
                                port:
                                  a.ports?.[0] ??
                                  DEFAULT_PORTS[a.engine ?? ''] ??
                                  0,
                                // Docker-sourced rows are id'd "container:<name>:<i>"
                                // (see main/artifacts.ts) — name is the actual
                                // container name docker inspect needs.
                                containerName: a.id.startsWith('container:')
                                  ? a.name
                                  : undefined,
                              },
                        )
                      }
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <DatabaseCredentialDialog
        target={dialogTarget}
        onOpenChange={(open) => {
          if (!open) setDialogTarget(null);
        }}
        onSaved={loadCredentials}
        onDeleted={loadCredentials}
      />

      <EnvFileDialog
        target={envTarget}
        onOpenChange={(open) => {
          if (!open) setEnvTarget(null);
        }}
        // A redeploy recreates the container — rescan so its status/ports
        // refresh once the new one is up.
        onRedeployStarted={() =>
          window.setTimeout((): void => void scan(true), 8000)
        }
      />
    </div>
  );
}

/** A database artifact's saved credential is matched by engine + port (the
 *  container/service name the scanner reports rarely matches the db name the
 *  wizard used, but the listening port on a given server is a stable link). */
function matchCredential(
  artifact: ServerArtifact,
  credentials: DatabaseCredentialMeta[],
): DatabaseCredentialMeta | undefined {
  if (artifact.kind !== 'database' || !artifact.engine) return undefined;
  return credentials.find(
    (c) =>
      c.engine === artifact.engine &&
      (artifact.ports?.includes(c.port) ?? false),
  );
}

function ArtifactRow({
  serverId,
  artifact,
  credential,
  hasEnvFile,
  siteUrl,
  acting,
  logsOpen,
  onToggleLogs,
  onAction,
  onSetupDomain,
  onOpenEnv,
  onRequestRemoteAccess,
  onOpenCredentials,
}: {
  serverId: string;
  artifact: ServerArtifact;
  credential?: DatabaseCredentialMeta;
  /** True when this artifact matches a registered deployment — shows the
   *  ".env" button that opens the Environment editor dialog for the project. */
  hasEnvFile: boolean;
  /** Website artifacts only: where "Open" goes (null hides the button). */
  siteUrl: string | null;
  /** The lifecycle action currently running on THIS row, if any. */
  acting: ArtifactAction | null;
  logsOpen: boolean;
  onToggleLogs: () => void;
  onAction: (
    artifact: ServerArtifact,
    runtime: ArtifactRuntime,
    action: ArtifactAction,
  ) => void;
  /** Hand this service to the agent to put a custom domain in front of it. */
  onSetupDomain: () => void;
  onOpenEnv: () => void;
  onRequestRemoteAccess: (artifact: ServerArtifact) => void;
  /** Called with the matched credential, or undefined if nothing is saved
   *  yet (the caller then opens the dialog in "add" mode). */
  onOpenCredentials: (meta: DatabaseCredentialMeta | undefined) => void;
}) {
  const glyph =
    (artifact.engine && ENGINE_GLYPHS[artifact.engine]) ?? undefined;
  const Icon = glyph?.icon ?? KIND_GLYPHS[artifact.kind];
  const status = STATUS_META[artifact.status];
  const runtime = runtimeOf(artifact);

  /** One compact lifecycle button — icon-only (labels crowded the name off
   *  narrow rows), tooltip carries the verb; the icon becomes a spinner while
   *  its action is the one in flight (no bare dots — product decision). */
  const actionButton = (
    action: ArtifactAction,
    label: string,
    ActionIcon: AppIcon,
  ) =>
    runtime && (
      <Button
        variant="ghost"
        size="icon-sm"
        className="hidden size-7 shrink-0 text-muted-foreground sm:inline-flex"
        disabled={acting !== null}
        title={`${label} ${artifact.name}`}
        aria-label={`${label} ${artifact.name}`}
        onClick={() => onAction(artifact, runtime, action)}
      >
        {acting === action ? (
          <Loader2Icon className="size-3.5 animate-spin" />
        ) : (
          <ActionIcon className="size-3.5" />
        )}
      </Button>
    );

  // The credential action doubles as "view saved" and "get/record". Keep it a
  // visible action — not a muted afterthought — whenever the user is most
  // likely to need the connection details: a credential is already saved, the
  // database is exposed to the internet, or it's a container we can read the
  // password off of. Only a purely-local database with nothing saved gets the
  // quiet ghost treatment.
  const isContainer = artifact.id.startsWith('container:');
  const credProminent =
    !!credential || !!artifact.remoteAccessible || isContainer;
  const credLabel = credential
    ? 'Credentials'
    : artifact.remoteAccessible || isContainer
      ? 'Get credentials'
      : 'Save credentials';

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary">
        <Icon
          aria-hidden
          className={cn(
            'size-[15px] shrink-0',
            !glyph?.color && 'text-muted-foreground',
          )}
          style={glyph?.color ? { color: glyph.color } : undefined}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium tracking-[-0.015em] text-ink">
            {artifact.name}
          </span>
          {artifact.ports?.map((p) => (
            <span
              key={p}
              className="rounded bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground"
            >
              :{p}
            </span>
          ))}
        </div>
        {(artifact.detail || artifact.meta) && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {artifact.detail}
            {artifact.detail && artifact.meta ? ' · ' : ''}
            {artifact.meta}
          </p>
        )}
      </div>
      {siteUrl && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 gap-1.5 px-2.5 text-[11px] text-muted-foreground"
          onClick={() => window.open(siteUrl)}
          title={siteUrl}
        >
          <ExternalLinkIcon className="size-3.5" />
          Open
        </Button>
      )}
      {/* Put a custom domain in front of anything web-facing — the agent
          answers with the on-screen domain form. Not for databases/backups. */}
      {(artifact.kind === 'website' ||
        artifact.kind === 'container' ||
        artifact.kind === 'service') && (
        <Button
          variant="ghost"
          size="sm"
          className="hidden h-7 shrink-0 gap-1.5 px-2.5 text-[11px] text-muted-foreground sm:inline-flex"
          onClick={onSetupDomain}
          title={`Set up a domain for ${artifact.name}`}
        >
          <WorldIcon className="size-3.5" />
          Domain
        </Button>
      )}
      {artifact.status === 'running' ? (
        <>
          {actionButton('restart', 'Restart', RefreshIcon)}
          {actionButton('stop', 'Stop', StopIcon)}
        </>
      ) : (
        artifact.status === 'stopped' && actionButton('start', 'Start', PlayIcon)
      )}
      {runtime && (
        <Button
          variant={logsOpen ? 'outline' : 'ghost'}
          size="sm"
          className={cn(
            'h-7 shrink-0 gap-1.5 px-2.5 text-[11px]',
            !logsOpen && 'text-muted-foreground',
          )}
          onClick={onToggleLogs}
        >
          <TerminalIcon className="size-3.5" />
          Logs
        </Button>
      )}
      {artifact.kind === 'database' && artifact.ports && artifact.ports.length > 0 && (
        artifact.remoteAccessible ? (
          <span className="hidden shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-1 text-[10px] font-medium text-warning sm:inline-flex">
            <WifiIcon className="size-3" />
            Remote access on
          </span>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="hidden h-7 shrink-0 gap-1.5 px-2.5 text-[11px] text-muted-foreground sm:inline-flex"
            onClick={() => onRequestRemoteAccess(artifact)}
          >
            <WifiIcon className="size-3.5" />
            Enable remote access
          </Button>
        )
      )}
      {hasEnvFile && (
        <Button
          variant="ghost"
          size="sm"
          className="hidden h-7 shrink-0 gap-1.5 px-2.5 font-mono text-[11px] text-muted-foreground sm:inline-flex"
          onClick={onOpenEnv}
        >
          <SettingsIcon className="size-3.5" />
          .env
        </Button>
      )}
      {artifact.kind === 'database' && (
        <Button
          variant={credProminent ? 'outline' : 'ghost'}
          size="sm"
          className={cn(
            'h-7 shrink-0 gap-1.5 px-2.5 text-[11px]',
            !credProminent && 'text-muted-foreground',
          )}
          onClick={() => onOpenCredentials(credential)}
        >
          <KeyIcon className="size-3.5" />
          {credLabel}
        </Button>
      )}
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
        <status.icon aria-hidden className={cn('size-3', status.cls)} />
        {status.label}
      </span>
      </div>

      {logsOpen && runtime && (
        <div className="border-t border-border/60 bg-secondary/20 px-4 py-3">
          <ArtifactLogsSection
            serverId={serverId}
            runtime={runtime}
            name={artifact.name}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exposure strip — every internet-reachable port in one glance
// ---------------------------------------------------------------------------

/** One exposed port with the artifact it belongs to (deduped by port —
 *  databases win so the risky classification is the one that shows). */
type ExposedPort = { port: number; name: string; isDatabase: boolean };

function exposedPorts(artifacts: ServerArtifact[]): ExposedPort[] {
  const byPort = new Map<number, ExposedPort>();
  for (const a of artifacts) {
    if (a.remoteAccessible !== true) continue;
    for (const port of a.ports ?? []) {
      const existing = byPort.get(port);
      const entry = { port, name: a.name, isDatabase: a.kind === 'database' };
      if (!existing || (!existing.isDatabase && entry.isDatabase)) {
        byPort.set(port, entry);
      }
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

function reviewMessage(exposed: ExposedPort[]): string {
  const lines = exposed.map(
    (e) => `- :${e.port} — ${e.name}${e.isDatabase ? ' (database)' : ''}`,
  );
  return [
    'Review this server’s internet-exposed ports and secure anything that shouldn’t be public.',
    '',
    'Currently listening on public interfaces:',
    ...lines,
    '',
    'For each one: check whether it needs to be public, whether the firewall restricts it appropriately, and whether exposed databases should be bound to 127.0.0.1 or IP-allowlisted instead. Explain what you find before changing anything.',
  ].join('\n');
}

function ExposureStrip({
  artifacts,
  onReview,
}: {
  artifacts: ServerArtifact[];
  onReview: (message: string) => void;
}) {
  const exposed = exposedPorts(artifacts);
  if (exposed.length === 0) return null;
  const hasDatabase = exposed.some((e) => e.isDatabase);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-secondary/40 px-4 py-3">
      <span
        className={cn(
          'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
          hasDatabase
            ? 'bg-warning/10 text-warning'
            : 'bg-secondary text-muted-foreground',
        )}
      >
        {hasDatabase ? (
          <AlertTriangleIcon className="size-3" />
        ) : (
          <WorldIcon className="size-3" />
        )}
        {exposed.length} port{exposed.length === 1 ? '' : 's'} exposed
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {exposed.map((e) => (
          <span
            key={e.port}
            className={cn(
              'font-mono text-[11px]',
              e.isDatabase ? 'text-warning' : 'text-muted-foreground',
            )}
            title={
              e.isDatabase
                ? 'A database is reachable from the internet'
                : undefined
            }
          >
            :{e.port} {e.name}
          </span>
        ))}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2.5 text-[11px] text-muted-foreground"
        onClick={() => onReview(reviewMessage(exposed))}
      >
        Review with agent
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Logs panel — tails `docker logs` / `journalctl` while the row is expanded
// (same searchable self-reloading pattern as the Deploys tab's build log)
// ---------------------------------------------------------------------------

const LOG_REFRESH_MS = 4_000;

function ArtifactLogsSection({
  serverId,
  runtime,
  name,
}: {
  serverId: string;
  runtime: ArtifactRuntime;
  name: string;
}) {
  const [log, setLog] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [query, setQuery] = useState('');
  const preRef = useRef<HTMLPreElement | null>(null);

  const loadLog = useCallback(
    async (silent = false) => {
      if (!silent) setLogLoading(true);
      try {
        const res = await window.easyhost.artifacts.logs({
          serverId,
          runtime,
          name,
        });
        if (res.ok === false) {
          setLogError(res.error);
        } else {
          setLogError(null);
          setLog(res.content.trimEnd() || '(no log output)');
        }
      } catch {
        if (!silent) setLogError('Could not read logs.');
      } finally {
        if (!silent) setLogLoading(false);
      }
    },
    [serverId, runtime, name],
  );

  // The panel only exists while its row is expanded, so a tight tail loop is
  // fine — a restarting container's output reads as near-realtime.
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
          Logs
          <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground/60">
            {runtime === 'container'
              ? `docker logs ${name}`
              : `journalctl -u ${name}`}{' '}
            · last 200 lines
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
