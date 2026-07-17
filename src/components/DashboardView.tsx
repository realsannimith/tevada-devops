/**
 * Dashboard — a single "all servers at a glance" screen. Lists every server
 * instance with its live connection status and a compact performance summary
 * (CPU, memory, uptime, load) for the ones that are connected, plus fleet-wide
 * roll-up tiles at the top. Each card reuses the same monitor stream as the
 * per-server Monitoring tab via useMonitorStats.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SidebarGlyph } from '@/components/sidebarGlyphs';
import {
  ChartBarIcon,
  CheckIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  Loader2Icon,
  MemoryIcon,
  ServerIcon,
  WifiIcon,
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
 *  (firmware/kernel reserve), so round to the nearest 0.5 GiB — a 1 GiB box then
 *  reads "1 GiB" rather than "0.9 GiB". Below 1 GiB, show whole MiB. */
function fmtRam(totalBytes: number): string {
  if (totalBytes <= 0) return '—';
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
  { label: string; cls: string; dot: string }
> = {
  connected: { label: 'Connected', cls: 'bg-success/10 text-success', dot: 'bg-success' },
  connecting: { label: 'Connecting…', cls: 'bg-warning/10 text-warning', dot: 'bg-warning' },
  error: { label: 'Error', cls: 'bg-destructive/10 text-destructive', dot: 'bg-destructive' },
  disconnected: { label: 'Offline', cls: 'bg-secondary text-muted-foreground', dot: 'bg-muted-foreground/50' },
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

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-5">
        <h1 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">
          Dashboard
        </h1>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Every server instance and its live performance at a glance.
        </p>
      </div>

      {/* Fleet roll-up */}
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <SummaryCard
          icon={<SidebarGlyph icon={ServerIcon} variant="leading" />}
          label="Servers"
          value={`${servers.length}`}
          sub={servers.length === 1 ? 'instance' : 'instances'}
        />
        <SummaryCard
          icon={<SidebarGlyph icon={WifiIcon} variant="leading" />}
          label="Connected"
          value={`${connectedCount}`}
          sub={`${servers.length - connectedCount} offline`}
        />
        <SummaryCard
          icon={<SidebarGlyph icon={CpuIcon} variant="leading" />}
          label="Avg CPU"
          value={avgCpu === null ? '—' : `${avgCpu.toFixed(0)}%`}
          sub={live.length ? `across ${live.length} live` : 'no live data'}
        />
        <SummaryCard
          icon={<SidebarGlyph icon={MemoryIcon} variant="leading" />}
          label="Avg Memory"
          value={avgMem === null ? '—' : `${avgMem.toFixed(0)}%`}
          sub={live.length ? `across ${live.length} live` : 'no live data'}
        />
        <SummaryCard
          icon={<SidebarGlyph icon={DatabaseIcon} variant="leading" />}
          label="Storage"
          value={
            fleetDisk === null
              ? '—'
              : `${((fleetDisk.usedBytes / fleetDisk.totalBytes) * 100).toFixed(0)}%`
          }
          sub={
            fleetDisk === null
              ? 'no live data'
              : `${fmtBytes(fleetDisk.usedBytes)} of ${fmtBytes(fleetDisk.totalBytes)} used`
          }
        />
      </div>

      {servers.length === 0 ? (
        <div className="flex h-40 items-center justify-center rounded-2xl border border-dashed border-border text-sm text-muted-foreground">
          No servers yet. Add one from the sidebar to see it here.
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {servers.map((server) => (
            <ServerDashboardCard
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
    </div>
  );
}

function ServerDashboardCard({
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

  const meta = STATUS_META[status];

  return (
    <div className="flex flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex items-start justify-between gap-2">
        <button
          onClick={onOpen}
          className="min-w-0 flex-1 text-left"
          title="Open monitoring"
        >
          <div className="truncate text-[13px] font-semibold tracking-[-0.015em] text-ink">
            {server.name}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {server.username}@{server.host}:{server.port}
          </div>
        </button>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
            meta.cls,
          )}
        >
          {status === 'connecting' ? (
            <Loader2Icon aria-hidden className="size-3 animate-spin" />
          ) : status === 'connected' ? (
            <CheckIcon aria-hidden className="size-3" />
          ) : (
            <span className={cn('size-1.5 rounded-full', meta.dot)} />
          )}
          {meta.label}
        </span>
      </div>

      <div className="mt-4">
        {!connected ? (
          <div className="flex items-center justify-between rounded-xl bg-secondary/40 px-3 py-3">
            <span className="text-[11px] text-muted-foreground">
              Connect to see live metrics.
            </span>
            <button
              onClick={onConnect}
              disabled={status === 'connecting'}
              className="rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-black transition-opacity hover:bg-white/90 disabled:opacity-50"
            >
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        ) : !latest ? (
          <div className="flex items-center gap-2 px-1 py-3 text-[11px] text-muted-foreground">
            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
            Collecting stats…
          </div>
        ) : (
          <>
          <div className="grid grid-cols-2 gap-3">
            <Metric
              icon={CpuIcon}
              label="CPU"
              value={`${latest.cpuPct.toFixed(0)}%`}
              pct={latest.cpuPct}
            />
            <Metric
              icon={MemoryIcon}
              label="Memory"
              value={`${memPctOf(latest).toFixed(0)}%`}
              pct={memPctOf(latest)}
            />
            <MiniStat
              icon={ClockIcon}
              label="Uptime"
              value={fmtUptime(latest.uptimeSec)}
            />
            <MiniStat
              icon={ChartBarIcon}
              label="Load"
              value={latest.loadAvg[0].toFixed(2)}
            />
            <MiniStat
              icon={ServerIcon}
              label="Memory used"
              value={fmtBytes(latest.mem.usedBytes)}
            />
            <MiniStat
              icon={ChartBarIcon}
              label="Procs"
              value={`${latest.topProcesses.length}`}
            />
          </div>
          {/* Storage — aggregate used/total across the server's real volumes,
              with a usage bar (same data the Monitoring tab breaks down
              per-mount). */}
          {disk && (
            <div className="mt-3 text-[11px]">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <DatabaseIcon aria-hidden className="size-3.5" />
                  Storage
                  {latest.disks.length > 1 && ` · ${latest.disks.length} volumes`}
                </span>
                <span className="tabular-nums">
                  {fmtBytes(disk.usedBytes)} / {fmtBytes(disk.totalBytes)}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-secondary">
                <div
                  className="h-1.5 rounded-full bg-primary"
                  style={{
                    width: `${Math.min(100, (disk.usedBytes / disk.totalBytes) * 100)}%`,
                  }}
                />
              </div>
            </div>
          )}
          {/* Machine spec — the static hardware facts, so the user can see what
              they're connected to (e.g. "2 vCPUs, Intel x86_64" / total RAM). */}
          {latest.host && (
            <div className="mt-3 space-y-1 border-t border-border pt-3">
              <SpecRow icon={CpuIcon} label="CPU" value={fmtCpuSpec(latest.host)} />
              <SpecRow
                icon={MemoryIcon}
                label="Memory"
                value={`${fmtRam(latest.mem.totalBytes)} RAM`}
              />
              {disk && (
                <SpecRow
                  icon={DatabaseIcon}
                  label="Storage"
                  value={`${fmtBytes(disk.totalBytes)} disk`}
                />
              )}
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}

/** A metric with a small usage bar (for percentage-style values). */
function Metric({
  icon: Icon,
  label,
  value,
  pct,
}: {
  icon: typeof CpuIcon;
  label: string;
  value: string;
  pct: number;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="mt-1 text-[18px] leading-none font-semibold tabular-nums text-ink">
        {value}
      </div>
      <div className="mt-1.5 h-1.5 rounded-full bg-secondary">
        <div
          className="h-1.5 rounded-full bg-primary"
          style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
        />
      </div>
    </div>
  );
}

/** A plain label/value metric (no bar). */
function MiniStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CpuIcon;
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon aria-hidden className="size-3.5" />
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="mt-1 text-[13px] font-medium tabular-nums text-foreground">
        {value}
      </div>
    </div>
  );
}

/** A compact "Label: value" hardware spec line (icon + inline text). */
function SpecRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof CpuIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="font-medium text-foreground">{label}:</span>
      <span className="truncate tabular-nums">{value}</span>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <div className="mt-2 text-[22px] leading-none font-semibold tabular-nums text-ink">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}
