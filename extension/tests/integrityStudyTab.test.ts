import { describe, expect, it } from 'vitest';
import { deriveIntegrity } from '../src/integrity/focusTracker.js';
import type { IntegrityEvent } from '../src/models/types.js';

function ev(attempt_id: string, type: IntegrityEvent['event_type'], ms: number): IntegrityEvent {
  return { event_id: `e-${type}-${ms}`, attempt_id, timestamp: new Date(ms).toISOString(), event_type: type };
}

describe('study-tab integrity', () => {
  it('study tab switch counts as one interruption', () => {
    const base = Date.parse('2026-09-20T12:00:00.000Z');
    const events = [
      ev('a', 'attempt_started', base),
      ev('a', 'study_tab_inactive', base + 60_000),
      ev('a', 'study_tab_active', base + 85_000),
    ];
    const d = deriveIntegrity(events, base + 200_000, true);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBe(25_000);
    expect(d.integrity_flag).toBe(true);
  });

  it('overlapping study-tab + window signals do NOT double-count (spec: 25s, not 45s)', () => {
    // 12:00 start; 12:01 inactive+blur; 12:01:20 focus; 12:01:25 active.
    const base = Date.parse('2026-09-20T12:00:00.000Z');
    const events = [
      ev('a', 'attempt_started', base),
      ev('a', 'study_tab_inactive', base + 60_000),
      ev('a', 'window_blur', base + 60_050),
      ev('a', 'window_focus', base + 80_000),
      ev('a', 'study_tab_active', base + 85_000),
    ];
    const d = deriveIntegrity(events, base + 200_000, true);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBe(25_000);
  });

  it('window-only interruption while study tab stays active still counts once', () => {
    const base = Date.parse('2026-09-20T12:00:00.000Z');
    const events = [ev('a', 'attempt_started', base), ev('a', 'window_blur', base + 10_000), ev('a', 'window_focus', base + 20_000)];
    const d = deriveIntegrity(events, base + 100_000, true);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBe(10_000);
  });

  it('correct restoration after return: later interruptions counted separately', () => {
    const base = Date.parse('2026-09-20T12:00:00.000Z');
    const events = [
      ev('a', 'attempt_started', base),
      ev('a', 'study_tab_inactive', base + 10_000),
      ev('a', 'study_tab_active', base + 20_000),
      ev('a', 'study_tab_inactive', base + 50_000),
      ev('a', 'study_tab_active', base + 55_000),
    ];
    const d = deriveIntegrity(events, base + 100_000, true);
    expect(d.focus_loss_count).toBe(2);
    expect(d.total_time_away_ms).toBe(15_000);
  });

  it('v0.1 sessions without study tab ignore stray study events (bit-for-bit stable)', () => {
    const base = Date.parse('2026-09-20T12:00:00.000Z');
    const events = [
      ev('a', 'attempt_started', base),
      ev('a', 'study_tab_inactive', base + 10_000),
      ev('a', 'study_tab_active', base + 20_000),
    ];
    const d = deriveIntegrity(events, base + 100_000, false);
    expect(d.focus_loss_count).toBe(0);
    expect(d.total_time_away_ms).toBe(0);
    expect(d.integrity_flag).toBe(false);
  });
});
