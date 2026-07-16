/**
 * Open-source app templates — the Dokploy template format, deployed by our
 * agent instead of a built-in orchestrator.
 *
 * A template is pure data hosted in a registry (default: the MIT-licensed
 * Dokploy catalog at templates.dokploy.com): one `meta.json` index plus, per
 * app, `blueprints/<id>/template.toml` (variables + domains/env/mounts) and
 * `blueprints/<id>/docker-compose.yml`. Deploying one is a normal agent run
 * seeded with buildTemplatePrompt() output — exactly like wizard playbooks,
 * except the prompt carries pre-generated files and secrets rather than steps
 * derived from form answers.
 *
 * Fetches are cached under <userData>/templates so the gallery keeps working
 * offline; a small curated set is baked in (templates-fallback.ts) for the
 * first run. Variable expansion (${domain}, ${password:N}, ${base64}, …) is a
 * port of Dokploy's processor (apps/dokploy packages/server, MIT).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { parse as parseToml } from 'smol-toml';
import { TemplateMeta } from '../shared/ipc-types';
import { FALLBACK_TEMPLATES } from './templates-fallback';

export const DEFAULT_TEMPLATE_REGISTRY = 'https://templates.dokploy.com';

const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Registry fetch + cache
// ---------------------------------------------------------------------------

/** Raw meta.json row as served by the registry. */
type RegistryMeta = {
  id: string;
  name: string;
  version?: string;
  description?: string;
  logo?: string;
  links?: { github?: string; website?: string; docs?: string };
  tags?: string[];
};

/** template.toml, parsed. Mirrors Dokploy's CompleteTemplate config section. */
export type TemplateConfig = {
  variables?: Record<string, string>;
  config?: {
    domains?: Array<{
      serviceName: string;
      port: number;
      path?: string;
      host?: string;
    }>;
    env?:
      | Record<string, string | number | boolean>
      | Array<string | Record<string, string | number | boolean>>;
    mounts?: Array<{ filePath: string; content: string }>;
  };
};

export type TemplateFiles = {
  config: TemplateConfig;
  dockerCompose: string;
};

function cacheDir(): string {
  return path.join(app.getPath('userData'), 'templates');
}

async function readCache(name: string): Promise<string | null> {
  try {
    return await readFile(path.join(cacheDir(), name), 'utf8');
  } catch {
    return null;
  }
}

