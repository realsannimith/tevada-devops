/**
 * Database credentials created by the "Set up a database" wizard (and the
 * agent generally), persisted so the user can retrieve them later from the
 * matching entry in the Artifacts tab instead of scrolling back through a
 * chat transcript. Mirrors the server-secret split: non-secret metadata
 * (host/port/engine/database/username) lives in the plain JSON store
 * (main/store.ts); the password itself is encrypted via OS keychain/keyring
 * (main/secrets.ts) and only ever leaves main on an explicit reveal call.
 */
import { ConnectionManager } from './connection-manager';
import * as secrets from './secrets';
import * as store from './store';
import {
  ContainerCredentialGuess,
  DatabaseCredential,
  DatabaseCredentialMeta,
  SaveDatabaseCredentialRequest,
} from '../shared/ipc-types';

function secretKey(id: string): string {
  return `dbcred:${id}`;
}

/** A host that is reachable only from outside this server (i.e. not loopback).
 *  Pure — exported for testing. */
export function isRemoteHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h !== '' && h !== '127.0.0.1' && h !== 'localhost' && h !== '::1';
}

/** Pure — exported for testing. Builds a ready-to-paste connection string. */
export function buildConnectionString(
  meta: Pick<DatabaseCredentialMeta, 'engine' | 'host' | 'port' | 'database' | 'username'>,
  password: string,
): string {
  const enc = encodeURIComponent(password);
  const db = meta.database ?? '';
  switch (meta.engine) {
    case 'postgresql':
      return `postgres://${meta.username ?? 'postgres'}:${enc}@${meta.host}:${meta.port}/${db}`;
    case 'mysql':
      return `mysql://${meta.username ?? 'root'}:${enc}@${meta.host}:${meta.port}/${db}`;
    case 'mongodb':
      return `mongodb://${meta.username ?? 'root'}:${enc}@${meta.host}:${meta.port}/${db}`;
    case 'redis':
      return `redis://:${enc}@${meta.host}:${meta.port}`;
    default:
      return `${meta.host}:${meta.port}`;
  }
}

/** Upserts by (serverId, engine, port) — see store.saveDbCredential.
 *  Splits the endpoint into internal + external (Dokploy-style): a remote host
 *  passed in `host` is recorded as `externalHost`, and the internal endpoint is
 *  pinned to 127.0.0.1 (what apps on the server / other containers use). */
export function saveDatabaseCredential(
  input: SaveDatabaseCredentialRequest,
): DatabaseCredentialMeta {
  const { password, host, externalHost, ...rest } = input;
  const hostIsRemote = isRemoteHost(host);
  const saved = store.saveDbCredential({
    ...rest,
    host: hostIsRemote ? '127.0.0.1' : host,
    externalHost: externalHost ?? (hostIsRemote ? host : undefined),
  });
  secrets.saveRawSecret(secretKey(saved.id), password);
  return saved;
}

export function listDatabaseCredentials(serverId: string): DatabaseCredentialMeta[] {
  return store.listDbCredentials(serverId);
}

/** See store.setDbCredentialExternalHost — used after enable-db-remote-access. */
export function setDatabaseCredentialExternalHost(
  serverId: string,
  engine: string,
  port: number,
  externalHost: string,
): void {
  store.setDbCredentialExternalHost(serverId, engine, port, externalHost);
}

export function revealDatabaseCredential(id: string): DatabaseCredential | undefined {
  const meta = store.getDbCredential(id);
  if (!meta) return undefined;
  const password = secrets.loadRawSecret(secretKey(id));
  if (password === undefined) return undefined;
  // Backward-compat: credentials saved before the internal/external split may
  // have had their host overwritten with the public IP. Treat a lone remote
  // host as the external endpoint and synthesize the internal 127.0.0.1 one.
  const internalHost = isRemoteHost(meta.host) ? '127.0.0.1' : meta.host;
  const externalHost =
    meta.externalHost ?? (isRemoteHost(meta.host) ? meta.host : undefined);
  return {
    ...meta,
    host: internalHost,
    externalHost,
    password,
    connectionString: buildConnectionString({ ...meta, host: internalHost }, password),
    externalConnectionString: externalHost
      ? buildConnectionString({ ...meta, host: externalHost }, password)
      : undefined,
  };
}

