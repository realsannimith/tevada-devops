/**
 * Server artifact scanner. One combined exec (single SSH round-trip, same
 * pattern as monitor.ts) probes what is actually deployed on the box —
 * docker containers, nginx sites, hosting-relevant systemd services,
 * listening ports and cron backups — and a pure parser turns the output
 * into ServerArtifact rows for the renderer's Artifacts tab.
 */
import { ConnectionManager } from './connection-manager';
import {
  ArtifactsScanResult,
  ArtifactStatus,
  ServerArtifact,
} from '../shared/ipc-types';

const SEP = '===EH-ART===';
const FILE_MARK = '@@FILE ';

// Every section tolerates the tool being absent; sections are marker-separated
// so a missing/failed probe just yields an empty block.
const PROBE = [
  `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null`,
  `echo ${SEP}`,
  `for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do [ -f "$f" ] && { echo "${FILE_MARK.trim()} $f"; grep -E '^[[:space:]]*(server_name|listen|root|proxy_pass)' "$f"; }; done 2>/dev/null`,
  `echo ${SEP}`,
  `systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | grep -iE 'nginx|apache2|httpd|caddy|postgres|mysql|maria|redis|valkey|mongo|docker|pm2|fpm'`,
  `echo ${SEP}`,
  `ss -tlnp 2>/dev/null | tail -n +2`,
  `echo ${SEP}`,
  `for f in /etc/cron.d/*; do [ -f "$f" ] && { echo "${FILE_MARK.trim()} $f"; cat "$f"; }; done 2>/dev/null; echo "${FILE_MARK.trim()} crontab"; crontab -l 2>/dev/null`,
].join('; ');

// ---------------------------------------------------------------------------
// Pure parsers (unit-testable)
// ---------------------------------------------------------------------------

/** Loopback-only addresses aren't reachable from outside the server. */
function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, ''); // strip IPv6 brackets, e.g. "[::1]"
  return h === '127.0.0.1' || h === '::1' || h === 'localhost';
}

/** Icon hint from an image / unit / process name. */
function engineOf(source: string): string | undefined {
  const s = source.toLowerCase();
  if (s.includes('postgres')) return 'postgresql';
  if (s.includes('mysql') || s.includes('maria')) return 'mysql';
  if (s.includes('redis') || s.includes('valkey')) return 'redis';
  if (s.includes('mongo')) return 'mongodb';
  if (s.includes('node') || s.includes('pm2')) return 'node';
  if (s.includes('nginx') || s.includes('apache') || s.includes('httpd') || s.includes('caddy'))
    return 'web';
  if (s.includes('docker')) return 'docker';
  return undefined;
}

function parseContainers(block: string): ServerArtifact[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, i): ServerArtifact | null => {
      const [name, image, status, portsRaw] = line.split('\t');
      if (!name || !image) return null;
      // "0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp" — host may be IPv4,
      // bracketed IPv6, or a bare hostname; \S+ greedily backtracks onto it.
      const bindings = [...(portsRaw ?? '').matchAll(/(\S+):(\d+)->/g)].map(
        (m) => ({ host: m[1], port: Number(m[2]) }),
      );
      const ports = [...new Set(bindings.map((b) => b.port))];
      const engine = engineOf(image);
      return {
        id: `container:${name}:${i}`,
        kind: engine && engine !== 'docker' && engine !== 'web' && engine !== 'node'
          ? 'database'
          : 'container',
        name,
        engine: engine ?? 'docker',
        status: /^Up/i.test(status ?? '') ? 'running' : 'stopped',
        detail: image,
        meta: status || undefined,
        ports: ports.length ? ports : undefined,
        remoteAccessible: ports.length
          ? bindings.some((b) => !isLoopbackHost(b.host))
          : undefined,
      };
    })
    .filter((a): a is ServerArtifact => a !== null);
}

function parseNginxSites(block: string, webRunning: boolean): ServerArtifact[] {
  const sites: ServerArtifact[] = [];
  let file: string | null = null;
  let names: string[] = [];
  let ports: number[] = [];
  let root: string | undefined;
  let proxy: string | undefined;

  const flush = () => {
    if (!file) return;
    const base = file.split('/').pop() ?? file;
    const name = names.find((n) => n !== '_') ?? base;
    sites.push({
      id: `website:${file}`,
      kind: 'website',
      name,
      engine: 'web',
      status: webRunning ? 'running' : 'unknown',
      detail: proxy ? `proxy → ${proxy}` : root,
      meta: file,
      ports: ports.length ? [...new Set(ports)] : undefined,
    });
  };

  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(FILE_MARK.trim())) {
      flush();
      file = line.slice(FILE_MARK.trim().length).trim();
      names = [];
      ports = [];
      root = undefined;
      proxy = undefined;
      continue;
    }
    const directive = line.replace(/;$/, '');
    if (directive.startsWith('server_name')) {
      names.push(
        ...directive.replace('server_name', '').trim().split(/\s+/).filter(Boolean),
      );
    } else if (directive.startsWith('listen')) {
      const m = directive.match(/(\d+)(?:\s|$|\sssl)/);
      const port = m ? Number(m[1]) : NaN;
      if (!Number.isNaN(port)) ports.push(port);
    } else if (directive.startsWith('root') && !root) {
      root = directive.replace('root', '').trim();
    } else if (directive.startsWith('proxy_pass') && !proxy) {
      proxy = directive.replace('proxy_pass', '').trim();
    }
  }
  flush();
  return sites;
}

