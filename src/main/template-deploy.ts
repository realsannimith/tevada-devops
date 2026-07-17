/**
 * Deterministic template deploys — the Dokploy model. No AI in the loop: the
 * app itself drives the server over SSH through a fixed pipeline (ensure
 * Docker → write the pre-generated files → `docker compose up -d` → verify →
 * publish web ports via a compose override), streaming step/log events to the
 * renderer as it goes.
 *
 * Everything nondeterministic (passwords, hostnames) is generated up front by
 * templates.ts's processor, so the run is reproducible and the summary can
 * list every credential. Server layout mirrors Dokploy so upstream compose
 * files work unchanged: compose + .env in <dir>/code/, file mounts in
 * <dir>/files/ (referenced from compose as ../files/<name>).
 */
import path from 'node:path';
import type { ConnectionManager } from './connection-manager';
import {
  fetchTemplateFiles,
  generateHash,
  listTemplates,
  processTemplate,
  type ProcessedTemplate,
} from './templates';
import type {
  ExecResult,
  ServerProfile,
  TemplateDeployEvent,
  TemplateDeployStepId,
  TemplateDeploySummary,
  TemplateMeta,
  TemplateDeployRequest,
} from '../shared/ipc-types';

const APPS_ROOT = '/opt/easyhost/apps';
const DOCKER_INSTALL_TIMEOUT_MS = 10 * 60_000;
const COMPOSE_UP_TIMEOUT_MS = 15 * 60_000;
const VERIFY_ATTEMPTS = 10;
const VERIFY_INTERVAL_MS = 3_000;
const SAFE_DEPLOY_ID = /^template_[0-9a-f-]{36}$/i;
const SAFE_TEMPLATE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const SAFE_SERVICE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

type Deps = {
  cm: ConnectionManager;
  connect: (serverId: string) => Promise<{ ok: boolean; error?: string }>;
  getServer: (serverId: string) => ServerProfile | undefined;
  send: (event: TemplateDeployEvent) => void;
};

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Ports already listening on the server, parsed from `ss -tlnp` (or netstat)
 *  output — any token ending in ":<port>" in the local-address column. */
export function parseListeningPorts(output: string): Set<number> {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    for (const col of cols) {
      const m = /^(?:.*):(\d{1,5})$/.exec(col);
      if (m) {
        const p = Number(m[1]);
        if (p >= 1 && p <= 65535) ports.add(p);
      }
    }
  }
  return ports;
}

/** Dokploy's rule, deterministically: the container port itself when free,
 *  otherwise the next free port after it. */
export function pickHostPort(
  containerPort: number,
  taken: Set<number>,
): number {
  let candidate = containerPort;
  while (taken.has(candidate) || candidate < 1024) {
    candidate = candidate < 1024 ? 1024 : candidate + 1;
    if (candidate > 65535) throw new Error('No free port found.');
  }
  return candidate;
}

/** docker-compose.override.yml publishing one host port per web service. */
export function buildOverrideYaml(
  mappings: Array<{ serviceName: string; hostPort: number; containerPort: number }>,
): string {
  const lines = ['services:'];
  for (const m of mappings) {
    lines.push(`  ${m.serviceName}:`);
    lines.push('    ports:');
    lines.push(`      - "${m.hostPort}:${m.containerPort}"`);
  }
  return lines.join('\n') + '\n';
}

/** Parse `docker compose ps --format json` (one JSON object per line on
 *  compose v2.21+, a JSON array on some builds). Unknown output → []. */
export function parseComposePs(
  stdout: string,
): Array<{ name: string; state: string; health?: string }> {
  const services: Array<{ name: string; state: string; health?: string }> = [];
  const push = (row: unknown) => {
    if (row && typeof row === 'object') {
      const r = row as {
        Name?: string;
        Service?: string;
        State?: string;
        Health?: string;
      };
      services.push({
        name: r.Service || r.Name || 'unknown',
        state: (r.State || 'unknown').toLowerCase(),
        ...(r.Health ? { health: r.Health.toLowerCase() } : {}),
      });
    }
  };
  const text = stdout.trim();
  if (!text) return services;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) parsed.forEach(push);
    else push(parsed);
    return services;
  } catch {
    // line-delimited JSON
  }
  for (const line of text.split('\n')) {
    try {
      push(JSON.parse(line));
    } catch {
      // ignore non-JSON lines (warnings etc.)
    }
  }
  return services;
}

/** Deployment readiness from one `docker compose ps --all --format json` sample.
 * Health-checks may remain `starting` for a while, so callers retry pending
 * samples but fail immediately for terminal/broken states. */
