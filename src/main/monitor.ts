/**
 * Per-server monitoring poller. Each tick runs ONE combined exec (single SSH
 * round-trip) and parses standard Linux command output into ServerStats. CPU% is
 * derived from the delta between two consecutive /proc/stat samples, so the first
 * tick reports 0 and subsequent ticks report real utilization.
 */
import { ConnectionManager } from './connection-manager';
import {
  DiskUsage,
  HostInfo,
  ProcessInfo,
  ServerStats,
} from '../shared/ipc-types';

const SEP = '===EH-SEP===';

// Combined probe. Sections are separated by an echoed marker so parsing is robust.
const PROBE = [
  'cat /proc/stat | grep "^cpu "',
  `echo ${SEP}`,
  'free -b',
  `echo ${SEP}`,
  'df -B1 -x tmpfs -x devtmpfs -x overlay 2>/dev/null',
  `echo ${SEP}`,
  'cat /proc/net/dev',
  `echo ${SEP}`,
  'cat /proc/uptime',
  `echo ${SEP}`,
  'cat /proc/loadavg',
  `echo ${SEP}`,
  'ps -eo user,pid,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -n 11',
  `echo ${SEP}`,
  // Static hardware facts (cores / vendor / arch). Cheap enough to re-read each
  // tick, and doing so keeps them correct across a reconnect to a resized box.
  'echo cores=$(nproc 2>/dev/null); echo arch=$(uname -m 2>/dev/null); grep -m1 "^vendor_id" /proc/cpuinfo 2>/dev/null; grep -m1 "^model name" /proc/cpuinfo 2>/dev/null',
].join('; ');

type CpuSample = { total: number; idle: number };
type NetSample = { rx: number; tx: number; ts: number };

type MonState = {
  timer: NodeJS.Timeout;
  /** Current poll cadence; tracked so start() can reconfigure a live poller
   *  when the user changes the interval in Settings instead of ignoring it. */
  intervalMs: number;
  inFlight: boolean;
  tick: () => Promise<void>;
  prevCpu?: CpuSample;
  prevNet?: NetSample;
};

// ---------------------------------------------------------------------------
// Pure parsers (unit-testable)
// ---------------------------------------------------------------------------

function parseCpuLine(line: string): CpuSample | undefined {
  // cpu  user nice system idle iowait irq softirq steal guest guest_nice
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 4 || parts.some(Number.isNaN)) return undefined;
  const idle = parts[3] + (parts[4] ?? 0); // idle + iowait
  const total = parts.reduce((a, b) => a + b, 0);
  return { total, idle };
}

function parseMem(block: string): { usedBytes: number; totalBytes: number } {
  // "Mem:  total used free shared buff/cache available"
  const line = block
    .split('\n')
    .find((l) => l.trim().startsWith('Mem:'));
  if (!line) return { usedBytes: 0, totalBytes: 0 };
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const total = n[0] ?? 0;
  const available = n[5] ?? n[2] ?? 0; // available, fall back to free
  return { usedBytes: Math.max(0, total - available), totalBytes: total };
}

function parseDisks(block: string): DiskUsage[] {
  return block
    .split('\n')
    .slice(1) // header
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((c) => c.length >= 6)
    .map((c) => ({
      filesystem: c[0],
      totalBytes: Number(c[1]) || 0,
      usedBytes: Number(c[2]) || 0,
      mount: c[5],
    }))
    .filter((d) => d.totalBytes > 0);
}

function parseNetTotals(block: string): { rx: number; tx: number } {
  let rx = 0;
  let tx = 0;
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*([\w.-]+):\s*(.*)$/);
    if (!m) continue;
    const iface = m[1];
    if (iface === 'lo') continue;
    const nums = m[2].trim().split(/\s+/).map(Number);
    rx += nums[0] || 0; // bytes received
    tx += nums[8] || 0; // bytes transmitted
  }
  return { rx, tx };
}

function parseProcesses(block: string): ProcessInfo[] {
  return block
    .split('\n')
    .slice(1) // header
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/))
    .filter((c) => c.length >= 5)
    .map((c) => ({
      user: c[0],
      pid: c[1],
      cpu: Number(c[2]) || 0,
      mem: Number(c[3]) || 0,
      command: c.slice(4).join(' '),
    }));
}

/** Map a raw CPU vendor_id / model name to a friendly vendor label. */
function deriveVendor(vendorId: string, modelName: string, arch: string): string {
  const hay = `${vendorId} ${modelName}`.toLowerCase();
  if (hay.includes('intel')) return 'Intel';
  if (hay.includes('amd')) return 'AMD';
  if (arch.startsWith('aarch') || arch.startsWith('arm')) return 'ARM';
  // Unknown vendor: show the first token of the model name if we have one.
  return modelName.trim().split(/\s+/)[0] ?? '';
}

export function parseHost(block: string): HostInfo | undefined {
  if (!block) return undefined;
  let cores = 0;
  let arch = '';
  let vendorId = '';
  let modelName = '';
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('cores=')) cores = Number(line.slice(6)) || 0;
    else if (line.startsWith('arch=')) arch = line.slice(5).trim();
    else if (line.startsWith('vendor_id'))
      vendorId = line.split(':')[1]?.trim() ?? '';
    else if (line.toLowerCase().startsWith('model name'))
      modelName = line.split(':')[1]?.trim() ?? '';
  }
  if (!cores && !arch) return undefined;
  return { cores, vendor: deriveVendor(vendorId, modelName, arch), arch };
}

