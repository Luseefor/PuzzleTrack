import { describe, expect, it } from 'vitest';
import { deadlineForAttempt, finalizeElapsedMs, recoverTimer, snapshotTimer } from '../src/timer/attemptTimer.js';

describe('attemptTimer', () => {
  it('starts correctly: full remaining, zero elapsed', () => {
    const s = snapshotTimer(1_000_000, 900, 1_000_000);
    expect(s.elapsedMs).toBe(0);
    expect(s.remainingMs).toBe(900_000);
    expect(s.timedOut).toBe(false);
  });

  it('completing early keeps exact elapsed time', () => {
    expect(finalizeElapsedMs(1_000_000, 1_134_567)).toBe(134_567);
  });

  it('timeout occurs exactly at the limit', () => {
    const start = 1_000_000;
    const before = snapshotTimer(start, 900, start + 899_999);
    expect(before.timedOut).toBe(false);
    const at = snapshotTimer(start, 900, start + 900_000);
    expect(at.timedOut).toBe(true);
    expect(at.remainingClampedMs).toBe(0);
  });

  it('timestamp-based logic survives delayed callbacks (no drift)', () => {
    // Interval throttled: callback fires 5s late. Timestamp math still exact.
    const start = 1_000_000;
    const lateNow = start + 65_000; // 65s wall clock, callback delayed
    const s = snapshotTimer(start, 900, lateNow);
    expect(s.elapsedMs).toBe(65_000);
    expect(s.remainingMs).toBe(900_000 - 65_000);
  });

  it('reload recovery calculates correct remaining from stored started_at', () => {
    const startedAt = new Date(1_000_000).toISOString();
    const s = recoverTimer(startedAt, 900, 1_000_000 + 134_000);
    expect(s.elapsedMs).toBe(134_000);
    expect(s.remainingMs).toBe(900_000 - 134_000);
    expect(deadlineForAttempt(1_000_000, 900)).toBe(1_900_000);
  });

  it('rejects negative elapsed beyond clock skew', () => {
    expect(() => finalizeElapsedMs(2_000_000, 1_000_000)).toThrow();
  });
});
