import { describe, expect, it } from 'vitest';
import {
  freshRuleState,
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
  const base: AlertEvent = {
    serverId: 's1',
    serverName: 'web-01',
    metric: 'disk',
    state: 'firing',
    message: 'Disk /var at 95% (threshold 90%)',
    ts: 0,
  };

  it('formats a firing alert', () => {
    const html = renderAlertHtml(base);
    expect(html).toContain('🔴');
    expect(html).toContain('<b>web-01</b>');
    expect(html).toContain('Disk');
  });

  it('formats a resolved alert', () => {
    const html = renderAlertHtml({ ...base, state: 'resolved', message: 'Host is reachable', metric: 'reachability' });
    expect(html).toContain('✅');
    expect(html).toContain('Resolved');
  });

  it('escapes HTML-special characters in the server name', () => {
    const html = renderAlertHtml({ ...base, serverName: 'a<b>&c' });
    expect(html).toContain('a&lt;b&gt;&amp;c');
    expect(html).not.toContain('<b>a<');
  });
});
