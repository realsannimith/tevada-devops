/**
 * Lightweight database IDE backend — the engine behind the "Database Editor"
 * screen (see components/DatabaseEditorView.tsx).
 *
 * Tevada never bundles a native DB driver: every database it manages lives on
 * the user's own SSH server (usually as a Docker container the "Set up a
 * database" wizard created). So instead of speaking the wire protocol, we do
 * what the rest of the app does — run a command over the managed SSH
 * connection (ConnectionManager.exec) and parse its stdout. The command is the
 * database's own CLI (`psql` / `mysql`).
 *
 * Because the app is ALREADY authenticated onto the server, the editor never
 * has to ask the user for the database password. It connects the way a DBA on
 * the box would:
 *   - Docker database → `docker exec` into the container and connect over the
 *     container's local socket. Postgres trusts local-socket connections, so no
 *     password is needed; for MySQL/MariaDB we read the root password straight
 *     off the container's own config (docker inspect).
 *   - Native database → connect over the host's local socket (Postgres `peer` /
 *     MySQL `auth_socket`), escalating with `sudo -n` where that's how local
 *     admin access works.
 * A saved credential (from the "Set up a database" wizard) is used when present
 * — e.g. for a remote/native database that needs TCP + password — but it is
 * never required to open the editor.
 *
 * The SQL and any password are base64-encoded before they touch the remote
 * shell and decoded on the far side, so nothing the user (or a column name) can
 * type ever needs shell-quoting — it sidesteps injection entirely.
 *
 * Only the tabular SQL engines are supported (postgresql / mysql / mariadb).
 */
import { ConnectionManager } from './connection-manager';
import { listDatabaseCredentials, recoverContainerCredential, revealDatabaseCredential } from './credentials';
import {
  DbColumnsResult,
  DbEditorTarget,
  DbErdColumn,
  DbErdRelation,
  DbErdTable,
  DbGraphResult,
  DbQueryResult,
  DbRunResult,
  DbSelectResult,
  DbTable,
  DbTablesResult,
  DbUpdateResult,
} from '../shared/ipc-types';

// Field / record separators: ASCII unit- and record-separator control bytes.
// They never appear in normal text, so splitting on them is unambiguous, and
// psql accepts them as its unaligned field/record separators verbatim.
const FS = '\x1f';
const RS = '\x1e';
// psql prints NULL indistinguishably from an empty string unless told
// otherwise; this sentinel makes the difference recoverable.
const NULL_SENTINEL = '\x00NULL\x00';

const DEFAULT_LIMIT = 100;

export function isSqlEngine(engine: string): boolean {
  return engine === 'postgresql' || engine === 'mysql' || engine === 'mariadb';
}

// --- identifier / literal escaping (pure) ----------------------------------

