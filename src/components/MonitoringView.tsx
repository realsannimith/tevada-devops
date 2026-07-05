import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SidebarGlyph } from '@/components/sidebarGlyphs';
import { ClockIcon, CpuIcon, MemoryIcon, NetworkIcon } from '@/lib/icons';
import { useServers } from '@/hooks/useServers';
import { useMonitorStats } from '@/hooks/useMonitorStats';
import type { ServerStats } from '@/shared/ipc-types';

function fmtBytes(n: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(1)} ${u[i]}`;
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function MonitoringView({ serverId }: { serverId: string }) {
  const { statusOf } = useServers();
  const status = statusOf(serverId);
  const { latest, history } = useMonitorStats(serverId, status === 'connected');

  const chartData = useMemo(
    () =>
      history.map((s: ServerStats, i) => ({
        i,
        cpu: s.cpuPct,
        rx: +(s.net.rxBps / 1024).toFixed(1),
        tx: +(s.net.txBps / 1024).toFixed(1),
      })),
    [history],
  );

  if (status !== 'connected') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Connect this server to see live monitoring.
      </div>
    );
  }

  if (!latest) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Collecting stats…
      </div>
    );
  }

  const memPct = latest.mem.totalBytes
    ? (latest.mem.usedBytes / latest.mem.totalBytes) * 100
    : 0;

  return (
    <div className="h-full space-y-4 overflow-y-auto p-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={<SidebarGlyph icon={CpuIcon} variant="leading" />}
          label="CPU"
          value={`${latest.cpuPct.toFixed(0)}%`}
          sub={`load ${latest.loadAvg[0].toFixed(2)}`}
        />
        <StatCard
          icon={<SidebarGlyph icon={MemoryIcon} variant="leading" />}
          label="Memory"
          value={`${memPct.toFixed(0)}%`}
          sub={`${fmtBytes(latest.mem.usedBytes)} / ${fmtBytes(latest.mem.totalBytes)}`}
        />
        <StatCard
          icon={<SidebarGlyph icon={NetworkIcon} variant="leading" />}
          label="Network"
          value={`${(latest.net.rxBps / 1024).toFixed(0)} KB/s`}
          sub={`↑ ${(latest.net.txBps / 1024).toFixed(0)} KB/s`}
        />
        <StatCard
          icon={<SidebarGlyph icon={ClockIcon} variant="leading" />}
          label="Uptime"
          value={fmtUptime(latest.uptimeSec)}
          sub={`${latest.topProcesses.length} top procs`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="CPU %">
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="cpuG" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--chart-2)"
                    stopOpacity={0.45}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-2)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <XAxis dataKey="i" hide />
              <YAxis
                domain={[0, 100]}
                width={30}
                fontSize={10}
                stroke="var(--muted-foreground)"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: 'var(--border)' }} />
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
        </ChartCard>

        <ChartCard title="Network KB/s (rx)">
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData}>
              <defs>
                <linearGradient id="netG" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0.45}
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--chart-1)"
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
              <XAxis dataKey="i" hide />
              <YAxis
                width={36}
                fontSize={10}
                stroke="var(--muted-foreground)"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: 'var(--border)' }} />
              <Area
                type="monotone"
                dataKey="rx"
                stroke="var(--chart-1)"
                strokeWidth={1.5}
                fill="url(#netG)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="mb-3 text-[13px] font-semibold tracking-[-0.015em] text-ink">
            Disks
          </h3>
          <div className="space-y-2.5">
            {latest.disks.map((d) => {
              const pct = d.totalBytes
                ? (d.usedBytes / d.totalBytes) * 100
                : 0;
              return (
                <div key={d.mount} className="text-[11px]">
                  <div className="flex justify-between text-muted-foreground">
                    <span className="truncate font-mono">{d.mount}</span>
                    <span className="tabular-nums">
                      {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-secondary">
                    <div
                      className="h-1.5 rounded-full bg-primary"
                      style={{ width: `${Math.min(100, pct)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <h3 className="mb-3 text-[13px] font-semibold tracking-[-0.015em] text-ink">
            Top processes
          </h3>
          <table className="w-full text-[11px]">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="pb-1.5 font-normal">CPU%</th>
                <th className="pb-1.5 font-normal">MEM%</th>
                <th className="pb-1.5 font-normal">Command</th>
              </tr>
            </thead>
            <tbody>
              {latest.topProcesses.slice(0, 8).map((p) => (
                <tr key={p.pid} className="border-t border-border">
                  <td className="py-1 tabular-nums">{p.cpu.toFixed(1)}</td>
                  <td className="py-1 tabular-nums">{p.mem.toFixed(1)}</td>
                  <td className="truncate py-1 font-mono text-foreground">
                    {p.command}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

function StatCard({
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

function ChartCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <h3 className="mb-3 text-[13px] font-semibold tracking-[-0.015em] text-ink">
        {title}
      </h3>
      {children}
    </div>
  );
}
