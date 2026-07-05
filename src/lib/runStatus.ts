/**
 * Same-window pub/sub for "is an agent run in flight right now?" — the chat
 * panel and wizards view publish their live state, and the sidebar shows a
 * pulsing dot on the matching nav row so a run stays visible from any screen.
 * (Persisted session status covers history rows and app restarts; this event
 * only exists for the instant, in-app indicator.)
 */
export const RUN_STATUS_EVENT = 'easyhost:run-status';

export type RunSurface = 'chat' | 'wizard';

export type RunStatusDetail = { surface: RunSurface; running: boolean };

export function publishRunStatus(surface: RunSurface, running: boolean): void {
  window.dispatchEvent(
    new CustomEvent<RunStatusDetail>(RUN_STATUS_EVENT, {
      detail: { surface, running },
    }),
  );
}
