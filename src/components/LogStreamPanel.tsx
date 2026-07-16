/**
 * Live log panel — the realtime viewer shared by the Deploys tab (build logs)
 * and the Artifacts tab (container / systemd logs).
 *
 * Follows a remote log over a dedicated SSH channel and renders each line as it
 * arrives, with ANSI colour, a heuristic level badge, search, level filtering,
 * pause, and download. Replaces the old panels, which re-read the whole file
 * every 4 seconds and showed it as uncoloured, unsearchable <pre> text.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogStreamSource } from '../shared/ipc-types';
import { LogLevel, LogLine, ansiToHtml, logLinesToText } from '../lib/logs';
import { useLogStream } from '../hooks/useLogStream';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  CloudDownloadIcon,
  ClockIcon,
  Loader2Icon,
  PlayIcon,
  StopFilledIcon,
  TrashIcon,
} from '../lib/icons';
import { cn } from '../lib/utils';

/** Row tint + badge colour per level. Scoped status colour, per the design
 *  system — never a full-strength background. */
const LEVEL_STYLES: Record<LogLevel, { row: string; dot: string; label: string }> = {
  error: {
    row: 'bg-destructive/8 hover:bg-destructive/12',
    dot: 'bg-destructive',
    label: 'text-destructive',
  },
  warning: {
    row: 'bg-warning/8 hover:bg-warning/12',
    dot: 'bg-warning',
    label: 'text-warning',
  },
  success: {
    row: 'hover:bg-secondary/60',
    dot: 'bg-success',
    label: 'text-success',
  },
  debug: {
    row: 'hover:bg-secondary/60',
    dot: 'bg-muted-foreground/50',
    label: 'text-muted-foreground',
  },
  info: {
    row: 'hover:bg-secondary/60',
    dot: 'bg-muted-foreground/30',
    label: 'text-muted-foreground',
  },
};

const LEVEL_ORDER: LogLevel[] = ['error', 'warning', 'success', 'debug', 'info'];

