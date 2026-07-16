import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  formatDuration,
  freshRuleState,
  httpCheckLabel,
  renderAlertHtml,
  stepRule,
  type RuleTuning,
} from './alerts';
import type { AlertEvent } from '@/shared/ipc-types';

const TUNING: RuleTuning = {
  failureThreshold: 3,
  successThreshold: 2,
  reminderMinutes: 30,
};

/** Drive N identical checks and collect the action from each. */
function drive(
  healthy: boolean,
  times: number,
  state = freshRuleState(),
  tuning = TUNING,
  startNow = 0,
) {
  const actions: string[] = [];
  for (let i = 0; i < times; i++) {
    actions.push(stepRule(state, healthy, tuning, startNow));
  }
  return { actions, state };
}

describe('stepRule — the anti-noise state machine', () => {
  it('does NOT fire on a single (or sub-threshold) failure', () => {
    const { actions } = drive(false, 2); // threshold is 3
    expect(actions).toEqual(['none', 'none']);
  });

  it('fires exactly once when the failure threshold is reached', () => {
    const state = freshRuleState();
    expect(stepRule(state, false, TUNING, 0)).toBe('none'); // 1
    expect(stepRule(state, false, TUNING, 0)).toBe('none'); // 2
    expect(stepRule(state, false, TUNING, 0)).toBe('fire'); // 3 → fire
    expect(state.triggered).toBe(true);
  });

  it('does not re-fire while it stays broken (dedup) when reminders are off', () => {
    const tuning = { ...TUNING, reminderMinutes: 0 };
    const state = freshRuleState();
    drive(false, 3, state, tuning); // reaches fire on the 3rd
    // Many more failing checks — must stay silent.
    const { actions } = drive(false, 10, state, tuning);
    expect(actions.every((a) => a === 'none')).toBe(true);
  });

  it('resets the failure streak when a healthy check interrupts it', () => {
    const state = freshRuleState();
    stepRule(state, false, TUNING, 0);
    stepRule(state, false, TUNING, 0); // 2 failures
    stepRule(state, true, TUNING, 0); // healthy → reset
    expect(state.failures).toBe(0);
    // Now two failures should NOT be enough to fire (needs 3 again).
    expect(stepRule(state, false, TUNING, 0)).toBe('none');
    expect(stepRule(state, false, TUNING, 0)).toBe('none');
    expect(stepRule(state, false, TUNING, 0)).toBe('fire');
  });

  it('resolves only after enough consecutive healthy checks, and only once', () => {
    const state = freshRuleState();
    drive(false, 3, state); // triggered
    expect(stepRule(state, true, TUNING, 0)).toBe('none'); // 1 success (threshold 2)
    expect(stepRule(state, true, TUNING, 0)).toBe('resolve'); // 2 → resolve
    expect(state.triggered).toBe(false);
    // Further healthy checks don't resolve again.
    expect(stepRule(state, true, TUNING, 0)).toBe('none');
  });

  it('never resolves a rule that never fired', () => {
    const { actions } = drive(true, 5);
    expect(actions.every((a) => a === 'none')).toBe(true);
  });

  it('sends a reminder only after the interval has elapsed', () => {
    const state = freshRuleState();
    // Fire at t=0.
    expect(stepRule(state, false, TUNING, 0)).toBe('none');
    expect(stepRule(state, false, TUNING, 0)).toBe('none');
    expect(stepRule(state, false, TUNING, 0)).toBe('fire');
    // Still broken but before the 30-minute reminder window → silent.
    expect(stepRule(state, false, TUNING, 10 * 60_000)).toBe('none');
    // After 30 minutes → one reminder.
    expect(stepRule(state, false, TUNING, 30 * 60_000)).toBe('remind');
    // Immediately after → silent again until the next interval.
    expect(stepRule(state, false, TUNING, 30 * 60_000 + 1000)).toBe('none');
  });

  it('never reminds when reminderMinutes is 0', () => {
    const tuning = { ...TUNING, reminderMinutes: 0 };
    const state = freshRuleState();
    drive(false, 3, state, tuning); // fire
    expect(stepRule(state, false, tuning, 999 * 60_000)).toBe('none');
  });
});

