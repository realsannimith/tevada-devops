/**
 * Interactive terminal backed by a remote PTY (ssh2 shell channel). To preserve
 * scrollback and the live shell when the user switches tabs, each server's xterm
 * instance and its DOM node are cached at module scope and re-parented into the
 * view on mount rather than recreated.
 */
import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { Button } from '@/components/ui/button';
import { useServers } from '@/hooks/useServers';
import {
  AlertTriangleIcon,
  Loader2Icon,
  TerminalIcon,
  WifiIcon,
} from '@/lib/icons';
import { cn } from '@/lib/utils';
import { TypeaheadController } from './typeahead';

type Cached = {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  typeahead: TypeaheadController;
  sessionId: string | null;
  disposers: (() => void)[];
  /** In-flight open, so concurrent callers don't each spawn a session + handlers. */
  opening: Promise<void> | null;
};

const cache = new Map<string, Cached>();

// Neutral canvas-dark terminal surface (design: canvas-under). Magenta maps to
// the agent/skill violet; the accent blue carries the cursor.
const THEME = {
  background: '#0e0e0e',
  foreground: '#e5e5e5',
  cursor: '#339cff',
  cursorAccent: '#0e0e0e',
  selectionBackground: 'rgba(51,156,255,0.25)',
  black: '#0e0e0e',
  brightBlack: '#737373',
  red: '#fa423e',
  brightRed: '#fa423e',
  green: '#40c977',
  brightGreen: '#40c977',
  yellow: '#f59e0b',
  brightYellow: '#f59e0b',
  blue: '#339cff',
  brightBlue: '#339cff',
  magenta: '#ad7bf9',
  brightMagenta: '#ad7bf9',
  cyan: '#40c977',
  white: '#e5e5e5',
  brightWhite: '#f5f5f5',
};