/**
 * Parse the combined probe output into ServerStats, using the previous CPU/net
 * samples to compute rates. Returns the stats plus the fresh samples to carry
 * forward.
 */
export function parseStats(
  raw: string,
  prevCpu: CpuSample | undefined,
  prevNet: NetSample | undefined,
  now: number,
): { stats: ServerStats; cpu?: CpuSample; net: NetSample } {
  const sections = raw.split(SEP).map((s) => s.trim());
  const [cpuBlk, memBlk, dfBlk, netBlk, uptimeBlk, loadBlk, psBlk, hostBlk] =
    sections;

  const cpu = parseCpuLine((cpuBlk || '').split('\n')[0] || '');
  let cpuPct = 0;
  if (cpu && prevCpu) {
    const totalDelta = cpu.total - prevCpu.total;
    const idleDelta = cpu.idle - prevCpu.idle;
    if (totalDelta > 0) {
      cpuPct = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
    }
  }

  const netTotals = parseNetTotals(netBlk || '');
  const net: NetSample = { rx: netTotals.rx, tx: netTotals.tx, ts: now };
  let rxBps = 0;
  let txBps = 0;
  if (prevNet) {
    const dt = (now - prevNet.ts) / 1000;
    if (dt > 0) {
      rxBps = Math.max(0, (net.rx - prevNet.rx) / dt);
      txBps = Math.max(0, (net.tx - prevNet.tx) / dt);
    }
  }

  const uptimeSec = Number((uptimeBlk || '').split(/\s+/)[0]) || 0;
  const loadParts = (loadBlk || '').split(/\s+/).map(Number);
  const loadAvg: [number, number, number] = [
    loadParts[0] || 0,
    loadParts[1] || 0,
    loadParts[2] || 0,
  ];

  const stats: ServerStats = {
    ts: now,
    cpuPct: Math.round(cpuPct * 10) / 10,
    mem: parseMem(memBlk || ''),
    disks: parseDisks(dfBlk || ''),
    net: { rxBps: Math.round(rxBps), txBps: Math.round(txBps) },
    uptimeSec,
    loadAvg,
    topProcesses: parseProcesses(psBlk || ''),
  };

  const host = parseHost(hostBlk || '');
  if (host) stats.host = host;

  return { stats, cpu, net };
}

// ---------------------------------------------------------------------------
// Monitor manager
// ---------------------------------------------------------------------------

export class Monitor {
  private states = new Map<string, MonState>();
  private latest = new Map<string, ServerStats>();

  constructor(
    private cm: ConnectionManager,
    private onStats: (serverId: string, stats: ServerStats) => void,
    private nowFn: () => number = () => Date.now(),
  ) {}

  getLatest(serverId: string): ServerStats | undefined {
    return this.latest.get(serverId);
  }

  start(serverId: string, intervalMs: number): void {
    const existing = this.states.get(serverId);
    if (existing) {
      // Already polling. Reconfigure the cadence if it changed (Settings →
      // poll interval); otherwise this is a harmless no-op. Note: we keep a
      // live timer across an unexpected SSH drop on purpose — each tick
      // short-circuits while disconnected and resumes automatically once the
      // connection is back.
      if (existing.intervalMs !== intervalMs) {
        clearInterval(existing.timer);
        existing.intervalMs = intervalMs;
        existing.timer = setInterval(existing.tick, intervalMs);
      }
      return;
    }
    const tick = async () => {
      const st = this.states.get(serverId);
      if (!st || st.inFlight) return;
      if (this.cm.getStatus(serverId) !== 'connected') return;
      st.inFlight = true;
      try {
        const res = await this.cm.exec(serverId, PROBE, {
          timeoutMs: Math.max(8000, st.intervalMs * 2),
          maxOutputBytes: 128 * 1024,
        });
        const { stats, cpu, net } = parseStats(
          res.stdout,
          st.prevCpu,
          st.prevNet,
          this.nowFn(),
        );
        st.prevCpu = cpu;
        st.prevNet = net;
        this.latest.set(serverId, stats);
        this.onStats(serverId, stats);
      } catch {
        /* transient — try again next tick */
      } finally {
        const cur = this.states.get(serverId);
        if (cur) cur.inFlight = false;
      }
    };
    const timer = setInterval(tick, intervalMs);
    this.states.set(serverId, { timer, intervalMs, inFlight: false, tick });
    void tick();
  }

  /** Apply a new poll cadence to every live poller (e.g. the user changed the
   *  interval in Settings). start() reconfigures each existing poller in place. */
  reconfigureAll(intervalMs: number): void {
    for (const serverId of [...this.states.keys()]) {
      this.start(serverId, intervalMs);
    }
  }

  stop(serverId: string): void {
    const st = this.states.get(serverId);
    if (st) {
      clearInterval(st.timer);
      this.states.delete(serverId);
    }
  }

  stopAll(): void {
    for (const id of [...this.states.keys()]) this.stop(id);
  }
}