function LogRow({
  line,
  showTimestamp,
  query,
}: {
  line: LogLine;
  showTimestamp: boolean;
  query: string;
}) {
  const style = LEVEL_STYLES[line.level];

  // ANSI -> HTML first (which escapes the payload), then wrap search hits.
  // Both steps produce markup, so the highlight must not run over raw log text.
  const html = useMemo(() => {
    const base = ansiToHtml(line.message);
    if (!query.trim()) return base;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Only match outside tags, so a query like "span" can't corrupt the markup
    // fancy-ansi just produced.
    return base.replace(
      new RegExp(`(?![^<]*>)(${escaped})`, 'gi'),
      '<mark class="bg-primary/25 text-foreground rounded-[2px]">$1</mark>',
    );
  }, [line.message, query]);

  return (
    <div
      className={cn(
        'group flex items-start gap-2 rounded-[3px] px-1.5 py-[1px] transition-colors',
        style.row,
      )}
    >
      <span
        className={cn('mt-[5px] size-1.5 shrink-0 rounded-full', style.dot)}
        title={line.level}
      />
      {showTimestamp && (
        <span className="mt-[1px] shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/50">
          {line.timestamp
            ? line.timestamp.toLocaleTimeString([], { hour12: false })
            : '--:--:--'}
        </span>
      )}
      <span
        className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/90"
        // Safe: fancy-ansi HTML-escapes the log text; the only markup here is
        // its own colour spans plus our <mark> wrapper.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

export function LogStreamPanel({
  serverId,
  source,
  title,
  subtitle,
  heightClass = 'h-72',
}: {
  serverId: string;
  source: LogStreamSource;
  title: string;
  /** What we're running, e.g. the log path or `docker logs web`. */
  subtitle: string;
  heightClass?: string;
}) {
  const { lines, status, error, paused, bufferedCount, pause, resume, clear } =
    useLogStream(serverId, source);

  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set());
  const [showTimestamp, setShowTimestamp] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q && levels.size === 0) return lines;
    return lines.filter((l) => {
      if (levels.size > 0 && !levels.has(l.level)) return false;
      if (q && !l.message.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [lines, query, levels]);

  // Stick to the bottom while the user is at the bottom; the moment they scroll
  // up to read something, stop yanking them back down.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom =
      Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 12;
    setAutoScroll(atBottom);
  }, []);

  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, autoScroll]);

  const download = useCallback(() => {
    const blob = new Blob([logLinesToText(visible)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `${title.toLowerCase().replace(/\s+/g, '-')}-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [visible, title]);

  const toggleLevel = useCallback((level: LogLevel) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }, []);

  const counts = useMemo(() => {
    const c: Partial<Record<LogLevel, number>> = {};
    for (const l of lines) c[l.level] = (c[l.level] ?? 0) + 1;
    return c;
  }, [lines]);

  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="flex shrink-0 items-center gap-2 text-[11px] font-medium text-muted-foreground">
          {title}
          <span className="font-mono text-[10px] font-normal text-muted-foreground/60">
            {subtitle}
          </span>
          {status === 'connecting' && (
            <span className="flex items-center gap-1 text-[10px] font-normal text-muted-foreground/60">
              <Loader2Icon className="size-3 animate-spin" />
              connecting…
            </span>
          )}
          {status === 'live' && !paused && (
            <span className="flex items-center gap-1 text-[10px] font-normal text-success">
              <span className="size-1.5 animate-pulse rounded-full bg-success" />
              live
            </span>
          )}
          {status === 'live' && paused && (
            <span className="text-[10px] font-normal text-warning">
              paused{bufferedCount > 0 ? ` · ${bufferedCount} buffered` : ''}
            </span>
          )}
          {status === 'ended' && (
            <span className="text-[10px] font-normal text-muted-foreground/60">
              stream ended
            </span>
          )}
        </p>

        <div className="flex items-center gap-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search logs…"
            spellCheck={false}
            className="h-6 w-40 text-[11px]"
          />
          <Button
            variant="ghost"
            size="sm"
            title={showTimestamp ? 'Hide timestamps' : 'Show timestamps'}
            className={cn(
              'h-6 px-1.5 text-muted-foreground',
              showTimestamp && 'text-foreground',
            )}
            onClick={() => setShowTimestamp((v) => !v)}
          >
            <ClockIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title={paused ? 'Resume' : 'Pause'}
            className="h-6 px-1.5 text-muted-foreground"
            onClick={() => (paused ? resume() : pause())}
          >
            {paused ? (
              <PlayIcon className="size-3.5" />
            ) : (
              <StopFilledIcon className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Download these lines"
            className="h-6 px-1.5 text-muted-foreground"
            onClick={download}
            disabled={visible.length === 0}
          >
            <CloudDownloadIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            title="Clear (the log on the server is untouched)"
            className="h-6 px-1.5 text-muted-foreground"
            onClick={clear}
            disabled={lines.length === 0}
          >
            <TrashIcon className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Level filter — only offer levels this log actually contains. */}
      <div className="mb-1.5 flex flex-wrap items-center gap-1">
        {LEVEL_ORDER.filter((l) => counts[l]).map((level) => {
          const on = levels.has(level);
          return (
            <button
              key={level}
              type="button"
              onClick={() => toggleLevel(level)}
              className={cn(
                'flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] transition-colors',
                on
                  ? 'border-border bg-secondary text-foreground'
                  : 'border-transparent text-muted-foreground/70 hover:text-foreground',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  LEVEL_STYLES[level].dot,
                )}
              />
              {level}
              <span className="tabular-nums text-muted-foreground/50">
                {counts[level]}
              </span>
            </button>
          );
        })}
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/50">
          {visible.length === lines.length
            ? `${lines.length} lines`
            : `${visible.length} / ${lines.length} lines`}
        </span>
      </div>

      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn(
            'overflow-auto rounded-lg border border-border bg-background p-2',
            heightClass,
          )}
        >
          {visible.length === 0 ? (
            <p className="p-1 font-mono text-[11px] text-muted-foreground">
              {status === 'connecting'
                ? 'Connecting…'
                : lines.length > 0
                  ? 'No lines match the current filter.'
                  : 'Waiting for output…'}
            </p>
          ) : (
            visible.map((line) => (
              <LogRow
                key={line.id}
                line={line}
                showTimestamp={showTimestamp}
                query={query}
              />
            ))
          )}
        </div>
      )}

      {!autoScroll && visible.length > 0 && (
        <button
          type="button"
          className="mt-1 text-[10px] text-primary hover:underline"
          onClick={() => {
            setAutoScroll(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          Jump to latest
        </button>
      )}
    </div>
  );
}
