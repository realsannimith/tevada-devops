/**
 * Database Editor — a lightweight in-app database IDE, in the spirit of
 * Outerbase Studio / TablePlus but pared down to what Tevada users need: open a
 * hosted database, browse its tables, read rows, and run ad-hoc SQL. It renders
 * as a full-screen overlay launched from a database row in the Artifacts tab.
 *
 * There is no native driver anywhere in the app — every query is answered by
 * the main process running the database's own CLI (psql/mysql) over the managed
 * SSH connection (see main/db-query.ts). This view only ever deals in the
 * normalized {columns, rows} shapes that come back.
 *
 * Supported engines: PostgreSQL, MySQL, MariaDB. All renderer UI follows the
 * FCode / Codex design system (see src/index.css + AGENTS.md).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SqlCodeEditor } from '@/components/SqlCodeEditor';
import { DatabaseErdView } from '@/components/DatabaseErdView';
import {
  MariadbIcon,
  MysqlIcon,
  PostgresqlIcon,
} from '@/lib/brand-icons';
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DatabaseIcon,
  Loader2Icon,
  PlayIcon,
  RefreshIcon,
  SearchIcon,
  TableIcon,
  XIcon,
  type AppIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type {
  DbEditorTarget,
  DbColumn,
  DbQueryResult,
  DbTable,
} from '@/shared/ipc-types';

const ENGINE_GLYPH: Record<string, { icon: AppIcon; color: string }> = {
  postgresql: { icon: PostgresqlIcon, color: '#4169E1' },
  mysql: { icon: MysqlIcon, color: '#F29111' },
  mariadb: { icon: MariadbIcon, color: '#003545' },
};

const PAGE_SIZE = 100;

type OrderBy = { column: string; dir: 'asc' | 'desc' } | null;

type Props = {
  target: DbEditorTarget;
  onClose: () => void;
};

export function DatabaseEditorView({ target, onClose }: Props) {
  const glyph = ENGINE_GLYPH[target.engine] ?? { icon: DatabaseIcon, color: '#6b7280' };
  const GlyphIcon = glyph.icon;

  // Table list ---------------------------------------------------------------
  const [tables, setTables] = useState<DbTable[]>([]);
  const [tablesError, setTablesError] = useState<string | null>(null);
  const [tablesLoading, setTablesLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Selection ----------------------------------------------------------------
  const [active, setActive] = useState<DbTable | null>(null);
  const [mode, setMode] = useState<'data' | 'structure' | 'diagram'>('data');

  const loadTables = useCallback(() => {
    setTablesLoading(true);
    setTablesError(null);
    window.easyhost.db
      .tables(target)
      .then((res) => {
        if (res.ok === false) {
          setTablesError(res.error);
          setTables([]);
          return;
        }
        setTables(res.tables);
        setActive((cur) => cur ?? res.tables[0] ?? null);
      })
      .catch((e) => setTablesError(String(e?.message ?? e)))
      .finally(() => setTablesLoading(false));
  }, [target]);

  useEffect(loadTables, [loadTables]);

  // Esc closes the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const bySchema = new Map<string, DbTable[]>();
    for (const t of tables) {
      if (q && !t.name.toLowerCase().includes(q)) continue;
      const list = bySchema.get(t.schema) ?? [];
      list.push(t);
      bySchema.set(t.schema, list);
    }
    return [...bySchema.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tables, filter]);

  const [queryOpen, setQueryOpen] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* Header ------------------------------------------------------------ */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-secondary"
          style={{ color: glyph.color }}
        >
          <GlyphIcon aria-hidden className="size-[15px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium tracking-[-0.015em] text-ink">
              {target.database || target.engine}
            </span>
            <span className="hidden shrink-0 rounded bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground sm:inline">
              {target.host}:{target.port}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant={queryOpen ? 'outline' : 'ghost'}
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[11px]"
            onClick={() => setQueryOpen((v) => !v)}
          >
            <PlayIcon className="size-3.5" />
            SQL query
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-[11px] text-muted-foreground"
            onClick={loadTables}
          >
            <RefreshIcon className="size-3.5" />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={onClose}
            aria-label="Close database editor"
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Sidebar: schemas + tables -------------------------------------- */}
        <aside className="flex w-44 shrink-0 flex-col border-r border-border sm:w-52 lg:w-60">
          <div className="p-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search tables"
                className="h-8 pl-7 text-[12px]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            {tablesLoading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-[12px] text-muted-foreground">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading tables…
              </div>
            ) : tablesError ? (
              <div className="mx-1 mt-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-[11px] text-destructive">
                <div className="mb-1 flex items-center gap-1.5 font-medium">
                  <AlertTriangleIcon className="size-3.5" />
                  Couldn't list tables
                </div>
                <p className="whitespace-pre-wrap break-words font-mono opacity-90">
                  {tablesError}
                </p>
              </div>
            ) : grouped.length === 0 ? (
              <div className="px-2 py-3 text-[12px] text-muted-foreground">
                {filter ? 'No tables match.' : 'No tables found.'}
              </div>
            ) : (
              grouped.map(([schema, list]) => {
                const isCollapsed = collapsed.has(schema);
                return (
                  <div key={schema} className="mb-0.5">
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(schema)) next.delete(schema);
                          else next.add(schema);
                          return next;
                        })
                      }
                      className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/60"
                    >
                      {isCollapsed ? (
                        <ChevronRightIcon className="size-3" />
                      ) : (
                        <ChevronDownIcon className="size-3" />
                      )}
                      {schema}
                      <span className="ml-auto font-mono text-[10px] normal-case opacity-70">
                        {list.length}
                      </span>
                    </button>
                    {!isCollapsed &&
                      list.map((t) => {
                        const selected =
                          active?.schema === t.schema && active?.name === t.name;
                        return (
                          <button
                            key={`${t.schema}.${t.name}`}
                            type="button"
                            onClick={() => {
                              setActive(t);
                              setMode('data');
                              setQueryOpen(false);
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors',
                              selected
                                ? 'bg-secondary font-medium text-ink'
                                : 'text-muted-foreground hover:bg-accent/60 hover:text-ink',
                            )}
                          >
                            <TableIcon
                              className={cn(
                                'size-3.5 shrink-0',
                                t.type === 'view' && 'opacity-60',
                              )}
                            />
                            <span className="truncate">{t.name}</span>
                            {t.type === 'view' && (
                              <span className="ml-auto shrink-0 text-[9px] uppercase opacity-60">
                                view
                              </span>
                            )}
                          </button>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* Main panel ------------------------------------------------------ */}
        <main className="flex min-w-0 flex-1 flex-col">
          {queryOpen ? (
            <QueryPanel target={target} tableNames={tables.map((tb) => tb.name)} />
          ) : active ? (
            <TablePanel
              key={`${active.schema}.${active.name}`}
              target={target}
              table={active}
              mode={mode}
              onModeChange={setMode}
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
              Select a table to browse its rows.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table panel — data grid (paginated) + structure view
// ---------------------------------------------------------------------------

function TablePanel({
  target,
  table,
  mode,
  onModeChange,
}: {
  target: DbEditorTarget;
  table: DbTable;
  mode: 'data' | 'structure' | 'diagram';
  onModeChange: (m: 'data' | 'structure' | 'diagram') => void;
}) {
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [orderBy, setOrderBy] = useState<OrderBy>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [columns, setColumns] = useState<DbColumn[] | null>(null);
  const [structError, setStructError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    setLoading(true);
    setError(null);
    window.easyhost.db
      .select(target, table.schema, table.name, {
        limit: PAGE_SIZE,
        offset,
        orderBy: orderBy ?? undefined,
      })
      .then((res) => {
        if (res.ok === false) {
          setError(res.error);
          setResult(null);
          return;
        }
        if (res.result.error) {
          setError(res.result.error);
          setResult(null);
          return;
        }
        setResult(res.result);
        setTotal(res.totalRows);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [target, table.schema, table.name, offset, orderBy]);

  useEffect(loadData, [loadData]);

  const loadStructure = useCallback(() => {
    setStructError(null);
    window.easyhost.db
      .columns(target, table.schema, table.name)
      .then((res) => {
        if (res.ok === false) {
          setStructError(res.error);
          setColumns(null);
          return;
        }
        setColumns(res.columns);
      })
      .catch((e) => setStructError(String(e?.message ?? e)));
  }, [target, table.schema, table.name]);

  // Load columns for every table (not just the Structure tab) — the Data tab
  // needs the primary key to know how to save inline edits.
  useEffect(() => {
    loadStructure();
  }, [loadStructure]);

  const primaryKeys = useMemo(
    () => (columns ?? []).filter((c) => c.pk).map((c) => c.name),
    [columns],
  );

  /** Persist an inline edit, keyed on the row's primary key, then reflect it. */
  const editCell = useCallback(
    async (rowIndex: number, columnName: string, value: string | null): Promise<boolean> => {
      if (!result) return false;
      if (primaryKeys.length === 0) {
        toast.error('This table has no primary key — cells are read-only.');
        return false;
      }
      const pk = primaryKeys.map((name) => {
        const idx = result.columns.indexOf(name);
        return { column: name, value: idx >= 0 ? result.rows[rowIndex][idx] : null };
      });
      const res = await window.easyhost.db.updateCell(
        target,
        table.schema,
        table.name,
        pk,
        columnName,
        value,
      );
      if (res.ok === false) {
        toast.error(res.error);
        return false;
      }
      setResult((prev) => {
        if (!prev) return prev;
        const cIdx = prev.columns.indexOf(columnName);
        if (cIdx < 0) return prev;
        const rows = prev.rows.map((r, i) => (i === rowIndex ? r.slice() : r));
        rows[rowIndex][cIdx] = value;
        return { ...prev, rows };
      });
      return true;
    },
    [result, primaryKeys, target, table.schema, table.name],
  );

  const toggleSort = useCallback((column: string) => {
    setOffset(0);
    setOrderBy((cur) => {
      if (!cur || cur.column !== column) return { column, dir: 'asc' };
      if (cur.dir === 'asc') return { column, dir: 'desc' };
      return null;
    });
  }, []);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = total != null ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Sub-toolbar: table name, tabs, pagination */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="hidden min-w-0 shrink truncate font-mono text-[12px] text-ink sm:inline">
          {table.schema}.{table.name}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-secondary/60 p-0.5">
          {(['data', 'structure', 'diagram'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => onModeChange(m)}
              className={cn(
                'h-6 rounded-md px-2.5 text-[11px] capitalize transition-colors',
                mode === m
                  ? 'bg-background font-medium text-ink shadow-sm'
                  : 'text-muted-foreground hover:text-ink',
              )}
            >
              {m}
            </button>
          ))}
        </div>

        {mode === 'data' && (
          <div className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
            <span className="whitespace-nowrap font-mono">
              {total != null
                ? `${total.toLocaleString()} rows`
                : result
                  ? `${result.rowCount} rows`
                  : ''}
            </span>
            {result && result.rowCount > 0 && (
              <span className="hidden text-[10px] text-muted-foreground/70 md:inline">
                {primaryKeys.length === 0
                  ? 'read-only · no primary key'
                  : 'double-click a cell to edit'}
              </span>
            )}
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={offset === 0 || loading}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Prev
              </Button>
              <span className="whitespace-nowrap font-mono tabular-nums">
                {page}
                {pageCount != null ? ` / ${pageCount}` : ''}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-[11px]"
                disabled={
                  loading ||
                  (result != null && result.rowCount < PAGE_SIZE) ||
                  (pageCount != null && page >= pageCount)
                }
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-muted-foreground"
              onClick={loadData}
              aria-label="Reload rows"
            >
              <RefreshIcon className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
        )}
      </div>

      {mode === 'diagram' ? (
        <DatabaseErdView target={target} />
      ) : mode === 'data' ? (
        error ? (
          <ErrorBlock message={error} />
        ) : loading && !result ? (
          <Centered>
            <Loader2Icon className="size-4 animate-spin" /> Loading rows…
          </Centered>
        ) : result ? (
          <DataGrid
            result={result}
            orderBy={orderBy}
            onSort={toggleSort}
            editable={primaryKeys.length > 0}
            onEdit={editCell}
          />
        ) : null
      ) : structError ? (
        <ErrorBlock message={structError} />
      ) : columns ? (
        <StructureGrid columns={columns} />
      ) : (
        <Centered>
          <Loader2Icon className="size-4 animate-spin" /> Loading structure…
        </Centered>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SQL query panel
// ---------------------------------------------------------------------------

function QueryPanel({
  target,
  tableNames,
}: {
  target: DbEditorTarget;
  tableNames: string[];
}) {
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  // Keep the latest sql/running in a ref so the editor's Mod-Enter binding
  // always runs the current text without re-creating the editor extensions.
  const stateRef = useRef({ sql, running });
  stateRef.current = { sql, running };

  const run = useCallback(() => {
    const trimmed = stateRef.current.sql.trim();
    if (!trimmed || stateRef.current.running) return;
    setRunning(true);
    window.easyhost.db
      .query(target, trimmed)
      .then((res) => {
        if (res.ok === false) {
          setResult({ columns: [], rows: [], rowCount: 0, truncated: false, error: res.error });
          setElapsed(null);
          return;
        }
        setResult(res.result);
        setElapsed(res.elapsedMs);
        if (!res.result.error && res.result.columns.length === 0) {
          toast.success('Statement executed.');
        }
      })
      .catch((e) =>
        setResult({
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          error: String(e?.message ?? e),
        }),
      )
      .finally(() => setRunning(false));
  }, [target]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Editor toolbar */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <Button
          size="sm"
          className="h-7 gap-1.5 px-3 text-[11px]"
          onClick={run}
          disabled={running || !sql.trim()}
        >
          {running ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <PlayIcon className="size-3.5" />
          )}
          Run
          <kbd className="ml-0.5 rounded bg-primary-foreground/20 px-1 font-mono text-[9px]">
            ⌘↵
          </kbd>
        </Button>
        {elapsed != null && !result?.error && (
          <span className="font-mono text-[11px] text-muted-foreground">
            {result?.columns.length ? `${result.rowCount} rows` : 'ok'} · {elapsed} ms
          </span>
        )}
        <span className="ml-auto hidden min-w-0 truncate font-mono text-[10px] text-muted-foreground sm:inline">
          {target.database || target.engine} · {target.host}:{target.port}
        </span>
      </div>

      {/* CodeMirror SQL editor — syntax-highlighted, line numbers, autocomplete */}
      <div className="max-h-[45%] min-h-[9rem] shrink-0 overflow-auto border-b border-border">
        <SqlCodeEditor
          value={sql}
          onChange={setSql}
          engine={target.engine}
          tables={tableNames}
          onRun={run}
          placeholder="SELECT * FROM …    —    ⌘↵ / Ctrl↵ to run"
        />
      </div>

      {/* Results */}
      <div className="flex min-h-0 flex-1 flex-col">
        {result ? (
          result.error ? (
            <ErrorBlock message={result.error} />
          ) : result.columns.length > 0 ? (
            <DataGrid result={result} />
          ) : (
            <Centered>Statement executed — no rows returned.</Centered>
          )
        ) : (
          <Centered>Write a query and press Run.</Centered>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared render helpers
// ---------------------------------------------------------------------------

/** Virtualization-free data grid — good for the ≤1000-row pages we fetch. Rows
 *  come back as strings already; NULL cells are true `null`. When `editable`,
 *  double-clicking a cell opens an inline editor that saves via `onEdit`. */
function DataGrid({
  result,
  orderBy,
  onSort,
  editable = false,
  onEdit,
}: {
  result: DbQueryResult;
  orderBy?: OrderBy;
  onSort?: (column: string) => void;
  editable?: boolean;
  onEdit?: (rowIndex: number, column: string, value: string | null) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const startEdit = (row: number, col: number, cell: string | null) => {
    if (!editable || saving) return;
    setEditing({ row, col });
    setDraft(cell ?? '');
  };

  const commit = async () => {
    if (!editing || !onEdit) {
      setEditing(null);
      return;
    }
    const { row, col } = editing;
    const original = result.rows[row][col];
    // No-op edits (incl. leaving a NULL cell untouched) just close the editor.
    if (draft === (original ?? '') && !(original === null && draft !== '')) {
      setEditing(null);
      return;
    }
    setSaving(true);
    await onEdit(row, result.columns[col], draft);
    setSaving(false);
    setEditing(null);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-max min-w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10">
          <tr className="bg-secondary">
            <th className="sticky left-0 z-20 w-10 border-b border-r border-border bg-secondary px-2 py-1.5 text-right font-mono text-[10px] text-muted-foreground">
              #
            </th>
            {result.columns.map((col) => {
              const sorted = orderBy?.column === col ? orderBy.dir : null;
              return (
                <th
                  key={col}
                  onClick={onSort ? () => onSort(col) : undefined}
                  className={cn(
                    'border-b border-r border-border px-2.5 py-1.5 text-left font-medium text-ink',
                    onSort && 'cursor-pointer select-none hover:bg-accent/60',
                  )}
                >
                  <span className="flex items-center gap-1 whitespace-nowrap">
                    {col}
                    {sorted === 'asc' && <ArrowUpIcon className="size-3 text-primary" />}
                    {sorted === 'desc' && <ArrowDownIcon className="size-3 text-primary" />}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className="hover:bg-accent/40">
              <td className="sticky left-0 z-10 border-b border-r border-border bg-background px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">
                {i + 1}
              </td>
              {row.map((cell, j) => {
                const isEditing = editing?.row === i && editing?.col === j;
                return (
                  <td
                    key={j}
                    onDoubleClick={() => startEdit(i, j, cell)}
                    className={cn(
                      'max-w-[24rem] border-b border-r border-border px-2.5 py-1 font-mono text-[11.5px] text-ink',
                      isEditing ? 'p-0' : 'truncate',
                      editable && !isEditing && 'cursor-text',
                    )}
                    title={isEditing ? undefined : cell ?? undefined}
                  >
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draft}
                        disabled={saving}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={commit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void commit();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                        className="w-full min-w-[6rem] bg-primary/5 px-2.5 py-1 font-mono text-[11.5px] text-ink outline-none ring-2 ring-inset ring-primary/50"
                      />
                    ) : cell === null ? (
                      <span className="italic text-muted-foreground/60">NULL</span>
                    ) : cell === '' ? (
                      <span className="text-muted-foreground/40">·</span>
                    ) : (
                      cell
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {result.rows.length === 0 && (
            <tr>
              <td
                colSpan={result.columns.length + 1}
                className="px-3 py-6 text-center text-[12px] text-muted-foreground"
              >
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StructureGrid({ columns }: { columns: DbColumn[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-border text-left text-muted-foreground">
            <th className="px-3 py-2 font-medium">Column</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="px-3 py-2 font-medium">Nullable</th>
            <th className="px-3 py-2 font-medium">Default</th>
            <th className="px-3 py-2 font-medium">Key</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="border-b border-border/60">
              <td className="px-3 py-1.5 font-mono text-ink">{c.name}</td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground">{c.type}</td>
              <td className="px-3 py-1.5 text-muted-foreground">
                {c.nullable ? 'YES' : 'NO'}
              </td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground">
                {c.default ?? <span className="opacity-40">—</span>}
              </td>
              <td className="px-3 py-1.5">
                {c.pk && (
                  <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                    PK
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="p-4">
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">
        <div className="mb-1.5 flex items-center gap-1.5 font-medium">
          <AlertTriangleIcon className="size-4" />
          Query error
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
          {message}
        </pre>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}
