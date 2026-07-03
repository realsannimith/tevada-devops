/**
 * Subscribes to monitor:stats for one server, keeping a rolling history for
 * charts. Starts polling on mount, stops on unmount, and pauses when the tab is
 * hidden (visibilitychange) to avoid needless SSH round-trips.
 */
import { useEffect, useRef, useState } from 'react';
import type { ServerStats } from '@/shared/ipc-types';

const HISTORY = 60;

export function useMonitorStats(serverId: string | null, active: boolean) {
  const [latest, setLatest] = useState<ServerStats | null>(null);
  const [history, setHistory] = useState<ServerStats[]>([]);
  const startedRef = useRef(false);

  useEffect(() => {
    if (!serverId || !active) return;

    const startPolling = () => {
      if (startedRef.current) return;
      startedRef.current = true;
      void window.easyhost.monitor.start(serverId);
    };
    const stopPolling = () => {
      if (!startedRef.current) return;
      startedRef.current = false;
      void window.easyhost.monitor.stop(serverId);
    };

    const unsub = window.easyhost.monitor.onStats(({ serverId: sid, stats }) => {
      if (sid !== serverId) return;
      setLatest(stats);
      setHistory((h) => [...h, stats].slice(-HISTORY));
    });

    const onVisibility = () => {
      if (document.hidden) stopPolling();
      else startPolling();
    };
    document.addEventListener('visibilitychange', onVisibility);

    if (!document.hidden) startPolling();

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      unsub();
      stopPolling();
    };
  }, [serverId, active]);

  // Reset history when switching servers.
  useEffect(() => {
    setHistory([]);
    setLatest(null);
  }, [serverId]);

  return { latest, history };
}