async function writeCache(name: string, content: string): Promise<void> {
  const file = path.join(cacheDir(), name);
  try {
    if (!existsSync(path.dirname(file))) {
      await mkdir(path.dirname(file), { recursive: true });
    }
    await writeFile(file, content, 'utf8');
  } catch {
    // Cache is best-effort; a failed write only costs offline availability.
  }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

function toMeta(raw: RegistryMeta, baseUrl: string): TemplateMeta {
  return {
    id: raw.id,
    name: raw.name || raw.id,
    version: raw.version || 'latest',
    description: raw.description ?? '',
    logoUrl: raw.logo
      ? `${baseUrl}/blueprints/${raw.id}/${raw.logo}`
      : undefined,
    links: raw.links ?? {},
    tags: raw.tags ?? [],
  };
}

/**
 * The gallery index. Live registry first, then the on-disk cache of the last
 * successful fetch, then the baked-in curated set — the gallery never comes
 * back empty just because the machine is offline.
 */
export async function listTemplates(
  baseUrl = DEFAULT_TEMPLATE_REGISTRY,
): Promise<TemplateMeta[]> {
  try {
    const text = await fetchText(`${baseUrl}/meta.json`);
    const parsed = JSON.parse(text) as RegistryMeta[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('registry returned an empty template list');
    }
    await writeCache('meta.json', text);
    return parsed.map((raw) => toMeta(raw, baseUrl));
  } catch {
    const cached = await readCache('meta.json');
    if (cached) {
      try {
        return (JSON.parse(cached) as RegistryMeta[]).map((raw) =>
          toMeta(raw, baseUrl),
        );
      } catch {
        // fall through to the bundled set
      }
    }
    return FALLBACK_TEMPLATES.map((t) => toMeta(t.meta, baseUrl));
  }
}

/**
 * One template's blueprint files (template.toml + docker-compose.yml), with
 * the same live → cache → bundled fallback chain as the index.
 */
export async function fetchTemplateFiles(
  id: string,
  baseUrl = DEFAULT_TEMPLATE_REGISTRY,
): Promise<TemplateFiles> {
  let toml: string;
  let compose: string;
  try {
    [toml, compose] = await Promise.all([
      fetchText(`${baseUrl}/blueprints/${id}/template.toml`),
      fetchText(`${baseUrl}/blueprints/${id}/docker-compose.yml`),
    ]);
    await writeCache(`${id}.template.toml`, toml);
    await writeCache(`${id}.docker-compose.yml`, compose);
  } catch (err) {
    const cachedToml = await readCache(`${id}.template.toml`);
    const cachedCompose = await readCache(`${id}.docker-compose.yml`);
    if (cachedToml && cachedCompose) {
      toml = cachedToml;
      compose = cachedCompose;
    } else {
      const bundled = FALLBACK_TEMPLATES.find((t) => t.meta.id === id);
      if (!bundled) {
        throw new Error(
          `Template "${id}" could not be fetched and is not cached: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      toml = bundled.toml;
      compose = bundled.compose;
    }
  }
  return { config: parseToml(toml) as TemplateConfig, dockerCompose: compose };
}

// ---------------------------------------------------------------------------
// Variable processing (port of Dokploy's processor — MIT)
// ---------------------------------------------------------------------------

export type TemplateSchema = {
  serverIp: string;
  projectName: string;
};

export type ProcessedTemplate = {
  domains: Array<{ serviceName: string; port: number; path?: string; host: string }>;
  envs: string[];
  mounts: Array<{ filePath: string; content: string }>;
};

export function generateRandomDomain({
  serverIp,
  projectName,
}: TemplateSchema): string {
  const hash = randomBytes(3).toString('hex');
  const slugIp = serverIp.replaceAll('.', '-').replaceAll(':', '-');
  // DNS labels max out at 63 chars; leave room for hash + ip + ".sslip.io".
  const name = projectName.substring(0, 40);
  return `${name}-${hash}${slugIp === '' ? '' : `-${slugIp}`}.sslip.io`;
}

export function generateHash(length = 8): string {
  return randomBytes(Math.ceil(length / 2))
    .toString('hex')
    .substring(0, length);
}

export function generatePassword(length = 16): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export function generateBase64(bytes = 32): string {
  return randomBytes(bytes).toString('base64');
}

/** Expand ${...} utility generators and variable references in one value. */
export function processValue(
  value: string,
  variables: Record<string, string>,
  schema: TemplateSchema,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    if (varName === 'domain') return generateRandomDomain(schema);
    if (varName === 'base64') return generateBase64(32);
    if (varName.startsWith('base64:')) {
      return generateBase64(Number.parseInt(varName.split(':')[1], 10) || 32);
    }
    if (varName === 'password') return generatePassword(16);
    if (varName.startsWith('password:')) {
      return generatePassword(Number.parseInt(varName.split(':')[1], 10) || 16);
    }
    if (varName === 'hash') return generateHash();
    if (varName.startsWith('hash:')) {
      return generateHash(Number.parseInt(varName.split(':')[1], 10) || 8);
    }
    if (varName === 'uuid') return randomUUID();
    if (varName === 'timestamp' || varName === 'timestampms') {
      return Date.now().toString();
    }
    if (varName === 'timestamps') {
      return Math.round(Date.now() / 1000).toString();
    }
    if (varName === 'randomPort') {
      return (1024 + Math.floor(Math.random() * (65535 - 1024))).toString();
    }
    if (varName === 'username') return `user${generateHash(6)}`;
    if (varName === 'email') return `admin-${generateHash(6)}@example.com`;
    if (varName === 'jwt') return randomBytes(32).toString('hex');
    return varName in variables ? variables[varName] ?? match : match;
  });
}

function processVariables(
  template: TemplateConfig,
  schema: TemplateSchema,
): Record<string, string> {
  const variables: Record<string, string> = {};
  // First pass: expand generators so later references see final values.
  for (const [key, value] of Object.entries(template.variables ?? {})) {
    if (typeof value !== 'string') continue;
    variables[key] = processValue(value, variables, schema);
  }
  // Second pass: resolve variables that referenced other variables.
  for (const [key, value] of Object.entries(variables)) {
    variables[key] = processValue(value, variables, schema);
  }
  return variables;
}

export function processTemplate(
  template: TemplateConfig,
  schema: TemplateSchema,
): ProcessedTemplate {
  const variables = processVariables(template, schema);
  const config = template.config ?? {};

  const domains = (config.domains ?? [])
    .filter((d) => d.serviceName)
    .map((d) => ({
      ...d,
      host: d.host
        ? processValue(d.host, variables, schema)
        : generateRandomDomain(schema),
    }));

  let envs: string[] = [];
  if (Array.isArray(config.env)) {
    envs = config.env.map((env) => {
      if (typeof env === 'string') return processValue(env, variables, schema);
      const [key] = Object.keys(env);
      return key ? `${key}=${env[key]}` : String(env);
    });
  } else if (config.env) {
    envs = Object.entries(config.env).map(([key, value]) =>
      typeof value === 'string'
        ? `${key}=${processValue(value, variables, schema)}`
        : `${key}=${value}`,
    );
  }

  const mounts = (config.mounts ?? [])
    .filter((m) => m.filePath || m.content)
    .map((m) => ({
      filePath: processValue(m.filePath, variables, schema),
      content: processValue(m.content, variables, schema),
    }));

  return { domains, envs, mounts };
}

// ---------------------------------------------------------------------------
// Deploy prompt
// ---------------------------------------------------------------------------

/**
 * Deployment happens the same way every wizard works: the agent gets one
 * detailed prompt and drives the server over SSH. All secrets/domains are
 * already generated here, so the run is reproducible from the transcript.
 *
 * Layout on the server mirrors Dokploy so upstream compose files work as-is:
 * compose + .env live in <dir>/code/, file mounts in <dir>/files/ (compose
 * references them as ../files/<name>).
 */
export function buildTemplatePrompt(args: {
  meta: TemplateMeta;
  files: TemplateFiles;
  processed: ProcessedTemplate;
  appName: string;
  serverName: string;
}): string {
  const { meta, files, processed, appName, serverName } = args;
  const dir = `/opt/easyhost/apps/${appName}`;

  const mountBlocks = processed.mounts.map((m) =>
    [
      `File ${dir}/files/${m.filePath}:`,
      '```',
      m.content.trimEnd(),
      '```',
    ].join('\n'),
  );

  const domainLines = processed.domains.map(
    (d) =>
      `- service "${d.serviceName}" container port ${d.port}${
        d.path ? ` path ${d.path}` : ''
      } → suggested hostname ${d.host}`,
  );

  return [
    `You are deploying the open-source app "${meta.name}" (version ${meta.version}) on the server "${serverName}" with Docker Compose.`,
    `First call listServers and connect to it.`,
    ``,
    `All deployment files are pre-generated below — write them EXACTLY as given (use writeRemoteFile; do not reformat, re-indent, or substitute anything). App directory: ${dir}`,
    ``,
    `File ${dir}/code/docker-compose.yml:`,
    '```yaml',
    files.dockerCompose.trimEnd(),
    '```',
    ``,
    `File ${dir}/code/.env:`,
    '```',
    processed.envs.join('\n') || '# (no environment variables)',
    '```',
    ...(mountBlocks.length ? ['', ...mountBlocks] : []),
    ``,
    `Steps, verifying the exit code after each command:`,
    `1. Ensure Docker and the compose plugin are installed ('docker --version' and 'docker compose version'). If missing, install via the distro packages or the official get.docker.com script, then 'systemctl enable --now docker'.`,
    `2. Create the directories (${dir}/code${processed.mounts.length ? ` and ${dir}/files` : ''}) and write the files above verbatim.`,
    `3. From ${dir}/code, run 'docker compose up -d' and wait for it to finish pulling and starting.`,
    `4. Verify with 'docker compose ps' that every service is running (or healthy); check 'docker compose logs --tail 50' for crash loops and fix problems before continuing.`,
    processed.domains.length
      ? [
          `5. Make the app reachable. The compose file intentionally publishes no ports; the web-facing services are:`,
          ...domainLines,
          `   For each one: pick the container port above as the host port if it is free (check with ss -tlnp), otherwise a nearby free port, and publish it by writing ${dir}/code/docker-compose.override.yml with a 'ports:' entry for that service, then re-run 'docker compose up -d'.`,
          `   If nginx is already installed on this server, additionally create a server block proxying the suggested hostname to that port and reload nginx (the *.sslip.io hostnames resolve to this server automatically). Do NOT install nginx just for this.`,
          `6. Verify each service answers (curl -sI the published port on localhost) and report the final URL(s) the user should open — prefer http://<server-ip>:<published-port> and mention the sslip.io hostname when an nginx block was created.`,
        ].join('\n')
      : `5. This template exposes no web service; verify the containers are healthy and report how to use it.`,
    ``,
    `Finish with a plain-language summary for a non-expert: what was installed, where the files live (${dir}), the URL(s) to open, and every generated credential from the .env file above the user will need to log in (call them out explicitly — they are not stored anywhere else).`,
    `If some step fails and you cannot fix it, say clearly what failed and how to retry.`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}
