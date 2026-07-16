/**
 * Follow a remote log in realtime.
 *
 * Opens a stream in main (`tail -f` / `docker logs -f` / `journalctl -f`),
 * consumes the `logs:data` chunks it pushes back, and hands the caller parsed
 * lines. Replaces the 4-second `cat`-the-whole-file polling the Deploys and
 * Artifacts tabs used to do: output now appears as the builder prints it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LogStreamSource } from '../shared/ipc-types';
import { LogLine, createLineAssembler } from '../lib/logs';

/** Ring-buffer cap. A chatty container can emit unbounded output, and every
 *  line is a DOM node — past this we drop the oldest, like a terminal's
 *  scrollback. Well above a typical build; low enough to stay smooth. */
export const MAX_LINES = 5_000;

export type LogStreamStatus = 'connecting' | 'live' | 'ended' | 'error';

export function useLogStream(
  serverId: string,
  source: LogStreamSource,
  opts: { enabled?: boolean; tail?: number } = {},
) {
  const { enabled = true, tail } = opts;

  const [lines, setLines] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<LogStreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [bufferedCount, setBufferedCount] = useState(0);

  const streamIdRef = useRef<string | null>(null);
  /** Reassembles whole lines from chunks that can split anywhere. */
  const assemblerRef = useRef(createLineAssembler());
  /** While paused we keep receiving (the remote process doesn't stop) and hold
   *  the lines here, so resuming shows the gap instead of a hole. */
  const pausedRef = useRef(false);
  const bufferRef = useRef<LogLine[]>([]);

  // The caller builds `source` inline, so it's a fresh object every render.
  // Key the effect on its content, not its identity, or we'd tear down and
  // reopen the SSH channel on every parent re-render.
  const sourceKey = JSON.stringify(source);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const append = useCallback((incoming: LogLine[]) => {
    if (incoming.length === 0) return;
    if (pausedRef.current) {
      bufferRef.current = bufferRef.current.concat(incoming).slice(-MAX_LINES);
      setBufferedCount(bufferRef.current.length);
      return;
    }
    setLines((prev) => {
      const next = prev.concat(incoming);
      return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let openedStreamId: string | null = null;

    setLines([]);
    setError(null);
    setStatus('connecting');
    assemblerRef.current = createLineAssembler();
    bufferRef.current = [];
    setBufferedCount(0);

    const unsubData = window.easyhost.logs.onData(({ streamId, chunk }) => {
      if (streamId !== streamIdRef.current) return;
      append(assemblerRef.current.push(chunk));
    });

    const unsubExit = window.easyhost.logs.onExit(({ streamId, error: err }) => {
      if (streamId !== streamIdRef.current) return;
      // The last line of a log often has no trailing newline — don't lose it.
      append(assemblerRef.current.flush());
      streamIdRef.current = null;
      if (err) {
        setError(err);
        setStatus('error');
      } else {
        setStatus('ended');
      }
    });

    void (async () => {
      try {
        const res = await window.easyhost.logs.open({
          serverId,
          source: sourceRef.current,
          tail,
        });
        // `=== false`, not `!res.ok`: strictNullChecks is off in this project,
        // so a boolean discriminant only narrows on an explicit comparison.
        if (res.ok === false) {
          if (!cancelled) {
            setError(res.error);
            setStatus('error');
          }
          return;
        }
        // The panel can unmount while the SSH channel is still opening. Close
        // the stream we just asked for, or it follows the log forever.
        if (cancelled) {
          void window.easyhost.logs.close(serverId, res.streamId);
          return;
        }
        openedStreamId = res.streamId;
        streamIdRef.current = res.streamId;
        setStatus('live');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      unsubData();
      unsubExit();
      streamIdRef.current = null;
      if (openedStreamId) {
        void window.easyhost.logs.close(serverId, openedStreamId);
      }
    };
  }, [serverId, sourceKey, tail, enabled, append]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    const buffered = bufferRef.current;
    bufferRef.current = [];
    setBufferedCount(0);
    if (buffered.length > 0) {
      setLines((prev) => {
        const next = prev.concat(buffered);
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }
  }, []);

  const clear = useCallback(() => {
    setLines([]);
    bufferRef.current = [];
    setBufferedCount(0);
  }, []);

  return useMemo(
    () => ({
      lines,
      status,
      error,
      paused,
      bufferedCount,
      pause,
      resume,
      clear,
    }),
    [lines, status, error, paused, bufferedCount, pause, resume, clear],
  );
}