function getOrCreate(serverId: string): Cached {
  const existing = cache.get(serverId);
  if (existing) return existing;

  const el = document.createElement('div');
  el.style.height = '100%';
  el.style.width = '100%';
  el.style.position = 'relative'; // anchor for the typeahead overlay

  const term = new Terminal({
    fontFamily:
      '"JetBrainsMono NFM", "JetBrainsMono NF", "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.4,
    letterSpacing: 0,
    cursorBlink: true,
    theme: THEME,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // GPU-accelerated rendering is the single biggest responsiveness win. Falls
  // back to the default renderer automatically if the WebGL context is lost.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* WebGL unavailable; the default renderer still works. */
  }

  const typeahead = new TypeaheadController(term, el, THEME.background);

  const entry: Cached = {
    term,
    fit,
    el,
    typeahead,
    sessionId: null,
    disposers: [],
    opening: null,
  };
  cache.set(serverId, entry);
  return entry;
}

/** Dispose any input/output handlers left over from a previous session. */
function tearDownSession(entry: Cached) {
  entry.disposers.forEach((d) => d());
  entry.disposers = [];
}

async function ensureSession(serverId: string, entry: Cached) {
  if (entry.sessionId) return;
  // Dedupe concurrent callers: without this, two callers can both pass the
  // sessionId===null guard before either awaits term.open, each opening a PTY
  // and registering its own onData handler → every keystroke sent twice.
  if (entry.opening) return entry.opening;

  entry.opening = (async () => {
    // Drop any handlers left over from a previous (now-closed) session on this
    // cached terminal. onExit nulls sessionId but leaves the old onData handler
    // attached; re-registering here without this stacks a second handler, so a
    // reconnected session echoes each keystroke twice ("c" → "cc" → "ccc"…).
    tearDownSession(entry);

    entry.fit.fit();
    const { cols, rows } = entry.term;
    const { sessionId } = await window.easyhost.term.open(serverId, cols, rows);
    entry.sessionId = sessionId;

    const onData = entry.term.onData((data) => {
      entry.typeahead.handleInput(data, (d) => {
        if (entry.sessionId)
          window.easyhost.term.input(serverId, entry.sessionId, d);
      });
    });
    const unsubData = window.easyhost.term.onData(({ sessionId: sid, data }) => {
      if (sid !== entry.sessionId) return;
      // Write the real echo first, then reconcile predictions against the new
      // cursor position.
      entry.term.write(data, () => entry.typeahead.handleServerData(data));
    });
    const unsubExit = window.easyhost.term.onExit(({ sessionId: sid }) => {
      if (sid === entry.sessionId) {
        entry.typeahead.clear();
        entry.term.writeln('\r\n\x1b[31m[session closed]\x1b[0m');
        entry.sessionId = null;
      }
    });
    entry.disposers.push(() => onData.dispose(), unsubData, unsubExit);
  })();

  try {
    await entry.opening;
  } finally {
    entry.opening = null;
  }
}

export function TerminalView({ serverId }: { serverId: string }) {
  const { statusOf, errorOf, connect } = useServers();
  const status = statusOf(serverId);
  const error = errorOf(serverId);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'connected') return;
    const host = hostRef.current;
    if (!host) return;

    const entry = getOrCreate(serverId);
    host.appendChild(entry.el);

    // Apply the predictive-echo preference (defaults on).
    void window.easyhost.settings
      .get()
      .then((s) => (entry.typeahead.enabled = s.localEcho))
      .catch(() => {});

    let ro: ResizeObserver | null = null;
    const raf = requestAnimationFrame(() => {
      entry.fit.fit();
      void ensureSession(serverId, entry).then(() => {
        if (entry.sessionId) {
          window.easyhost.term.resize(
            serverId,
            entry.sessionId,
            entry.term.cols,
            entry.term.rows,
          );
        }
      });
      entry.term.focus();

      ro = new ResizeObserver(() => {
        try {
          entry.fit.fit();
          if (entry.sessionId) {
            window.easyhost.term.resize(
              serverId,
              entry.sessionId,
              entry.term.cols,
              entry.term.rows,
            );
          }
        } catch {
          /* container not laid out */
        }
      });
      ro.observe(host);
    });

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      // Detach (don't dispose) so the session + scrollback survive tab switches.
      if (entry.el.parentNode === host) host.removeChild(entry.el);
    };
  }, [serverId, status]);

  if (status !== 'connected') {
    const connecting = status === 'connecting';
    const failed = status === 'error';
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div
          role={failed ? 'alert' : connecting ? 'status' : undefined}
          className="flex max-w-sm flex-col items-center text-center"
        >
          <div
            className={cn(
              'mb-3 flex size-10 items-center justify-center rounded-xl bg-secondary',
              failed ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {connecting ? (
              <Loader2Icon aria-hidden className="size-4 animate-spin" />
            ) : failed ? (
              <AlertTriangleIcon aria-hidden className="size-4" />
            ) : (
              <TerminalIcon aria-hidden className="size-4" />
            )}
          </div>
          <h2 className="text-[13px] font-medium text-ink">
            {connecting
              ? 'Opening terminal'
              : failed
                ? 'Connection failed'
                : 'Terminal unavailable'}
          </h2>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            {connecting
              ? 'Establishing a secure SSH session with this server.'
              : failed
                ? error || 'The server could not be reached with the saved credentials.'
                : 'Connect this server to start an interactive SSH session.'}
          </p>
          <Button
            type="button"
            variant="prominent"
            size="sm"
            className="mt-4 rounded-full"
            onClick={() => connect(serverId)}
            disabled={connecting}
          >
            {connecting ? (
              <Loader2Icon aria-hidden className="animate-spin" />
            ) : (
              <WifiIcon aria-hidden />
            )}
            {connecting ? 'Connecting…' : failed ? 'Retry' : 'Connect'}
          </Button>
        </div>
      </div>
    );
  }

  return <div ref={hostRef} className="h-full w-full bg-[#0e0e0e] p-3" />;
}

/** Called when a server is removed/disconnected to free its cached terminal. */
export function disposeTerminal(serverId: string) {
  const entry = cache.get(serverId);
  if (entry) {
    entry.disposers.forEach((d) => d());
    entry.typeahead.dispose();
    entry.term.dispose();
    cache.delete(serverId);
  }
}