export function deleteDatabaseCredential(id: string): void {
  secrets.deleteRawSecret(secretKey(id));
  store.removeDbCredential(id);
}

/** Called when a server itself is removed, so its saved passwords don't
 *  linger orphaned in the OS keychain/keyring. */
export function deleteDatabaseCredentialsForServer(serverId: string): void {
  for (const meta of store.removeDbCredentialsForServer(serverId)) {
    secrets.deleteRawSecret(secretKey(meta.id));
  }
}

// ---------------------------------------------------------------------------
// Recovery: for a Docker-run database that predates this feature (or that
// Easy Host set up before this app ever learned to save credentials), the
// password is still sitting in the container's own config — this is how the
// official postgres/mariadb/mongo images and the Redis --requirepass flag
// take it in the first place. Reading it back means the user never has to
// retype a password they may not even remember.
// ---------------------------------------------------------------------------

function envValue(env: string[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const entry = env.find((e) => e.startsWith(`${key}=`));
    if (entry) return entry.slice(key.length + 1);
  }
  return undefined;
}

/** Pure — exported for testing. `env`/`cmd` mirror docker inspect's
 *  `.Config.Env` / `.Config.Cmd` arrays for the container. */
export function parseContainerCredentialGuess(
  engine: string,
  env: string[],
  cmd: string[],
): ContainerCredentialGuess | undefined {
  switch (engine) {
    case 'postgresql': {
      const password = envValue(env, 'POSTGRES_PASSWORD');
      if (!password) return undefined;
      return {
        password,
        username: envValue(env, 'POSTGRES_USER'),
        database: envValue(env, 'POSTGRES_DB'),
      };
    }
    case 'mysql': {
      const password = envValue(
        env,
        'MARIADB_PASSWORD',
        'MYSQL_PASSWORD',
        'MARIADB_ROOT_PASSWORD',
        'MYSQL_ROOT_PASSWORD',
      );
      if (!password) return undefined;
      return {
        password,
        username: envValue(env, 'MARIADB_USER', 'MYSQL_USER'),
        database: envValue(env, 'MARIADB_DATABASE', 'MYSQL_DATABASE'),
      };
    }
    case 'mongodb': {
      const password = envValue(env, 'MONGO_INITDB_ROOT_PASSWORD');
      if (!password) return undefined;
      return {
        password,
        username: envValue(env, 'MONGO_INITDB_ROOT_USERNAME'),
        database: envValue(env, 'MONGO_INITDB_DATABASE'),
      };
    }
    case 'redis': {
      const flagIdx = cmd.indexOf('--requirepass');
      const password =
        flagIdx >= 0 ? cmd[flagIdx + 1] : envValue(env, 'REDIS_PASSWORD');
      return password ? { password } : undefined;
    }
    default:
      return undefined;
  }
}

/** Reads the credential straight off a still-running Docker container via
 *  `docker inspect`. Returns undefined if the server is disconnected, the
 *  container is gone, or its config doesn't carry a recognizable password
 *  (e.g. it was created outside Easy Host with a custom setup). */
export async function recoverContainerCredential(
  cm: ConnectionManager,
  serverId: string,
  containerName: string,
  engine: string,
): Promise<ContainerCredentialGuess | undefined> {
  if (cm.getStatus(serverId) !== 'connected') return undefined;
  // Docker container names are always [a-zA-Z0-9_.-]; reject anything else
  // rather than let unexpected input anywhere near a shell command.
  if (!/^[a-zA-Z0-9_.-]+$/.test(containerName)) return undefined;
  try {
    const res = await cm.exec(
      serverId,
      `docker inspect --format '{{json .Config.Env}}::{{json .Config.Cmd}}' ${containerName} 2>/dev/null`,
      { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 },
    );
    if (res.exitCode !== 0) return undefined;
    const [envRaw, cmdRaw] = res.stdout.trim().split('::');
    const env: string[] = JSON.parse(envRaw || '[]');
    const cmd: string[] = JSON.parse(cmdRaw || '[]') ?? [];
    return parseContainerCredentialGuess(engine, env, cmd);
  } catch {
    return undefined;
  }
}
