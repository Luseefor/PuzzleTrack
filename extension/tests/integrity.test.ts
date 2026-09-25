import { describe, expect, it } from 'vitest';
import {
  applyFocusEvent,
  deriveIntegrity,
  initialFocusState,
} from '../src/integrity/focusTracker.js';
import type { IntegrityEvent } from '../src/models/types.js';

function ev(attempt_id: string, type: IntegrityEvent['event_type'], ms: number): IntegrityEvent {
  return { event_id: `e-${type}-${ms}`, attempt_id, timestamp: new Date(ms).toISOString(), event_type: type };
}

describe('integrity focusTracker', () => {
  it('blur/focus pair creates one interruption with exact away time', () => {
    const events = [
      ev('a', 'attempt_started', 0),
      ev('a', 'window_blur', 10_000),
      ev('a', 'window_focus', 25_000),
    ];
    const d = deriveIntegrity(events, 100_000);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBe(15_000);
    expect(d.integrity_flag).toBe(true);
  });

  it('hidden/visible pair works the same way', () => {
    const events = [ev('a', 'attempt_started', 0), ev('a', 'tab_hidden', 5_000), ev('a', 'tab_visible', 13_000)];
    const d = deriveIntegrity(events, 100_000);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBe(8_000);
  });

  it('overlapping blur + hidden does NOT double-count (spec example: ~15s not 30s)', () => {
    // 12:02:10 tab_hidden + window_blur, 12:02:25 window_focus + tab_visible
    const base = Date.parse('2026-01-01T12:00:00.000Z');
    const events = [
      ev('a', 'attempt_started', base),
      ev('a', 'tab_hidden', base + 130_000),
      ev('a', 'window_blur', base + 130_050),
      ev('a', 'window_focus', base + 145_000),
      ev('a', 'tab_visible', base + 145_050),
    ];
    const d = deriveIntegrity(events, base + 270_000);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBeGreaterThanOrEqual(15_000);
    expect(d.total_time_away_ms).toBeLessThan(16_000);
  });

  it('zero interruptions gives zero time away and false flag', () => {
    const d = deriveIntegrity([ev('a', 'attempt_started', 0)], 100_000);
    expect(d.focus_loss_count).toBe(0);
    expect(d.total_time_away_ms).toBe(0);
    expect(d.integrity_flag).toBe(false);
  });

  it('redundant regain signals while present are ignored', () => {
    let s = initialFocusState();
    s = applyFocusEvent(s, 'window_focus', 1000);
    s = applyFocusEvent(s, 'tab_visible', 2000);
    expect(s.lossCount).toBe(0);
    expect(s.totalAwayMs).toBe(0);
  });

  it('open away-window at read time measures up to nowMs', () => {
    const events = [ev('a', 'attempt_started', 0), ev('a', 'window_blur', 50_000)];
    const d = deriveIntegrity(events, 60_000);
    expect(d.focus_loss_count).toBe(1);
    expect(d.total_time_away_ms).toBe(10_000);
  });
});