export function composeReadiness(
  services: Array<{ name: string; state: string; health?: string }>,
): { ready: boolean; pending: boolean; error?: string } {
  if (services.length === 0) {
    return { ready: false, pending: true, error: 'No services were reported.' };
  }
  const broken = services.filter(
    (service) => !['running', 'up'].includes(service.state),
  );
  if (broken.length > 0) {
    return {
      ready: false,
      pending: false,
      error: `${broken.map((s) => `${s.name} (${s.state})`).join(', ')} not running.`,
    };
  }
  const unhealthy = services.filter((service) => service.health === 'unhealthy');
  if (unhealthy.length > 0) {
    return {
      ready: false,
      pending: false,
      error: `${unhealthy.map((s) => s.name).join(', ')} unhealthy.`,
    };
  }
  const starting = services.filter((service) => service.health === 'starting');
  if (starting.length > 0) {
    return {
      ready: false,
      pending: true,
      error: `${starting.map((s) => s.name).join(', ')} still starting.`,
    };
  }
  return { ready: true, pending: false };
}

/** Registry mount paths must stay beneath <app>/files. */
export function safeMountPath(filePath: string): string {
  const normalized = path.posix.normalize(filePath.trim());
  if (
    !normalized ||
    normalized === '.' ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    !/^[a-z0-9._/-]+$/i.test(normalized)
  ) {
    throw new StepError(`Unsafe template mount path: ${filePath}`);
  }
  return normalized;
}

export function parseTemplateCredentials(
  envs: string[],
): Array<{ key: string; value: string }> {
  return envs
    .map((line) => {
      const idx = line.indexOf('=');
      return idx > 0
        ? { key: line.slice(0, idx), value: line.slice(idx + 1) }
        : null;
    })
    .filter((entry): entry is { key: string; value: string } => entry !== null);
}

/** Do not let a container that echoes its configuration copy generated secret
 * values into the renderer log or unencrypted History transcript. */
export function redactSensitiveText(
  text: string,
  credentials: Array<{ key: string; value: string }>,
): string {
  let redacted = text;
  for (const credential of credentials) {
    if (
      credential.value.length >= 4 &&
      /pass|secret|key|token|jwt/i.test(credential.key)
    ) {
      redacted = redacted.replaceAll(credential.value, '[REDACTED]');
    }
  }
  return redacted;
}

// ---------------------------------------------------------------------------
// Deploy manager
// ---------------------------------------------------------------------------

/** Thrown to fail the current step with a user-facing message. */
class StepError extends Error {}

export class TemplateDeployManager {
  private readonly deps: Deps;
  private readonly active = new Map<string, AbortController>();

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** Kick off a deploy; progress arrives as evtTemplateDeploy events. */
  start(req: TemplateDeployRequest): { deployId: string } {
    if (!SAFE_DEPLOY_ID.test(req.deployId)) {
      throw new Error('Invalid template deploy id.');
    }
    if (!SAFE_TEMPLATE_ID.test(req.templateId)) {
      throw new Error('Invalid template id.');
    }
    if (this.active.has(req.deployId)) {
      throw new Error('This template deploy is already running.');
    }
    const deployId = req.deployId;
    const abort = new AbortController();
    this.active.set(deployId, abort);
    void this.run(deployId, req, abort.signal).finally(() => {
      this.active.delete(deployId);
    });
    return { deployId };
  }

  cancel(deployId: string): { ok: boolean } {
    const abort = this.active.get(deployId);
    if (!abort) return { ok: false };
    abort.abort();
    return { ok: true };
  }

  private async run(
    deployId: string,
    req: TemplateDeployRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const { cm, connect, getServer, send } = this.deps;
    const emit = (event: TemplateDeployEvent) => send(event);
    let credentials: Array<{ key: string; value: string }> = [];
    const log = (text: string) =>
      emit({
        deployId,
        type: 'log',
        text: redactSensitiveText(text, credentials),
      });
    const step = (
      id: TemplateDeployStepId,
      status: 'running' | 'done' | 'failed' | 'skipped',
      detail?: string,
    ) => emit({ deployId, type: 'step', step: id, status, detail });

    /** exec that logs the command, checks cancellation, and returns output. */
    const exec = async (
      command: string,
      opts: { timeoutMs?: number; quiet?: boolean } = {},
    ): Promise<ExecResult> => {
      if (signal.aborted) throw new StepError('Cancelled.');
      if (!opts.quiet) log(`$ ${command}`);
      const res = await cm.exec(req.serverId, command, {
        signal,
        timeoutMs: opts.timeoutMs ?? 120_000,
        maxOutputBytes: 512 * 1024,
      });
      const out = `${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`.trim();
      if (out && !opts.quiet) log(out);
      return res;
    };

    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new StepError('Cancelled.'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(new StepError('Cancelled.'));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
      });