type ServiceRow = { unit: string; sub: string; description: string };

function parseServiceRows(block: string): ServiceRow[] {
  return block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // unit load active sub description…
      const parts = line.replace(/^[●○x*]\s+/, '').split(/\s+/);
      if (parts.length < 4 || !parts[0].endsWith('.service')) return null;
      return {
        unit: parts[0].replace(/\.service$/, ''),
        sub: parts[3],
        description: parts.slice(4).join(' '),
      };
    })
    .filter((r): r is ServiceRow => r !== null);
}

type ProcPort = { port: number; remote: boolean };

function parsePorts(block: string): Map<string, ProcPort[]> {
  // LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))
  const byProc = new Map<string, ProcPort[]>();
  for (const line of block.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    const portMatch = cols[3].match(/:(\d+)$/);
    const procMatch = line.match(/users:\(\("([^"]+)"/);
    if (!portMatch || !procMatch) continue;
    const port = Number(portMatch[1]);
    const host = cols[3].slice(0, cols[3].length - portMatch[0].length);
    const remote = !isLoopbackHost(host);
    const proc = procMatch[1];
    const list = byProc.get(proc) ?? [];
    if (!list.some((p) => p.port === port)) list.push({ port, remote });
    byProc.set(proc, list);
  }
  return byProc;
}

const DB_UNITS = /postgres|mysql|maria|redis|valkey|mongo/i;
const PORT_PROCS: Record<string, RegExp> = {
  postgresql: /^postgres/,
  mysql: /^(mysqld|mariadbd)/,
  redis: /^(redis|valkey)/,
  mongodb: /^mongod/,
  web: /^(nginx|apache2|httpd|caddy)/,
};

function parseServices(
  block: string,
  portsByProc: Map<string, ProcPort[]>,
): ServerArtifact[] {
  const portsFor = (
    engine: string | undefined,
  ): { ports: number[]; remoteAccessible: boolean } | undefined => {
    const re = engine ? PORT_PROCS[engine] : undefined;
    if (!re) return undefined;
    const entries = [...portsByProc.entries()]
      .filter(([proc]) => re.test(proc))
      .flatMap(([, p]) => p);
    if (!entries.length) return undefined;
    return {
      ports: [...new Set(entries.map((e) => e.port))].sort((a, b) => a - b),
      remoteAccessible: entries.some((e) => e.remote),
    };
  };

  return parseServiceRows(block).map((r): ServerArtifact => {
    const engine = engineOf(r.unit);
    const status: ArtifactStatus = r.sub === 'running' ? 'running' : 'stopped';
    const portInfo = portsFor(engine);
    return {
      id: `service:${r.unit}`,
      kind: DB_UNITS.test(r.unit) ? 'database' : 'service',
      name: r.unit,
      engine,
      status,
      detail: r.description || undefined,
      ports: portInfo?.ports,
      remoteAccessible: portInfo?.remoteAccessible,
    };
  });
}

const BACKUP_HINT = /backup|dump|rsync|restic|borg/i;
const CRON_LINE = /^(@\w+|[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+)\s+/;

function parseBackups(block: string): ServerArtifact[] {
  const backups: ServerArtifact[] = [];
  let file = 'crontab';
  for (const raw of block.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith(FILE_MARK.trim())) {
      file = line.slice(FILE_MARK.trim().length).trim();
      continue;
    }
    const m = line.match(CRON_LINE);
    if (!m || !BACKUP_HINT.test(line)) continue;
    let command = line.slice(m[0].length).trim();
    // /etc/cron.d entries carry a user field before the command.
    if (file !== 'crontab') command = command.replace(/^\S+\s+/, '');
    const script = command.match(/(\S*\/)?(\S+\.sh)/)?.[2];
    backups.push({
      id: `backup:${file}:${backups.length}`,
      kind: 'backup',
      name: script ?? file.split('/').pop() ?? 'backup job',
      status: 'scheduled',
      detail: command.length > 120 ? `${command.slice(0, 117)}…` : command,
      meta: `${m[1]} · ${file}`,
    });
  }
  return backups;
}

/** Parse the combined probe output into the artifact inventory. */
export function parseArtifacts(raw: string): ServerArtifact[] {
  const [dockerBlk, nginxBlk, svcBlk, ssBlk, cronBlk] = raw
    .split(SEP)
    .map((s) => s.trim());

  const portsByProc = parsePorts(ssBlk ?? '');
  const services = parseServices(svcBlk ?? '', portsByProc);
  const webRunning = services.some(
    (s) => s.engine === 'web' && s.status === 'running',
  );

  return [
    ...parseNginxSites(nginxBlk ?? '', webRunning),
    ...parseContainers(dockerBlk ?? ''),
    ...services,
    ...parseBackups(cronBlk ?? ''),
  ];
}

// ---------------------------------------------------------------------------
// Scan entry point
// ---------------------------------------------------------------------------

export async function scanArtifacts(
  cm: ConnectionManager,
  serverId: string,
): Promise<ArtifactsScanResult> {
  if (cm.getStatus(serverId) !== 'connected') {
    return { ok: false, error: 'Server is not connected.' };
  }
  try {
    const res = await cm.exec(serverId, PROBE, {
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024,
    });
    return { ok: true, ts: Date.now(), artifacts: parseArtifacts(res.stdout) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Scan failed.',
    };
  }
}
