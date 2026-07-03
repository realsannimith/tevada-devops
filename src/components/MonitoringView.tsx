import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Cpu, MemoryStick, HardDrive, Clock } from 'lucide-react';
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
          icon={<Cpu className="h-4 w-4" />}
          label="CPU"
          value={`${latest.cpuPct.toFixed(0)}%`}
          sub={`load ${latest.loadAvg[0].toFixed(2)}`}
        />
        <StatCard
          icon={<MemoryStick className="h-4 w-4" />}
          label="Memory"
          value={`${memPct.toFixed(0)}%`}
          sub={`${fmtBytes(latest.mem.usedBytes)} / ${fmtBytes(latest.mem.totalBytes)}`}
        />
        <StatCard
          icon={<HardDrive className="h-4 w-4" />}
          label="Network"
          value={`${(latest.net.rxBps / 1024).toFixed(0)} KB/s`}
          sub={`↑ ${(latest.net.txBps / 1024).toFixed(0)} KB/s`}
        />
        <StatCard
          icon={<Clock className="h-4 w-4" />}
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
                  <stop offset="0%" stopColor="#22c55e" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="i" hide />
              <YAxis domain={[0, 100]} width={30} fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} />
              <Area
                type="monotone"
                dataKey="cpu"
                stroke="#22c55e"
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
                  <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="i" hide />
              <YAxis width={36} fontSize={11} />
              <Tooltip contentStyle={tooltipStyle} />
              <Area
                type="monotone"
                dataKey="rx"
                stroke="#3b82f6"
                fill="url(#netG)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">Disks</h3>
          <div className="space-y-2">
            {latest.disks.map((d) => {
              const pct = d.totalBytes
                ? (d.usedBytes / d.totalBytes) * 100
                : 0;
              return (
                <div key={d.mount} className="text-xs">
                  <div className="flex justify-between text-muted-foreground">
                    <span className="truncate">{d.mount}</span>
                    <span>
                      {fmtBytes(d.usedBytes)} / {fmtBytes(d.totalBytes)}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-muted">
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

        <div className="rounded-lg border bg-card p-4">
          <h3 className="mb-3 text-sm font-medium">Top processes</h3>
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr className="text-left">
                <th className="pb-1 font-normal">CPU%</th>
                <th className="pb-1 font-normal">MEM%</th>
                <th className="pb-1 font-normal">Command</th>
              </tr>
            </thead>
            <tbody>
              {latest.topProcesses.slice(0, 8).map((p) => (
                <tr key={p.pid} className="border-t border-border/40">
                  <td className="py-1 tabular-nums">{p.cpu.toFixed(1)}</td>
                  <td className="py-1 tabular-nums">{p.mem.toFixed(1)}</td>
                  <td className="truncate py-1 font-mono">{p.command}</td>
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
  background: '#18181b',
  border: '1px solid #27272a',
  borderRadius: 8,
  fontSize: 12,
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
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
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
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-2 text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}