/** Postgres double-quoted identifier. */
function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
/** MySQL/MariaDB backtick identifier. */
function myIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}
/** SQL single-quoted string literal (both dialects). */
function sqlStr(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// Runner resolution — where does the CLI actually run?
// ---------------------------------------------------------------------------

type Runner = { prefix: string; container?: string }; // '' prefix = run on the host

/** Find the Docker container publishing `port` so we can `docker exec` into it
 *  (guaranteeing the matching client binary + local-socket auth). Falls back to
 *  running on the host directly when Docker isn't present or nothing matches. */
async function resolveRunner(
  cm: ConnectionManager,
  serverId: string,
  port: number,
  knownContainer?: string,
): Promise<Runner> {
  if (knownContainer && /^[a-zA-Z0-9_.-]+$/.test(knownContainer)) {
    return { prefix: `docker exec -i ${knownContainer} `, container: knownContainer };
  }
  try {
    const res = await cm.exec(
      serverId,
      `docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null`,
      { timeoutMs: 10_000, maxOutputBytes: 128 * 1024 },
    );
    if (res.exitCode === 0) {
      for (const line of res.stdout.split('\n')) {
        const [name, ports] = line.split('\t');
        if (!name || !ports) continue;
        // Ports column looks like "127.0.0.1:5432->5432/tcp, :::5432->…".
        // Match the *host* published port (left of the arrow).
        if (new RegExp(`(^|[\\s,]|:)${port}->`).test(ports)) {
          if (/^[a-zA-Z0-9_.-]+$/.test(name)) {
            return { prefix: `docker exec -i ${name} `, container: name };
          }
        }
      }
    }
  } catch {
    /* docker missing / not connected — fall through to host */
  }
  return { prefix: '' };
}

// ---------------------------------------------------------------------------
// Command builders — a remote shell script per dialect. The whole script is
// base64'd and piped into `[docker exec -i <c>] sh`, so no interpolated value
// ever reaches the outer shell unescaped.
// ---------------------------------------------------------------------------

type ConnInfo = {
  user: string;
  database: string;
  /** Present only when we authenticate with a password (TCP). Omitted → the
   *  connection relies on local-socket trust / peer / auth_socket. */
  password?: string;
  /** Set only for a TCP connection (native DB + saved credential). Omitted →
   *  connect over the local unix socket. */
  host?: string;
  port?: number;
  /** e.g. "sudo -n -u postgres " — prepended for native local-socket auth. */
  sudo?: string;
};

function pgScript(conn: ConnInfo, sql: string): string {
  const lines: string[] = [];
  if (conn.password != null) {
    lines.push(`PGPASSWORD="$(printf %s '${b64(conn.password)}' | base64 -d)"`);
    lines.push(`export PGPASSWORD`);
  }
  const tcp = conn.host ? ` -h ${sqlStr(conn.host)} -p ${conn.port}` : '';
  lines.push(
    `printf %s '${b64(sql)}' | base64 -d | ${conn.sudo ?? ''}psql${tcp}` +
      ` -U ${sqlStr(conn.user)} -d ${sqlStr(conn.database)}` +
      ` -X -q -A -F '${FS}' -R '${RS}'` +
      ` -P footer=off -P 'null=${NULL_SENTINEL}'` +
      ` -v ON_ERROR_STOP=1`,
  );
  return lines.join('\n');
}

function myScript(conn: ConnInfo, sql: string): string {
  const lines: string[] = [];
  if (conn.password != null) {
    lines.push(`MYSQL_PWD="$(printf %s '${b64(conn.password)}' | base64 -d)"`);
    lines.push(`export MYSQL_PWD`);
  }
  // mariadb images may ship the client as `mariadb` rather than `mysql`.
  lines.push(`if command -v mysql >/dev/null 2>&1; then CLIENT=mysql; else CLIENT=mariadb; fi`);
  const tcp = conn.host ? ` -h ${sqlStr(conn.host)} -P ${conn.port}` : '';
  lines.push(
    `printf %s '${b64(sql)}' | base64 -d | ${conn.sudo ?? ''}"$CLIENT"${tcp}` +
      ` -u ${sqlStr(conn.user)}` +
      (conn.database ? ` ${sqlStr(conn.database)}` : '') +
      ` --batch --default-character-set=utf8mb4`,
  );
  return lines.join('\n');
}

/** Wrap a dialect script into the final remote command. `cd /tmp` first so a
 *  `sudo -u postgres` step doesn't warn about an inaccessible CWD (the SSH
 *  user's home) — that warning would otherwise pollute stderr. stdout carries
 *  only the query result; errors/warnings stay on stderr. */
function remoteCommand(runner: Runner, script: string): string {
  const full = `cd /tmp 2>/dev/null || cd / 2>/dev/null\n${script}`;
  return `printf %s '${b64(full)}' | base64 -d | ${runner.prefix}sh`;
}

// ---------------------------------------------------------------------------
// Output parsers (pure)
// ---------------------------------------------------------------------------

/** psql `-A -F FS -R RS` output → columns + rows. First record is the header.
 *  Exported for testing. */
export function parsePg(out: string): { columns: string[]; rows: (string | null)[][] } {
  const records = out.split(RS).filter((r) => r.length > 0);
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = records[0].split(FS);
  const rows = records.slice(1).map((rec) =>
    rec.split(FS).map((v) => (v === NULL_SENTINEL ? null : v)),
  );
  return { columns, rows };
}

/** Undo mysql --batch's C-style escaping of a single field. */
function unescapeMy(field: string): string {
  return field.replace(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case '\\':
        return '\\';
      default:
        return c;
    }
  });
}

/** mysql `--batch` output (tab-separated, header first, `NULL` for null).
 *  Exported for testing. */
export function parseMy(out: string): { columns: string[]; rows: (string | null)[][] } {
  const lines = out.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
  if (lines.length === 0) return { columns: [], rows: [] };
  const columns = lines[0].split('\t').map(unescapeMy);
  const rows = lines.slice(1).map((line) =>
    line.split('\t').map((f) => (f === 'NULL' ? null : unescapeMy(f))),
  );
  return { columns, rows };
}