describe('renderAlertHtml', () => {
  const NOON = new Date(2026, 6, 6, 13, 24).getTime(); // Jul 6, 1:24 PM local

  const base: AlertEvent = {
    serverId: 's1',
    serverName: 'web-01',
    metric: 'disk',
    state: 'firing',
    message: 'Disk /var at 95% (threshold 90%)',
    ts: NOON,
  };

  it('formats a firing alert in the standard 3-line shape', () => {
    const html = renderAlertHtml(base);
    const lines = html.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('🔴 <b>Disk almost full</b>');
    expect(lines[1]).toBe('<b>web-01</b> · Disk /var at 95% (threshold 90%)');
    expect(lines[2]).toBe('<i>Jul 6, 1:24 PM</i>');
  });

  it('formats a resolved alert with the incident duration', () => {
    const html = renderAlertHtml(
      {
        ...base,
        state: 'resolved',
        message: 'SSH connection restored',
        metric: 'reachability',
      },
      NOON - 12 * 60_000, // fired 12 minutes earlier
    );
    expect(html).toContain('✅ <b>Server back online</b>');
    expect(html).toContain('<i>recovered after 12m · Jul 6, 1:24 PM</i>');
  });

  it('formats a reminder with the running duration', () => {
    const html = renderAlertHtml(
      { ...base, metric: 'memory', reminder: true },
      NOON - 90 * 60_000,
    );
    expect(html).toContain('🔴 <b>High memory usage</b>');
    expect(html).toContain('<i>still firing · 1h 30m so far · Jul 6, 1:24 PM</i>');
  });

  it('uses a readable 12-hour time, never ISO', () => {
    const html = renderAlertHtml(base);
    expect(html).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('escapes HTML-special characters in the server name', () => {
    const html = renderAlertHtml({ ...base, serverName: 'a<b>&c' });
    expect(html).toContain('a&lt;b&gt;&amp;c');
    expect(html).not.toContain('<b>a<');
  });
});

describe('http uptime helpers', () => {
  it('httpCheckLabel shortens URLs to host (+ non-root path)', () => {
    expect(httpCheckLabel('https://example.com/')).toBe('example.com');
    expect(httpCheckLabel('https://example.com')).toBe('example.com');
    expect(httpCheckLabel('https://api.example.com/health')).toBe(
      'api.example.com/health',
    );
    expect(httpCheckLabel('http://example.com:8080/x')).toBe(
      'example.com:8080/x',
    );
    expect(httpCheckLabel('not a url')).toBe('not a url'); // graceful fallback
  });

  it('daysUntil floors to whole days and rejects garbage', () => {
    const now = Date.UTC(2026, 6, 1);
    expect(daysUntil(new Date(now + 14 * 86_400_000).toUTCString(), now)).toBe(14);
    expect(daysUntil(new Date(now + 86_400_000 / 2).toUTCString(), now)).toBe(0);
    expect(daysUntil(new Date(now - 86_400_000).toUTCString(), now)).toBe(-1);
    expect(daysUntil('never', now)).toBeUndefined();
  });

  it('renderAlertHtml knows the http and tls metrics', () => {
    const base: AlertEvent = {
      serverId: 'hc_1',
      serverName: 'example.com',
      metric: 'http',
      state: 'firing',
      message: 'https://example.com failed: connect ECONNREFUSED',
      ts: Date.UTC(2026, 6, 6, 12, 0),
    };
    expect(renderAlertHtml(base)).toContain('🔴 <b>Website down</b>');
    expect(
      renderAlertHtml({ ...base, metric: 'tls', state: 'resolved' }),
    ).toContain('✅ <b>TLS certificate renewed</b>');
  });
});

describe('formatDuration', () => {
  it('picks the two most significant units', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(65 * 60_000)).toBe('1h 5m');
    expect(formatDuration(2 * 3600_000)).toBe('2h');
    expect(formatDuration(27 * 3600_000)).toBe('1d 3h');
    expect(formatDuration(-5)).toBe('0s'); // clock skew never renders negative
  });
});
