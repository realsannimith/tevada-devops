/**
 * Dashboard: a single "all servers at a glance" screen. Lists every server
 * instance with its live connection status and a compact performance summary
 * (CPU, memory, uptime, load) for the ones that are connected, plus fleet-wide
 * roll-up tiles at the top. Each card reuses the same monitor stream as the
 * per-server Monitoring tab via useMonitorStats.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertTriangleIcon,
  ChartBarIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  Loader2Icon,
  MemoryIcon,
  ServerIcon,
  WifiIcon,
  WifiOffIcon,
} from '@/lib/icons';
import { useServers } from '@/hooks/useServers';
import { useMonitorStats } from '@/hooks/useMonitorStats';
import { cn } from '@/lib/utils';
import type { ConnStatus, ServerStats, ServerWithStatus } from '@/shared/ipc-types';
import type { View } from '@/App';

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
}

/** Total RAM for the spec line. `free` reports a little under the nominal size
 *  (firmware/kernel reserve), so round to the nearest 0.5 GiB. A 1 GiB box then
 *  reads "1 GiB" rather than "0.9 GiB". Below 1 GiB, show whole MiB. */
function fmtRam(totalBytes: number): string {
  if (totalBytes <= 0) return 'N/A';
  const gib = totalBytes / 1024 ** 3;
  if (gib < 1) return `${Math.round(totalBytes / 1024 ** 2)} MiB`;
  const rounded = Math.round(gib * 2) / 2;
  return `${rounded} GiB`;
}