function parseOutput(
  engine: string,
  out: string,
): { columns: string[]; rows: (string | null)[][] } {
  return engine === 'postgresql' ? parsePg(out) : parseMy(out);
}

// The CLI signals failure with a non-zero exit; the message is on stderr (data
// stays clean on stdout). Both psql (ON_ERROR_STOP=1) and mysql (--batch) obey
// this. Fall back to stdout only if stderr happens to be empty. Strip the
// benign `sudo` chdir warning so it never shows as the error.
function detectError(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): string | undefined {
  if (exitCode === 0) return undefined;
  // Drop informational noise: the benign `sudo` chdir warning and Postgres
  // NOTICE lines (e.g. from DROP ... IF EXISTS) — keep only the real error.
  const cleaned = stderr
    .split('\n')
    .filter((l) => !/could not change directory to/.test(l) && !/^NOTICE:/.test(l))
    .join('\n')
    .trim();
  return cleaned || stdout.trim() || `Database command exited with code ${exitCode}`;
}

// ---------------------------------------------------------------------------
// Core executor
// ---------------------------------------------------------------------------

type Prepared = { engine: string; conn: ConnInfo; serverId: string; runner: Runner };

/** Run one SQL statement (or batch) against an explicit connection. */
async function execWith(
  cm: ConnectionManager,
  serverId: string,
  runner: Runner,
  engine: string,
  conn: ConnInfo,
  sql: string,
): Promise<DbQueryResult> {
  const script = engine === 'postgresql' ? pgScript(conn, sql) : myScript(conn, sql);
  const res = await cm.exec(serverId, remoteCommand(runner, script), {
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  const error = detectError(res.exitCode, res.stdout, res.stderr);
  if (error) return { columns: [], rows: [], rowCount: 0, error, truncated: res.truncated };
  const { columns, rows } = parseOutput(engine, res.stdout);
  return { columns, rows, rowCount: rows.length, truncated: res.truncated };
}

/** Run one SQL statement (or batch) against the already-chosen connection. */
async function execSql(cm: ConnectionManager, p: Prepared, sql: string): Promise<DbQueryResult> {
  return execWith(cm, p.serverId, p.runner, p.engine, p.conn, sql);
}

/** Build the ordered list of ways to authenticate, best (no-password,
 *  server-side) first. The app is already on the box, so we lead with the
 *  methods a local DBA would use and only fall back to a saved password. */
function buildCandidates(
  engine: string,
  inContainer: boolean,
  target: DbEditorTarget,
  saved: { username?: string; password?: string; database?: string } | undefined,
  mysqlContainerPassword: string | undefined,
): ConnInfo[] {
  const isPg = engine === 'postgresql';
  const database = saved?.database || target.database || (isPg ? 'postgres' : '');
  const savedUser = saved?.username;
  const host = target.host || '127.0.0.1';
  const port = target.port;
  const list: ConnInfo[] = [];

  if (isPg) {
    if (inContainer) {
      // Inside its own container Postgres trusts the local socket — no password.
      list.push({ user: savedUser || 'postgres', database });
    } else {
      // 1) Become the postgres OS user and use peer auth over the socket — the
      //    standard password-less admin path. `sudo -n` fails fast, never prompts.
      list.push({ user: 'postgres', database, sudo: 'sudo -n -u postgres ' });
      // 2) A saved password over TCP.
      if (saved?.password) {
        list.push({ user: savedUser || 'postgres', database, password: saved.password, host, port });
      }
      // 3) Plain local socket as the current SSH user (works if pg_hba trusts it).
      list.push({ user: savedUser || 'postgres', database });
    }
  } else {
    const user = savedUser || 'root';
    if (inContainer) {
      // The socket still authenticates root — use the saved password or the one
      // read straight off the container's config; else try auth_socket (no pw).
      const pw = saved?.password ?? mysqlContainerPassword;
      list.push({ user, database, password: pw });
      if (pw) list.push({ user, database });
    } else {
      // 1) sudo → root auth_socket (no password). 2) saved password over TCP.
      list.push({ user: 'root', database, sudo: 'sudo -n ' });
      if (saved?.password) list.push({ user, database, password: saved.password, host, port });
      list.push({ user, database });
    }
  }
  return list;
}

/** Resolve how to reach the database — runner, credentials, auth mode — once
 *  per request, by probing each candidate connection with `SELECT 1` and
 *  keeping the first that works. Never asks the user for anything. */
async function prepare(
  cm: ConnectionManager,
  target: DbEditorTarget,
): Promise<{ ok: true; prepared: Prepared } | { ok: false; error: string }> {
  const { engine, serverId } = target;
  if (!isSqlEngine(engine)) {
    return {
      ok: false,
      error: `The database editor supports PostgreSQL and MySQL/MariaDB. "${engine}" isn't supported yet.`,
    };
  }
  if (cm.getStatus(serverId) !== 'connected') {
    return { ok: false, error: 'Not connected to the server. Connect first, then reopen the editor.' };
  }

  const runner = await resolveRunner(cm, serverId, target.port, target.containerName);
  const inContainer = !!runner.container;

  // A credential the wizard (or the user) saved earlier, matched by engine +
  // port. Optional — only used when local-socket auth won't do.
  const savedMeta = listDatabaseCredentials(serverId).find(
    (c) => c.engine === engine && c.port === target.port,
  );
  const saved = savedMeta ? revealDatabaseCredential(savedMeta.id) : undefined;

  // For a MySQL container without a saved password, read it off the container.
  const mysqlContainerPassword =
    engine !== 'postgresql' && inContainer && !saved?.password
      ? (await recoverContainerCredential(cm, serverId, runner.container!, engine))?.password
      : undefined;

  const candidates = buildCandidates(engine, inContainer, target, saved, mysqlContainerPassword);

  // Probe each candidate with a trivial query; keep the first that connects.
  let lastError: string | undefined;
  for (const conn of candidates) {
    const probe = await execWith(cm, serverId, runner, engine, conn, 'SELECT 1');
    if (!probe.error) return { ok: true, prepared: { engine, conn, serverId, runner } };
    lastError = probe.error;
  }
  return {
    ok: false,
    error:
      lastError ??
      'Could not connect to the database with any available method. Try saving credentials for it.',
  };
}

// ---------------------------------------------------------------------------
// Introspection SQL (per dialect)
// ---------------------------------------------------------------------------

function tablesSql(engine: string, database: string): string {
  if (engine === 'postgresql') {
    return `SELECT table_schema, table_name, table_type FROM information_schema.tables
      WHERE table_schema NOT IN ('information_schema','pg_catalog','pg_toast')
      ORDER BY table_schema, table_name`;
  }
  // mysql / mariadb — restrict to the connected database when we have one.
  const where = database
    ? `table_schema = ${sqlStr(database)}`
    : `table_schema NOT IN ('mysql','information_schema','performance_schema','sys')`;
  return `SELECT table_schema, table_name, table_type FROM information_schema.tables
    WHERE ${where} ORDER BY table_schema, table_name`;
}

function columnsSql(engine: string, schema: string, table: string): string {
  if (engine === 'postgresql') {
    return `SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = ${sqlStr(schema)} AND table_name = ${sqlStr(table)}
      ORDER BY ordinal_position`;
  }
  return `SELECT column_name, column_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = ${sqlStr(schema)} AND table_name = ${sqlStr(table)}
    ORDER BY ordinal_position`;
}

function primaryKeysSql(engine: string, schema: string, table: string): string {
  if (engine === 'postgresql') {
    // Read from pg_catalog, not information_schema: the latter hides constraints
    // from a read-only role (SELECT-only), so the PK would look absent.
    return `SELECT a.attname
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indisprimary
        AND i.indrelid = (quote_ident(${sqlStr(schema)}) || '.' || quote_ident(${sqlStr(table)}))::regclass`;
  }
  return `SELECT column_name FROM information_schema.key_column_usage
    WHERE constraint_name = 'PRIMARY'
      AND table_schema = ${sqlStr(schema)} AND table_name = ${sqlStr(table)}`;
}

function qualify(engine: string, schema: string, table: string): string {
  return engine === 'postgresql'
    ? `${pgIdent(schema)}.${pgIdent(table)}`
    : `${myIdent(schema)}.${myIdent(table)}`;
}

// ---------------------------------------------------------------------------
// Public operations (called by the IPC handlers)
// ---------------------------------------------------------------------------

export async function listTables(
  cm: ConnectionManager,
  target: DbEditorTarget,
): Promise<DbTablesResult> {
  const p = await prepare(cm, target);
  if (p.ok === false) return p;
  const r = await execSql(cm, p.prepared, tablesSql(p.prepared.engine, p.prepared.conn.database));
  if (r.error) return { ok: false, error: r.error };
  const tables: DbTable[] = r.rows.map((row) => ({
    schema: row[0] ?? '',
    name: row[1] ?? '',
    type: (row[2] ?? '').toUpperCase().includes('VIEW') ? 'view' : 'table',
  }));
  const defaultSchema =
    p.prepared.engine === 'postgresql' ? 'public' : p.prepared.conn.database;
  return { ok: true, engine: p.prepared.engine, defaultSchema, tables };
}

export async function tableColumns(
  cm: ConnectionManager,
  target: DbEditorTarget,
  schema: string,
  table: string,
): Promise<DbColumnsResult> {
  const p = await prepare(cm, target);
  if (p.ok === false) return p;
  const [cols, pks] = await Promise.all([
    execSql(cm, p.prepared, columnsSql(p.prepared.engine, schema, table)),
    execSql(cm, p.prepared, primaryKeysSql(p.prepared.engine, schema, table)),
  ]);
  if (cols.error) return { ok: false, error: cols.error };
  const pkSet = new Set((pks.error ? [] : pks.rows).map((r) => r[0]));
  return {
    ok: true,
    columns: cols.rows.map((row) => ({
      name: row[0] ?? '',
      type: row[1] ?? '',
      nullable: (row[2] ?? '').toUpperCase() === 'YES',
      default: row[3],
      pk: pkSet.has(row[0]),
    })),
  };
}

export async function selectRows(
  cm: ConnectionManager,
  target: DbEditorTarget,
  schema: string,
  table: string,
  opts: { limit?: number; offset?: number; orderBy?: { column: string; dir: 'asc' | 'desc' } },
): Promise<DbSelectResult> {
  const p = await prepare(cm, target);
  if (p.ok === false) return p;
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const engine = p.prepared.engine;
  const tableRef = qualify(engine, schema, table);
  const ident = engine === 'postgresql' ? pgIdent : myIdent;
  const orderBy = opts.orderBy
    ? ` ORDER BY ${ident(opts.orderBy.column)} ${opts.orderBy.dir === 'desc' ? 'DESC' : 'ASC'}`
    : '';
  const [data, count] = await Promise.all([
    execSql(cm, p.prepared, `SELECT * FROM ${tableRef}${orderBy} LIMIT ${limit} OFFSET ${offset}`),
    execSql(cm, p.prepared, `SELECT count(*) FROM ${tableRef}`),
  ]);
  if (data.error) return { ok: false, error: data.error };
  const totalRows = count.error ? null : Number(count.rows[0]?.[0] ?? '') || 0;
  return { ok: true, result: data, totalRows, limit, offset };
}

export async function runQuery(
  cm: ConnectionManager,
  target: DbEditorTarget,
  sql: string,
): Promise<DbRunResult> {
  const p = await prepare(cm, target);
  if (p.ok === false) return p;
  const started = Date.now();
  const result = await execSql(cm, p.prepared, sql);
  return { ok: true, result, elapsedMs: Date.now() - started };
}

/** Update a single cell, identifying the row by its primary-key value(s).
 *  Editing is refused when the table has no primary key (no safe WHERE). */
export async function updateCell(
  cm: ConnectionManager,
  target: DbEditorTarget,
  schema: string,
  table: string,
  pk: { column: string; value: string | null }[],
  column: string,
  value: string | null,
): Promise<DbUpdateResult> {
  const p = await prepare(cm, target);
  if (p.ok === false) return p;
  if (pk.length === 0) {
    return {
      ok: false,
      error: "This table has no primary key, so its rows can't be edited safely.",
    };
  }
  const engine = p.prepared.engine;
  const ident = engine === 'postgresql' ? pgIdent : myIdent;
  const lit = (v: string | null) => (v === null ? 'NULL' : sqlStr(v));
  const where = pk
    .map((k) =>
      k.value === null ? `${ident(k.column)} IS NULL` : `${ident(k.column)} = ${lit(k.value)}`,
    )
    .join(' AND ');
  const sql = `UPDATE ${qualify(engine, schema, table)} SET ${ident(column)} = ${lit(value)} WHERE ${where}`;
  const r = await execSql(cm, p.prepared, sql);
  if (r.error) return { ok: false, error: r.error };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Schema graph (ERD) — tables, their columns, and foreign-key relationships
// with cardinality (a FK whose column is itself unique/PK is one-to-one, else
// one-to-many). Powers the Diagram tab.
// ---------------------------------------------------------------------------

/** WHERE clause restricting an information_schema query to user schemas. */
function schemaScope(engine: string, database: string, alias: string): string {
  const col = `${alias}.table_schema`;
  if (engine === 'postgresql') {
    return `${col} NOT IN ('pg_catalog','information_schema','pg_toast')`;
  }
  return database
    ? `${col} = ${sqlStr(database)}`
    : `${col} NOT IN ('mysql','information_schema','performance_schema','sys')`;
}

export async function schemaGraph(
  cm: ConnectionManager,
  target: DbEditorTarget,
): Promise<DbGraphResult> {
  const p = await prepare(cm, target);
  if (p.ok === false) return p;
  const engine = p.prepared.engine;
  const db = p.prepared.conn.database;
  const isPg = engine === 'postgresql';

  const colsSql = `SELECT table_name, column_name, ${isPg ? 'data_type' : 'column_type'}
    FROM information_schema.columns c
    WHERE ${schemaScope(engine, db, 'c')}
    ORDER BY table_name, ordinal_position`;

  // Postgres constraint views hide rows from read-only roles, so read PK/UNIQUE
  // and foreign keys from pg_catalog (always visible). MySQL's information_schema
  // is visible for the user's own database, so keep it there.
  const keysSql = isPg
    ? `SELECT cl.relname, a.attname,
              CASE WHEN i.indisprimary THEN 'PRIMARY KEY' ELSE 'UNIQUE' END
       FROM pg_index i
       JOIN pg_class cl ON cl.oid = i.indrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE (i.indisprimary OR i.indisunique)
         AND ns.nspname NOT IN ('pg_catalog','information_schema')`
    : `SELECT tc.table_name, kcu.column_name, tc.constraint_type
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type IN ('PRIMARY KEY','UNIQUE') AND ${schemaScope(engine, db, 'tc')}`;

  const fkSql = isPg
    ? `SELECT cl.relname, att.attname, clf.relname, attf.attname
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = cl.relnamespace
       JOIN pg_class clf ON clf.oid = con.confrelid
       JOIN unnest(con.conkey) WITH ORDINALITY AS ck(attnum, ord) ON true
       JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ck.attnum
       JOIN unnest(con.confkey) WITH ORDINALITY AS cf(attnum, ord) ON cf.ord = ck.ord
       JOIN pg_attribute attf ON attf.attrelid = con.confrelid AND attf.attnum = cf.attnum
       WHERE con.contype = 'f' AND ns.nspname NOT IN ('pg_catalog','information_schema')`
    : `SELECT k.table_name, k.column_name, k.referenced_table_name, k.referenced_column_name
       FROM information_schema.key_column_usage k
       WHERE k.referenced_table_name IS NOT NULL AND ${schemaScope(engine, db, 'k')}`;

  const [cols, keys, fks] = await Promise.all([
    execSql(cm, p.prepared, colsSql),
    execSql(cm, p.prepared, keysSql),
    execSql(cm, p.prepared, fkSql),
  ]);
  if (cols.error) return { ok: false, error: cols.error };

  const key = (t: string | null, c: string | null) => `${t} ${c}`;
  const pkSet = new Set<string>();
  const uniqueSet = new Set<string>(); // PK columns count as unique too
  for (const row of keys.error ? [] : keys.rows) {
    const [t, c, kind] = row;
    uniqueSet.add(key(t, c));
    if ((kind ?? '').toUpperCase() === 'PRIMARY KEY') pkSet.add(key(t, c));
  }

  const relations: DbErdRelation[] = (fks.error ? [] : fks.rows)
    .filter((row) => row[0] && row[2])
    .map((row) => ({
      fromTable: row[0] ?? '',
      fromColumn: row[1] ?? '',
      toTable: row[2] ?? '',
      toColumn: row[3] ?? '',
      kind: uniqueSet.has(key(row[0], row[1])) ? 'one-to-one' : 'one-to-many',
    }));
  const fkColumns = new Set(relations.map((r) => key(r.fromTable, r.fromColumn)));

  const byTable = new Map<string, DbErdColumn[]>();
  for (const row of cols.rows) {
    const table = row[0] ?? '';
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push({
      name: row[1] ?? '',
      type: row[2] ?? '',
      pk: pkSet.has(key(table, row[1])),
      fk: fkColumns.has(key(table, row[1])),
    });
  }
  const tables: DbErdTable[] = [...byTable.entries()].map(([name, columns]) => ({
    name,
    columns,
  }));

  return { ok: true, tables, relations };
}
