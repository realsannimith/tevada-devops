import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartBarIcon,
  ClockIcon,
  CpuIcon,
  MemoryIcon,
  NetworkIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useServers } from '@/hooks/useServers';
import { useMonitorStats } from '@/hooks/useMonitorStats';
import type { ServerStats } from '@/shared/ipc-types';

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
}

/** Bytes/sec as an adaptive KB/s / MB/s label. */
function fmtRate(bps: number): string {
  const kb = bps / 1024;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB/s`;
  return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB/s`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Green while healthy, amber when busy, red when close to the ceiling. */
function usageColor(pct: number): string {
  if (pct >= 90) return 'var(--destructive)';
  if (pct >= 75) return 'var(--warning)';
  return 'var(--success)';
}

export function MonitoringView({ serverId }: { serverId: string }) {
  const { statusOf } = useServers();
  const status = statusOf(serverId);
  const { latest, history } = useMonitorStats(serverId, status === 'connected');

  const chartData = useMemo(
    () =>
      history.map((s: ServerStats, i) => ({
        i,
        cpu: +s.cpuPct.toFixed(1),
        mem: s.mem.totalBytes
          ? +((s.mem.usedBytes / s.mem.totalBytes) * 100).toFixed(1)
          : 0,
        rx: +(s.net.rxBps / 1024).toFixed(1),
        tx: +(s.net.txBps / 1024).toFixed(1),
      })),
    [history],
  );

  if (status !== 'connected') {
    return (
      <EmptyState
        icon={<ChartBarIcon className="size-5" />}
        title="Not connected"
        hint="Connect this server to see live monitoring."
      />
    );
  }

  if (!latest) {
    return (
      <EmptyState
        icon={
          <span className="relative flex size-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
          </span>
        }
        title="Collecting stats…"
        hint="First sample usually arrives within a few seconds."
      />
    );
  }

  const memPct = latest.mem.totalBytes
    ? (latest.mem.usedBytes / latest.mem.totalBytes) * 100
    : 0;
  const host = latest.host;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-4 p-6">
        {/* Live badge + machine spec */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--success)] opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-[var(--success)]" />
            </span>
            Live
          </span>
          {host && (
            <span className="text-[11px] text-muted-foreground">
              {host.cores} vCPU{host.cores === 1 ? '' : 's'}
              {host.vendor ? ` · ${host.vendor}` : ''}
              {host.arch ? ` ${host.arch}` : ''}
              {' · '}
              {fmtBytes(latest.mem.totalBytes)} RAM
            </span>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground/70 tabular-nums">
            up {fmtUptime(latest.uptimeSec)}
          </span>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            icon={<CpuIcon className="size-[15px]" />}
            label="CPU"
            value={`${latest.cpuPct.toFixed(0)}%`}
            sub={`load ${latest.loadAvg[0].toFixed(2)} · ${latest.loadAvg[1].toFixed(2)} · ${latest.loadAvg[2].toFixed(2)}`}
            pct={latest.cpuPct}
          />
          <StatCard
            icon={<MemoryIcon className="size-[15px]" />}
            label="Memory"
            value={`${memPct.toFixed(0)}%`}
            sub={`${fmtBytes(latest.mem.usedBytes)} of ${fmtBytes(latest.mem.totalBytes)}`}
            pct={memPct}
          />
          <StatCard
            icon={<NetworkIcon className="size-[15px]" />}
            label="Network"
            value={fmtRate(latest.net.rxBps)}
            sub={`↓ down · ↑ ${fmtRate(latest.net.txBps)} up`}
          />
          <StatCard
            icon={<ClockIcon className="size-[15px]" />}
            label="Uptime"
            value={fmtUptime(latest.uptimeSec)}
            sub={`${latest.topProcesses.length} top processes`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="CPU"
            badge={`${latest.cpuPct.toFixed(0)}%`}
            badgeColor={usageColor(latest.cpuPct)}
          >
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="cpuG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="memG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-3)" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="var(--chart-3)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="i" hide />
                <YAxis
                  domain={[0, 100]}
                  width={32}
                  fontSize={10}
                  stroke="var(--muted-foreground)"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ stroke: 'var(--border)' }}
                  labelFormatter={() => ''}
                  formatter={(value: number, name: string) => [
                    `${value}%`,
                    name === 'cpu' ? 'CPU' : 'Memory',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="mem"
                  stroke="var(--chart-3)"
                  strokeWidth={1.25}
                  strokeOpacity={0.7}
                  fill="url(#memG)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="cpu"
                  stroke="var(--chart-2)"
                  strokeWidth={1.5}
                  fill="url(#cpuG)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            <ChartLegend
              items={[
                { color: 'var(--chart-2)', label: 'CPU' },
                { color: 'var(--chart-3)', label: 'Memory' },
              ]}
            />
          </ChartCard>

          <ChartCard title="Network" badge={`↓ ${fmtRate(latest.net.rxBps)}`}>
            <ResponsiveContainer width="100%" height={170}>
              <AreaChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="rxG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="txG" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-4)" stopOpacity={0.2} />
                    <stop offset="100%" stopColor="var(--chart-4)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="i" hide />
                <YAxis
                  width={40}
                  fontSize={10}
                  stroke="var(--muted-foreground)"
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  cursor={{ stroke: 'var(--border)' }}
                  labelFormatter={() => ''}
                  formatter={(value: number, name: string) => [
                    `${value} KB/s`,
                    name === 'rx' ? 'Down' : 'Up',
                  ]}
                />
                <Area
                  type="monotone"
                  dataKey="tx"
                  stroke="var(--chart-4)"
                  strokeWidth={1.25}
                  strokeOpacity={0.7}
                  fill="url(#txG)"
                  isAnimationActive={false}
                />
                <Area
                  type="monotone"
                  dataKey="rx"
                  stroke="var(--chart-1)"
                  strokeWidth={1.5}
                  fill="url(#rxG)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
            <ChartLegend
              items={[
                { color: 'var(--chart-1)', label: 'Down (KB/s)' },
                { color: 'var(--chart-4)', label: 'Up (KB/s)' },
              ]}
            />
          </ChartCard>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="surface-panel p-5">
            <h3 className="mb-3 text-[13px] font-semibold tracking-[-0.015em] text-ink">
              Disks
            </h3>
            {latest.disks.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No mounted disks reported.</p>
            ) : (
              <div className="space-y-3">
                {latest.disks.map((d) => {
                  const pct = d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0;
                  return (
                    <div key={d.mount} className="text-[11px]">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-foreground">{d.mount}</span>
                          {d.filesystem && (
                            <span className="ml-1.5 text-muted-foreground/60">
                              {d.filesystem}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">
                          {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)}
                          <span
                            className="ml-1.5 font-medium"
                            style={{ color: usageColor(pct) }}
                          >
                            {pct.toFixed(0)}%
                          </span>
                        </span>
                      </div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full transition-[width] duration-500"
                          style={{
                            width: `${Math.min(100, pct)}%`,
                            background: usageColor(pct),
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="surface-panel p-5">
            <h3 className="mb-3 text-[13px] font-semibold tracking-[-0.015em] text-ink">
              Top processes
            </h3>
            <table className="w-full text-[11px]">
              <thead className="text-muted-foreground">
                <tr className="text-left">
                  <th className="w-12 pb-1.5 font-normal">CPU%</th>
                  <th className="w-12 pb-1.5 font-normal">MEM%</th>
                  <th className="hidden w-16 pb-1.5 font-normal sm:table-cell">User</th>
                  <th className="pb-1.5 font-normal">Command</th>
                </tr>
              </thead>
              <tbody>
                {latest.topProcesses.slice(0, 8).map((p) => (
                  <tr
                    key={p.pid}
                    className="border-t border-border transition-colors hover:bg-secondary/60"
                  >
                    <td
                      className={cn(
                        'py-1.5 tabular-nums',
                        p.cpu >= 50 ? 'font-medium text-ink' : undefined,
                      )}
                    >
                      {p.cpu.toFixed(1)}
                    </td>
                    <td className="py-1.5 tabular-nums">{p.mem.toFixed(1)}</td>
                    <td className="hidden truncate py-1.5 text-muted-foreground sm:table-cell">
                      {p.user}
                    </td>
                    <td
                      className="max-w-0 truncate py-1.5 font-mono text-foreground"
                      title={p.command}
                    >
                      {p.command}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

const tooltipStyle = {
  background: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 11,
  color: 'var(--foreground)',
  boxShadow: 'none',
};

function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
        {icon}
      </span>
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  /** When set, renders a threshold-colored usage bar under the value. */
  pct?: number;
}) {
  return (
    <div className="surface-panel p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="flex size-6 items-center justify-center rounded-md bg-secondary">
          {icon}
        </span>
        <span className="text-[11px] font-medium tracking-wide uppercase">{label}</span>
      </div>
      <div className="mt-2.5 text-[22px] leading-none font-semibold tracking-[-0.02em] tabular-nums text-ink">
        {value}
      </div>
      {pct !== undefined && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full transition-[width] duration-500"
            style={{
              width: `${Math.min(100, pct)}%`,
              background: usageColor(pct),
            }}
          />
        </div>
      )}
      <div className="mt-1.5 truncate text-[11px] text-muted-foreground" title={sub}>
        {sub}
      </div>
    </div>
  );
}

function ChartCard({
  title,
  badge,
  badgeColor,
  children,
}: {
  title: string;
  badge?: string;
  badgeColor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="surface-panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold tracking-[-0.015em] text-ink">{title}</h3>
        {badge && (
          <span
            className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium tabular-nums"
            style={badgeColor ? { color: badgeColor } : undefined}
          >
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function ChartLegend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="mt-2 flex items-center gap-4">
      {items.map((it) => (
        <span
          key={it.label}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
        >
          <span
            className="inline-block h-1 w-3 rounded-full"
            style={{ background: it.color }}
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}