    let current: TemplateDeployStepId = 'connect';
    try {
      // --- connect ---------------------------------------------------------
      step('connect', 'running');
      const server = getServer(req.serverId);
      if (!server) throw new StepError('Unknown server.');
      const conn = await connect(req.serverId);
      if (!conn.ok) {
        throw new StepError(conn.error ?? 'Could not connect to the server.');
      }
      step('connect', 'done', server.name);

      // Blueprint + generated secrets/domains, all up front.
      const files = await fetchTemplateFiles(req.templateId);
      const catalog = await listTemplates().catch((): TemplateMeta[] => []);
      const meta = catalog.find((t) => t.id === req.templateId);
      const serverIp = /^[0-9a-fA-F.:]+$/.test(server.host) ? server.host : '';
      const appName = `${req.templateId}-${generateHash(6)}`;
      const appDir = `${APPS_ROOT}/${appName}`;
      const processed: ProcessedTemplate = processTemplate(files.config, {
        serverIp,
        projectName: req.templateId,
      });
      credentials = parseTemplateCredentials(processed.envs);
      log(`Deploying ${meta?.name ?? req.templateId} → ${appDir}`);
      for (const domain of processed.domains) {
        if (!SAFE_SERVICE_NAME.test(domain.serviceName)) {
          throw new StepError(
            `Template contains an unsafe service name: ${domain.serviceName}`,
          );
        }
        if (!Number.isInteger(domain.port) || domain.port < 1 || domain.port > 65535) {
          throw new StepError(
            `Template contains an invalid port for ${domain.serviceName}.`,
          );
        }
      }

      // Commands that need root: plain when we are root, `sudo -n` otherwise.
      const uid = await exec('id -u', { quiet: true });
      const asRoot = (cmd: string) =>
        uid.stdout.trim() === '0' ? cmd : `sudo -n ${cmd}`;

      // --- docker ----------------------------------------------------------
      current = 'docker';
      step('docker', 'running');
      const probe = await exec(
        'docker --version && docker compose version',
        { quiet: true },
      );
      if (probe.exitCode === 0) {
        log(probe.stdout.trim());
        step('docker', 'done', 'already installed');
      } else {
        log('Docker not found — installing via get.docker.com…');
        const install = await exec(
          asRoot('sh -c "curl -fsSL https://get.docker.com | sh"'),
          { timeoutMs: DOCKER_INSTALL_TIMEOUT_MS },
        );
        if (install.exitCode !== 0) {
          throw new StepError(
            'Docker install failed. Install Docker manually and retry.',
          );
        }
        await exec(
          asRoot('sh -c "systemctl enable --now docker || service docker start"'),
        );
        const recheck = await exec(
          'docker --version && docker compose version',
          { quiet: true },
        );
        if (recheck.exitCode !== 0) {
          throw new StepError(
            'Docker still is not runnable after install. Install it manually and retry.',
          );
        }
        step('docker', 'done', 'installed');
      }
      // Non-root users usually need sudo for the docker CLI itself.
      const dockerProbe = await exec('docker ps -q', { quiet: true });
      const docker = (cmd: string) =>
        dockerProbe.exitCode === 0 ? cmd : asRoot(cmd);

      // --- files -----------------------------------------------------------
      current = 'files';
      step('files', 'running');
      const dirs = [`${appDir}/code`].concat(
        processed.mounts.length ? [`${appDir}/files`] : [],
      );
      const mk = await exec(asRoot(`mkdir -p ${dirs.join(' ')}`));
      if (mk.exitCode !== 0) {
        throw new StepError(`Could not create ${appDir} on the server.`);
      }
      // SFTP writes run as the login user; make sure it owns the tree.
      const who = await exec('whoami', { quiet: true });
      const owner = who.stdout.trim();
      if (owner && owner !== 'root') {
        await exec(asRoot(`chown -R ${owner} ${appDir}`), { quiet: true });
      }
      const writes: Array<[string, string, number?]> = [
        [`${appDir}/code/docker-compose.yml`, files.dockerCompose],
        [
          `${appDir}/code/.env`,
          processed.envs.join('\n') + (processed.envs.length ? '\n' : ''),
          0o600,
        ],
        ...processed.mounts.map((m): [string, string] => [
          `${appDir}/files/${safeMountPath(m.filePath)}`,
          m.content,
        ]),
      ];
      for (const [remotePath, content, mode] of writes) {
        // Mount paths may be nested (files/foo/bar.conf).
        const parent = path.posix.dirname(remotePath);
        if (parent !== `${appDir}/code` && parent !== `${appDir}/files`) {
          await exec(`mkdir -p ${parent}`, { quiet: true });
        }
        log(`write ${remotePath}`);
        await cm.sftpWriteFile(
          req.serverId,
          remotePath,
          content,
          mode ? { mode } : undefined,
        );
      }
      const protectEnv = await exec(
        asRoot(`chmod 600 ${appDir}/code/.env`),
        { quiet: true },
      );
      if (protectEnv.exitCode !== 0) {
        throw new StepError('Could not protect the generated .env file.');
      }
      step('files', 'done', `${writes.length} files`);

      // --- start -----------------------------------------------------------
      current = 'start';
      step('start', 'running');
      const up = await exec(
        docker(`sh -c "cd ${appDir}/code && docker compose up -d"`),
        { timeoutMs: COMPOSE_UP_TIMEOUT_MS },
      );
      if (up.exitCode !== 0) {
        throw new StepError(
          'docker compose up failed — see the log above for the reason.',
        );
      }
      step('start', 'done');

      // --- verify ----------------------------------------------------------
      current = 'verify';
      step('verify', 'running');
      const inspectServices = async () => {
        let last: ReturnType<typeof parseComposePs> = [];
        let lastError = 'No services were reported.';
        for (let attempt = 0; attempt < VERIFY_ATTEMPTS; attempt += 1) {
          const ps = await exec(
            docker(
              `sh -c "cd ${appDir}/code && docker compose ps --all --format json"`,
            ),
            { quiet: true },
          );
          if (ps.exitCode !== 0) {
            throw new StepError('Could not inspect the deployed services.');
          }
          last = parseComposePs(ps.stdout);
          const readiness = composeReadiness(last);
          if (readiness.ready) return last;
          lastError = readiness.error ?? 'Services are not ready.';
          if (!readiness.pending) break;
          if (attempt < VERIFY_ATTEMPTS - 1) await wait(VERIFY_INTERVAL_MS);
        }
        await exec(
          docker(`sh -c "cd ${appDir}/code && docker compose logs --tail 40"`),
        );
        throw new StepError(`${lastError} See the log above.`);
      };
      let services = await inspectServices();
      for (const s of services) {
        log(`service ${s.name}: ${s.state}${s.health ? ` (${s.health})` : ''}`);
      }
      step('verify', 'done', `${services.length || '?'} services running`);

      // --- expose ----------------------------------------------------------
      current = 'expose';
      const urls: TemplateDeploySummary['urls'] = [];
      if (processed.domains.length === 0) {
        step('expose', 'skipped', 'no web service');
      } else {
        step('expose', 'running');
        const ss = await exec(
          'ss -tlnp 2>/dev/null || netstat -tln 2>/dev/null || true',
          { quiet: true },
        );
        const taken = parseListeningPorts(ss.stdout);
        const mappings: Array<{
          serviceName: string;
          hostPort: number;
          containerPort: number;
        }> = [];
        for (const d of processed.domains) {
          const hostPort = pickHostPort(d.port, taken);
          taken.add(hostPort);
          mappings.push({
            serviceName: d.serviceName,
            hostPort,
            containerPort: d.port,
          });
          urls.push({
            serviceName: d.serviceName,
            url: `http://${server.host}:${hostPort}${d.path ?? ''}`,
            hostname: d.host,
          });
        }
        const override = buildOverrideYaml(mappings);
        log(`write ${appDir}/code/docker-compose.override.yml`);
        await cm.sftpWriteFile(
          req.serverId,
          `${appDir}/code/docker-compose.override.yml`,
          override,
        );
        const reup = await exec(
          docker(`sh -c "cd ${appDir}/code && docker compose up -d"`),
          { timeoutMs: COMPOSE_UP_TIMEOUT_MS },
        );
        if (reup.exitCode !== 0) {
          throw new StepError('Publishing ports failed — see the log above.');
        }
        services = await inspectServices();
        step(
          'expose',
          'done',
          mappings.map((m) => `:${m.hostPort}`).join(' '),
        );
      }

      // --- done ------------------------------------------------------------
      emit({
        deployId,
        type: 'done',
        summary: { appName, appDir, urls, credentials, services },
      });
    } catch (err) {
      if (signal.aborted) {
        step(current, 'failed', 'cancelled');
        emit({ deployId, type: 'cancelled' });
        return;
      }
      const message =
        err instanceof StepError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      step(current, 'failed', message);
      emit({ deployId, type: 'error', error: message });
    }
  }
}