function fmtCpuSpec(host: NonNullable<ServerStats['host']>): string {
  const cpu = `${host.cores} vCPU${host.cores === 1 ? '' : 's'}`;
  const model = [host.vendor, host.arch].filter(Boolean).join(' ');
  return model ? `${cpu}, ${model}` : cpu;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function memPctOf(s: ServerStats): number {
  return s.mem.totalBytes ? (s.mem.usedBytes / s.mem.totalBytes) * 100 : 0;
}

/** Aggregate disk usage across a server's real volumes (the probe's df already
 *  excludes tmpfs/devtmpfs/overlay, so summing doesn't count pseudo-fs). */
function diskTotals(s: ServerStats): { usedBytes: number; totalBytes: number } {
  return s.disks.reduce(
    (acc, d) => ({
      usedBytes: acc.usedBytes + d.usedBytes,
      totalBytes: acc.totalBytes + d.totalBytes,
    }),
    { usedBytes: 0, totalBytes: 0 },
  );
}

const STATUS_META: Record<
  ConnStatus,
  { label: string; cls: string; icon: typeof CheckIcon; spin?: boolean }
> = {
  connected: {
    label: 'Connected',
    cls: 'bg-success/10 text-success',
    icon: CheckIcon,
  },
  connecting: {
    label: 'Connecting…',
    cls: 'bg-warning/10 text-warning',
    icon: Loader2Icon,
    spin: true,
  },
  error: {
    label: 'Error',
    cls: 'bg-destructive/10 text-destructive',
    icon: AlertTriangleIcon,
  },
  disconnected: {
    label: 'Offline',
    cls: 'bg-secondary text-muted-foreground',
    icon: WifiOffIcon,
  },
};

export function DashboardView({
  onNavigate,
}: {
  onNavigate: (v: View) => void;
}) {
  const { servers, statusOf, connect } = useServers();
  // Children publish their latest sample up here so we can roll up fleet-wide
  // averages without polling each server twice.
  const [statsMap, setStatsMap] = useState<Record<string, ServerStats | null>>({});

  const reportStats = useCallback((serverId: string, stats: ServerStats | null) => {
    setStatsMap((prev) => (prev[serverId] === stats ? prev : { ...prev, [serverId]: stats }));
  }, []);

  const connectedCount = useMemo(
    () => servers.filter((s) => statusOf(s.id) === 'connected').length,
    [servers, statusOf],
  );

  const live = useMemo(
    () =>
      servers
        .map((s) => statsMap[s.id])
        .filter((s): s is ServerStats => Boolean(s)),
    [servers, statsMap],
  );

  const avgCpu = live.length
    ? live.reduce((sum, s) => sum + s.cpuPct, 0) / live.length
    : null;
  const avgMem = live.length
    ? live.reduce((sum, s) => sum + memPctOf(s), 0) / live.length
    : null;
  const fleetDisk = useMemo(() => {
    const t = live.reduce(
      (acc, s) => {
        const d = diskTotals(s);
        return { usedBytes: acc.usedBytes + d.usedBytes, totalBytes: acc.totalBytes + d.totalBytes };
      },
      { usedBytes: 0, totalBytes: 0 },
    );
    return t.totalBytes > 0 ? t : null;
  }, [live]);

  const offlineCount = servers.length - connectedCount;

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="chat-surface-divider flex shrink-0 items-center justify-between gap-4 px-6 py-4">
        <div>
          <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">
            Dashboard
          </h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Live health and capacity across your server fleet.
          </p>
        </div>
        <div className="hidden items-center gap-2 text-[11px] text-muted-foreground sm:flex">
          <WifiIcon aria-hidden className="size-3.5 text-success" />
          <span className="tabular-nums text-foreground">{connectedCount}</span>
          of {servers.length} connected
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] space-y-5 p-4 sm:p-6">
          <section
            aria-label="Fleet summary"
            className="surface-panel grid overflow-hidden sm:grid-cols-2 lg:grid-cols-[1.35fr_repeat(3,minmax(0,1fr))]"
          >
            <SummaryMetric
              icon={ServerIcon}
              label="Fleet"
              value={`${connectedCount} / ${servers.length}`}
              sub={
                servers.length === 0
                  ? 'No servers configured'
                  : offlineCount === 0
                    ? 'All servers connected'
                    : `${offlineCount} ${offlineCount === 1 ? 'server' : 'servers'} offline`
              }
              featured
            />
            <SummaryMetric
              icon={CpuIcon}
              label="Average CPU"
              value={avgCpu === null ? 'N/A' : `${avgCpu.toFixed(0)}%`}
              sub={live.length ? `${live.length} live sampled` : 'Waiting for live data'}
              divided
            />
            <SummaryMetric
              icon={MemoryIcon}
              label="Average memory"
              value={avgMem === null ? 'N/A' : `${avgMem.toFixed(0)}%`}
              sub={live.length ? `${live.length} live sampled` : 'Waiting for live data'}
              divided
            />
            <SummaryMetric
              icon={DatabaseIcon}
              label="Fleet storage"
              value={
                fleetDisk === null
                  ? 'N/A'
                  : `${((fleetDisk.usedBytes / fleetDisk.totalBytes) * 100).toFixed(0)}%`
              }
              sub={
                fleetDisk === null
                  ? 'Waiting for live data'
                  : `${fmtBytes(fleetDisk.usedBytes)} of ${fmtBytes(fleetDisk.totalBytes)}`
              }
              divided
            />
          </section>

          <section aria-labelledby="servers-heading">
            <div className="mb-2.5 flex items-center justify-between px-1">
              <h2 id="servers-heading" className="text-xs font-medium text-ink">
                Servers
              </h2>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {servers.length} {servers.length === 1 ? 'instance' : 'instances'}
              </span>
            </div>

            {servers.length === 0 ? (
              <div className="surface-panel flex min-h-52 flex-col items-center justify-center px-6 text-center">
                <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
                  <ServerIcon aria-hidden className="size-4" />
                </div>
                <h3 className="text-[13px] font-medium text-ink">No servers yet</h3>
                <p className="mt-1 max-w-64 text-[11px] leading-relaxed text-muted-foreground">
                  Add a server from the sidebar to monitor health, capacity, and uptime here.
                </p>
              </div>
            ) : (
              <div className="surface-panel divide-y divide-border overflow-hidden">
                {servers.map((server) => (
                  <ServerDashboardRow
                    key={server.id}
                    server={server}
                    status={statusOf(server.id)}
                    onReportStats={reportStats}
                    onOpen={() =>
                      onNavigate({
                        kind: 'server',
                        serverId: server.id,
                        tab: 'monitoring',
                      })
                    }
                    onConnect={() => connect(server.id)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function ServerDashboardRow({
  server,
  status,
  onReportStats,
  onOpen,
  onConnect,
}: {
  server: ServerWithStatus;
  status: ConnStatus;
  onReportStats: (serverId: string, stats: ServerStats | null) => void;
  onOpen: () => void;
  onConnect: () => void;
}) {
  const connected = status === 'connected';
  const { latest } = useMonitorStats(server.id, connected);
  const disk = useMemo(() => {
    if (!latest) return null;
    const t = diskTotals(latest);
    return t.totalBytes > 0 ? t : null;
  }, [latest]);

  // Keep the fleet roll-up in sync with this card's most recent sample.
  useEffect(() => {
    onReportStats(server.id, connected ? (latest ?? null) : null);
  }, [latest, connected, server.id, onReportStats]);

  return (
    <article className="px-4 py-4 transition-colors hover:bg-accent/25 sm:px-5">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="group min-w-0 flex-1 text-left outline-none focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
          title="Open monitoring"
        >
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium tracking-[-0.015em] text-ink">
              {server.name}
            </span>
            <ChevronRightIcon
              aria-hidden
              className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
            />
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {server.username}@{server.host}:{server.port}
          </div>
        </button>
        <StatusPill status={status} />
      </div>

      <div className="mt-3.5">
        {!connected ? (
          <div className="flex min-h-12 items-center justify-between gap-4 rounded-xl bg-secondary/55 px-3">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              {status === 'connecting' ? (
                <Loader2Icon aria-hidden className="size-3.5 shrink-0 animate-spin" />
              ) : status === 'error' ? (
                <AlertTriangleIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
              ) : (
                <WifiOffIcon aria-hidden className="size-3.5 shrink-0" />
              )}
              {status === 'connecting'
                ? 'Establishing a secure SSH connection.'
                : status === 'error'
                  ? 'Connection failed. Review settings or try again.'
                  : 'Connect to collect live metrics.'}
            </div>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={onConnect}
              disabled={status === 'connecting'}
            >
              {status === 'connecting'
                ? 'Connecting…'
                : status === 'error'
                  ? 'Retry'
                  : 'Connect'}
            </Button>
          </div>
        ) : !latest ? (
          <MetricsSkeleton />
        ) : (
          <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-3 xl:grid-cols-6 xl:gap-0">
            <MetricCell
              icon={CpuIcon}
              label="CPU"
              value={`${latest.cpuPct.toFixed(0)}%`}
              pct={latest.cpuPct}
            />
            <MetricCell
              icon={MemoryIcon}
              label="Memory"
              value={`${memPctOf(latest).toFixed(0)}%`}
              pct={memPctOf(latest)}
            />
            <MetricCell
              icon={DatabaseIcon}
              label="Storage"
              value={
                disk
                  ? `${((disk.usedBytes / disk.totalBytes) * 100).toFixed(0)}%`
                  : 'N/A'
              }
              pct={disk ? (disk.usedBytes / disk.totalBytes) * 100 : undefined}
              detail={disk ? `${fmtBytes(disk.usedBytes)} used` : 'No volume data'}
            />
            <MetricCell
              icon={ClockIcon}
              label="Uptime"
              value={fmtUptime(latest.uptimeSec)}
            />
            <MetricCell
              icon={ChartBarIcon}
              label="Load"
              value={latest.loadAvg[0].toFixed(2)}
            />
            <MetricCell
              icon={ChartBarIcon}
              label="Processes"
              value={`${latest.topProcesses.length}`}
            />
          </div>
          {latest.host && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-[10px] text-muted-foreground">
              <span>{fmtCpuSpec(latest.host)}</span>
              <span>{fmtRam(latest.mem.totalBytes)} RAM</span>
              {disk && <span>{fmtBytes(disk.totalBytes)} storage</span>}
              {latest.disks.length > 1 && <span>{latest.disks.length} volumes</span>}
            </div>
          )}
          </>
        )}
      </div>
    </article>
  );
}

function MetricCell({
  icon: Icon,
  label,
  value,
  pct,
  detail,
}: {
  icon: typeof CpuIcon;
  label: string;
  value: string;
  pct?: number;
  detail?: string;
}) {
  const tone =
    pct !== undefined && pct >= 90
      ? 'bg-destructive'
      : pct !== undefined && pct >= 75
        ? 'bg-warning'
        : 'bg-primary';

  return (
    <div className="min-w-0 xl:border-l xl:border-border xl:px-4 xl:first:border-l-0 xl:first:pl-0">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="mt-1 text-[17px] leading-none font-medium tabular-nums text-ink">
        {value}
      </div>
      {pct !== undefined ? (
        <div className="mt-2 h-px overflow-hidden bg-border">
          <div
            className={cn('h-px', tone)}
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
      ) : (
        <div className="mt-2 h-px bg-border" />
      )}
      {detail && <div className="mt-1 truncate text-[10px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function StatusPill({ status }: { status: ConnStatus }) {
  const meta = STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
        meta.cls,
      )}
    >
      <Icon aria-hidden className={cn('size-3', meta.spin && 'animate-spin')} />
      {meta.label}
    </span>
  );
}

function MetricsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Collecting server metrics"
      className="grid animate-pulse grid-cols-2 gap-x-4 gap-y-4 md:grid-cols-3 xl:grid-cols-6 xl:gap-0"
    >
      <span className="sr-only">Collecting server metrics</span>
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="xl:border-l xl:border-border xl:px-4 xl:first:border-l-0 xl:first:pl-0"
        >
          <div className="h-2.5 w-14 rounded-full bg-secondary" />
          <div className="mt-2 h-4 w-10 rounded-md bg-secondary" />
          <div className="mt-2 h-px bg-border" />
        </div>
      ))}
    </div>
  );
}

function SummaryMetric({
  icon: Icon,
  label,
  value,
  sub,
  featured = false,
  divided = false,
}: {
  icon: typeof CpuIcon;
  label: string;
  value: string;
  sub: string;
  featured?: boolean;
  divided?: boolean;
}) {
  return (
    <div
      className={cn(
        'min-w-0 px-4 py-4 sm:px-5',
        divided &&
          'border-t border-border sm:border-l sm:[&:nth-child(2)]:border-t-0 sm:[&:nth-child(3)]:border-l-0 lg:border-t-0 lg:[&:nth-child(3)]:border-l',
      )}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon aria-hidden className={cn('size-3.5', featured && 'text-primary')} />
        <span className="text-[11px]">{label}</span>
      </div>
      <div
        className={cn(
          'mt-2 leading-none font-medium tabular-nums text-ink',
          featured ? 'text-[24px]' : 'text-[20px]',
        )}
      >
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}
