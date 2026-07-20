/**
 * Database ERD (entity-relationship diagram) — the Diagram tab of the Database
 * Editor. Renders every table as a draggable card (columns with PK/FK badges)
 * and draws foreign-key relationships as edges labelled with their cardinality
 * (1:1 vs 1:N). Pan by dragging the canvas, zoom with the controls.
 *
 * No graph library: a small layered auto-layout places the tables, edges are
 * plain SVG béziers, and everything is styled with the FCode design tokens.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangleIcon,
  KeyIcon,
  Loader2Icon,
  PlusIcon,
  RefreshIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import type { DbEditorTarget, DbErdRelation, DbErdTable } from '@/shared/ipc-types';

const CARD_W = 232;
const HEADER_H = 34;
const ROW_H = 24;
const H_GAP = 96;
const V_GAP = 36;

type Pos = { x: number; y: number };

function cardHeight(table: DbErdTable): number {
  return HEADER_H + Math.max(table.columns.length, 1) * ROW_H + 2;
}

/** Layered left→right layout: a table sits one column to the right of the
 *  tables it references, so parents land left of their children. */
function autoLayout(tables: DbErdTable[], relations: DbErdRelation[]): Record<string, Pos> {
  const refs = new Map<string, Set<string>>(); // table -> tables it points to
  for (const t of tables) refs.set(t.name, new Set());
  for (const r of relations) {
    if (r.fromTable !== r.toTable) refs.get(r.fromTable)?.add(r.toTable);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const compute = (name: string): number => {
    if (depth.has(name)) return depth.get(name)!;
    if (visiting.has(name)) return 0; // break cycles
    visiting.add(name);
    let d = 0;
    for (const target of refs.get(name) ?? []) d = Math.max(d, compute(target) + 1);
    visiting.delete(name);
    depth.set(name, d);
    return d;
  };
  for (const t of tables) compute(t.name);

  const byDepth = new Map<number, DbErdTable[]>();
  for (const t of tables) {
    const d = depth.get(t.name) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(t);
  }
  const pos: Record<string, Pos> = {};
  for (const [d, group] of byDepth) {
    let y = 0;
    for (const t of group) {
      pos[t.name] = { x: d * (CARD_W + H_GAP) + 24, y: y + 24 };
      y += cardHeight(t) + V_GAP;
    }
  }
  return pos;
}

export function DatabaseErdView({ target }: { target: DbEditorTarget }) {
  const [tables, setTables] = useState<DbErdTable[]>([]);
  const [relations, setRelations] = useState<DbErdRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pos, setPos] = useState<Record<string, Pos>>({});
  const [zoom, setZoom] = useState(0.9);
  const [pan, setPan] = useState<Pos>({ x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null); // hovered table name

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    window.easyhost.db
      .graph(target)
      .then((res) => {
        if (res.ok === false) {
          setError(res.error);
          return;
        }
        setTables(res.tables);
        setRelations(res.relations);
        setPos(autoLayout(res.tables, res.relations));
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  }, [target]);

  useEffect(load, [load]);

  const colIndex = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tables) t.columns.forEach((c, i) => m.set(`${t.name}.${c.name}`, i));
    return m;
  }, [tables]);

  // --- dragging (nodes + canvas pan) ---------------------------------------
  const drag = useRef<
    | { kind: 'node'; name: string; startX: number; startY: number; origin: Pos }
    | { kind: 'pan'; startX: number; startY: number; origin: Pos }
    | null
  >(null);

  const onNodePointerDown = (e: React.PointerEvent, name: string) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'node', name, startX: e.clientX, startY: e.clientY, origin: pos[name] };
  };
  const onCanvasPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, origin: pan };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / zoom;
    const dy = (e.clientY - d.startY) / zoom;
    if (d.kind === 'node') {
      setPos((prev) => ({ ...prev, [d.name]: { x: d.origin.x + dx, y: d.origin.y + dy } }));
    } else {
      setPan({ x: d.origin.x + (e.clientX - d.startX), y: d.origin.y + (e.clientY - d.startY) });
    }
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const edges = useMemo(() => {
    return relations
      .map((r, i) => {
        const from = pos[r.fromTable];
        const to = pos[r.toTable];
        if (!from || !to) return null;
        const fromCol = colIndex.get(`${r.fromTable}.${r.fromColumn}`) ?? 0;
        const toCol = colIndex.get(`${r.toTable}.${r.toColumn}`) ?? 0;
        const y1 = from.y + HEADER_H + fromCol * ROW_H + ROW_H / 2;
        const y2 = to.y + HEADER_H + toCol * ROW_H + ROW_H / 2;
        const fromRight = from.x + CARD_W / 2 <= to.x + CARD_W / 2;
        const x1 = fromRight ? from.x + CARD_W : from.x;
        const x2 = fromRight ? to.x : to.x + CARD_W;
        const k = 46;
        const cx1 = fromRight ? x1 + k : x1 - k;
        const cx2 = fromRight ? x2 - k : x2 + k;
        const active = hover === r.fromTable || hover === r.toTable;
        return { r, i, x1, y1, x2, y2, cx1, cx2, active, fromRight };
      })
      .filter(Boolean) as Array<{
      r: DbErdRelation;
      i: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      cx1: number;
      cx2: number;
      active: boolean;
      fromRight: boolean;
    }>;
  }, [relations, pos, colIndex, hover]);

  // Canvas extent for the SVG.
  const extent = useMemo(() => {
    let w = 800;
    let h = 600;
    for (const t of tables) {
      const p = pos[t.name];
      if (!p) continue;
      w = Math.max(w, p.x + CARD_W + 80);
      h = Math.max(h, p.y + cardHeight(t) + 80);
    }
    return { w, h };
  }, [tables, pos]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Building diagram…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-4">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-[12px] text-destructive">
          <div className="mb-1.5 flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-4" /> Couldn't build the diagram
          </div>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] opacity-90">
            {error}
          </pre>
        </div>
      </div>
    );
  }
  if (tables.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
        No tables to diagram yet.
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] [background-size:20px_20px]">
      {/* Controls */}
      <div className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-background/90 p-1 shadow-sm backdrop-blur">
        <button
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-ink"
          onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="w-10 text-center font-mono text-[10px] tabular-nums text-muted-foreground">
          {Math.round(zoom * 100)}%
        </span>
        <button
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-ink"
          onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}
          aria-label="Zoom in"
        >
          <PlusIcon className="size-3.5" />
        </button>
        <span className="mx-0.5 h-4 w-px bg-border" />
        <button
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-ink"
          onClick={() => {
            setPos(autoLayout(tables, relations));
            setPan({ x: 0, y: 0 });
            setZoom(0.9);
          }}
          aria-label="Reset layout"
          title="Reset layout"
        >
          <RefreshIcon className="size-3.5" />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-20 flex items-center gap-3 rounded-lg border border-border bg-background/90 px-2.5 py-1.5 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
        <span className="flex items-center gap-1">
          <KeyIcon className="size-3 text-primary" /> primary key
        </span>
        <span className="flex items-center gap-1">
          <span className="rounded bg-chart-2/15 px-1 font-mono text-chart-2">FK</span> foreign key
        </span>
        <span className="flex items-center gap-1">
          <span className="font-mono">1:N</span> one-to-many
        </span>
      </div>

      {/* Canvas */}
      <div
        className="absolute inset-0 cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="absolute left-0 top-0 origin-top-left"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          {/* Edges */}
          <svg
            width={extent.w}
            height={extent.h}
            className="pointer-events-none absolute left-0 top-0 overflow-visible"
          >
            {edges.map((e) => {
              const many = e.r.kind === 'one-to-many';
              const stroke = e.active ? 'var(--color-primary)' : 'var(--color-border)';
              const mx = (e.x1 + e.cx1 + e.x2 + e.cx2) / 4;
              const my = (e.y1 + e.y2) / 2;
              return (
                <g key={e.i} style={{ opacity: hover && !e.active ? 0.25 : 1 }}>
                  <path
                    d={`M ${e.x1} ${e.y1} C ${e.cx1} ${e.y1}, ${e.cx2} ${e.y2}, ${e.x2} ${e.y2}`}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={e.active ? 2 : 1.5}
                  />
                  {/* "one" end marker (dot) at the referenced table */}
                  <circle cx={e.x2} cy={e.y2} r={3} fill={stroke} />
                  {/* cardinality chip at the child (FK) end */}
                  <g transform={`translate(${e.x1 + (e.fromRight ? 8 : -22)} ${e.y1 - 8})`}>
                    <rect
                      width={14}
                      height={16}
                      rx={4}
                      fill="var(--color-background)"
                      stroke={stroke}
                    />
                    <text
                      x={7}
                      y={11}
                      textAnchor="middle"
                      fontSize={9}
                      fontFamily="monospace"
                      fill={e.active ? 'var(--color-primary)' : 'var(--color-muted-foreground)'}
                    >
                      {many ? 'N' : '1'}
                    </text>
                  </g>
                  {/* relationship kind label at midpoint */}
                  <text
                    x={mx}
                    y={my - 6}
                    textAnchor="middle"
                    fontSize={9}
                    fontFamily="monospace"
                    fill="var(--color-muted-foreground)"
                    style={{ opacity: e.active ? 1 : 0 }}
                  >
                    {many ? '1 : N' : '1 : 1'}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Table cards */}
          {tables.map((t) => {
            const p = pos[t.name];
            if (!p) return null;
            const active = hover === t.name;
            return (
              <div
                key={t.name}
                className={cn(
                  'absolute select-none rounded-xl border bg-background shadow-sm transition-shadow',
                  active ? 'border-primary/60 shadow-md' : 'border-border',
                )}
                style={{ left: p.x, top: p.y, width: CARD_W }}
                onPointerDown={(e) => onNodePointerDown(e, t.name)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onMouseEnter={() => setHover(t.name)}
                onMouseLeave={() => setHover((h) => (h === t.name ? null : h))}
              >
                <div
                  className="flex h-[34px] cursor-grab items-center gap-1.5 rounded-t-xl border-b border-border bg-secondary px-3 active:cursor-grabbing"
                  style={{ height: HEADER_H }}
                >
                  <span className="truncate font-mono text-[12px] font-semibold text-ink">
                    {t.name}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {t.columns.length}
                  </span>
                </div>
                <div>
                  {t.columns.map((c) => (
                    <div
                      key={c.name}
                      className="flex items-center gap-1.5 border-b border-border/40 px-3 last:border-b-0"
                      style={{ height: ROW_H }}
                    >
                      {c.pk ? (
                        <KeyIcon className="size-3 shrink-0 text-primary" />
                      ) : (
                        <span className="size-3 shrink-0" />
                      )}
                      <span
                        className={cn(
                          'truncate font-mono text-[11px]',
                          c.pk ? 'font-medium text-ink' : 'text-ink/90',
                        )}
                      >
                        {c.name}
                      </span>
                      {c.fk && (
                        <span className="shrink-0 rounded bg-chart-2/15 px-1 font-mono text-[9px] text-chart-2">
                          FK
                        </span>
                      )}
                      <span className="ml-auto truncate font-mono text-[9.5px] lowercase text-muted-foreground">
                        {c.type}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
