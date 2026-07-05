/**
 * Artifacts tab — the "what is actually running on this server" inventory.
 * One SSH probe (main/artifacts.ts) discovers hosted sites, containers,
 * databases, services and cron backups; this view groups them with the same
 * brand glyphs the wizards use so a Postgres container reads as Postgres.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { View } from '@/App';
import { Button } from '@/components/ui/button';
import {
  DatabaseCredentialDialog,
  type CredentialDialogTarget,
} from '@/components/DatabaseCredentialDialog';
import { EnvFileDialog, type EnvTarget } from '@/components/EnvFileDialog';
import { useServers } from '@/hooks/useServers';
import { WIZARD_LAUNCH_EVENT, type WizardLaunchDetail } from '@/lib/chatHistory';
import {
  ArchiveIcon,
  DatabaseIcon,
  DockerIcon,
  MariadbIcon,
  MongodbIcon,
  NodejsIcon,
  PostgresqlIcon,
  RedisIcon,
  WorldIcon,
} from '@/lib/brand-icons';
import {
  ClockIcon,
  EllipsisIcon,
  KeyIcon,
  Loader2Icon,
  PlayIcon,
  SettingsIcon,
  StopIcon,
  WifiIcon,
  type AppIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type {
  ArtifactKind,
  ArtifactStatus,
  DatabaseCredentialMeta,
  DeploymentInfo,
  ServerArtifact,
} from '@/shared/ipc-types';

/** Maps a scanner-reported engine key back to the label the "Allow remote
 *  database access" wizard's engine select expects (see agent/playbooks.ts). */
const ENGINE_LABELS: Record<string, string> = {
  postgresql: 'PostgreSQL',
  mysql: 'MySQL/MariaDB',
  redis: 'Redis',
  mongodb: 'MongoDB',
};

const ENGINE_GLYPHS: Record<string, { icon: AppIcon; color?: string }> = {
  postgresql: { icon: PostgresqlIcon, color: '#4169E1' },
  mysql: { icon: MariadbIcon, color: '#4479A1' },
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

  const scan = useCallback(async () => {
    const seq = ++scanSeq.current;
    setScanning(true);
    setError(null);
    loadCredentials();
    try {
      const res = await window.easyhost.artifacts.scan(serverId);
      if (seq !== scanSeq.current) return; // stale response (server switched)
      // Explicit comparison: this repo compiles without strictNullChecks,
      // where a bare truthiness check does not narrow the union.
      if (res.ok === false) {
        setError(res.error);
      } else {
        setArtifacts(res.artifacts);
        setScannedAt(res.ts);
      }
    } catch {
      if (seq === scanSeq.current) setError('Scan failed.');
    } finally {
      if (seq === scanSeq.current) setScanning(false);
    }
  }, [serverId, loadCredentials]);

  // Fresh server ⇒ fresh inventory; scan as soon as we're connected.
  useEffect(() => {
    setArtifacts(null);
    setScannedAt(null);
    setError(null);
  }, [serverId]);

  useEffect(() => {
    if (connected && artifacts === null && !scanning) void scan();
  }, [connected, artifacts, scanning, scan]);

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
            <Button variant="outline" size="sm" onClick={scan}>
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
            onClick={scan}
            disabled={scanning}
          >
            {scanning && <Loader2Icon className="size-3.5 animate-spin" />}
            {scanning ? 'Scanning…' : 'Refresh'}
          </Button>
        </div>

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
                      artifact={a}
                      credential={matchCredential(a, credentials)}
                      hasEnvFile={deployByApp.has(a.name)}
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
        onRedeployStarted={() => window.setTimeout(scan, 8000)}
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
  artifact,
  credential,
  hasEnvFile,
  onOpenEnv,
  onRequestRemoteAccess,
  onOpenCredentials,
}: {
  artifact: ServerArtifact;
  credential?: DatabaseCredentialMeta;
  /** True when this artifact matches a registered deployment — shows the
   *  ".env" button that opens the Environment editor dialog for the project. */
  hasEnvFile: boolean;
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
  );
}
