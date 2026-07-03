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
import { useServers } from '@/hooks/useServers';

type Cached = {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  sessionId: string | null;
  disposers: (() => void)[];
};

const cache = new Map<string, Cached>();

const THEME = {
  background: '#0a0a0a',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
};

function getOrCreate(serverId: string): Cached {
  const existing = cache.get(serverId);
  if (existing) return existing;

  const el = document.createElement('div');
  el.style.height = '100%';
  el.style.width = '100%';

  const term = new Terminal({
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: THEME,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  // GPU-accelerated rendering — the single biggest responsiveness win. Falls
  // back to the default renderer automatically if the WebGL context is lost.
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    /* WebGL unavailable — the default renderer still works. */
  }

  const entry: Cached = { term, fit, el, sessionId: null, disposers: [] };
  cache.set(serverId, entry);
  return entry;
}

async function ensureSession(serverId: string, entry: Cached) {
  if (entry.sessionId) return;
  entry.fit.fit();
  const { cols, rows } = entry.term;
  const { sessionId } = await window.easyhost.term.open(serverId, cols, rows);
  entry.sessionId = sessionId;

  const onData = entry.term.onData((data) => {
    if (entry.sessionId)
      window.easyhost.term.input(serverId, entry.sessionId, data);
  });
  const unsubData = window.easyhost.term.onData(({ sessionId: sid, data }) => {
    if (sid === entry.sessionId) entry.term.write(data);
  });
  const unsubExit = window.easyhost.term.onExit(({ sessionId: sid }) => {
    if (sid === entry.sessionId) {
      entry.term.writeln('\r\n\x1b[31m[session closed]\x1b[0m');
      entry.sessionId = null;
    }
  });
  entry.disposers.push(
    () => onData.dispose(),
    unsubData,
    unsubExit,
  );
}

export function TerminalView({ serverId }: { serverId: string }) {
  const { statusOf } = useServers();
  const status = statusOf(serverId);
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (status !== 'connected') return;
    const host = hostRef.current;
    if (!host) return;

    const entry = getOrCreate(serverId);
    host.appendChild(entry.el);

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
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {status === 'connecting'
          ? 'Connecting…'
          : 'Not connected. Connect this server to open a terminal.'}
      </div>
    );
  }

  return <div ref={hostRef} className="h-full w-full bg-[#0a0a0a] p-2" />;
}

/** Called when a server is removed/disconnected to free its cached terminal. */
export function disposeTerminal(serverId: string) {
  const entry = cache.get(serverId);
  if (entry) {
    entry.disposers.forEach((d) => d());
    entry.term.dispose();
    cache.delete(serverId);
  }
}
