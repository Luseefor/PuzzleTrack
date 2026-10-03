/**
 * Timestamp-based attempt timer.
 *
 * Core principle: never trust a counter. The source of truth is
 *   deadlineMs = startedAtMs + timeLimitSeconds * 1000
 * and every tick computes
 *   remainingMs = deadlineMs - nowMs
 *   elapsedMs   = nowMs - startedAtMs
 * so throttled setInterval callbacks, popup closes, or service-worker
 * restarts cannot drift the measurement. On recovery we recompute from
 * the persisted started_at — we never restart the clock.
 */

export interface TimerSnapshot {
  startedAtMs: number;
  deadlineMs: number;
  nowMs: number;
  elapsedMs: number;
  remainingMs: number;
  /** remaining clamped at 0 for display. */
  remainingClampedMs: number;
  timedOut: boolean;
}

export function deadlineForAttempt(startedAtMs: number, timeLimitSeconds: number): number {
  return startedAtMs + timeLimitSeconds * 1000;
}

export function snapshotTimer(startedAtMs: number, timeLimitSeconds: number, nowMs: number): TimerSnapshot {
  const deadlineMs = deadlineForAttempt(startedAtMs, timeLimitSeconds);
  const elapsedMs = nowMs - startedAtMs;
  const remainingMs = deadlineMs - nowMs;
  return {
    startedAtMs,
    deadlineMs,
    nowMs,
    elapsedMs,
    remainingMs,
    remainingClampedMs: Math.max(0, remainingMs),
    timedOut: remainingMs <= 0,
  };
}

/** Recovery after popup reload / browser restart: recompute from stored started_at. */
export function recoverTimer(startedAtIso: string, timeLimitSeconds: number, nowMs: number): TimerSnapshot {
  const startedAtMs = Date.parse(startedAtIso);
  if (Number.isNaN(startedAtMs)) throw new Error(`Invalid started_at: ${startedAtIso}`);
  return snapshotTimer(startedAtMs, timeLimitSeconds, nowMs);
}

/**
 * Finalize an early finish (Complete / Abort).
 * Rejects negative or nonfinite elapsed time; wall-clock adjustments require review.
 */
export function finalizeElapsedMs(startedAtMs: number, endedAtMs: number): number {
  const elapsed = endedAtMs - startedAtMs;
  if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('Elapsed time cannot be negative or non-finite; check the system clock.');
  return elapsed;
}

/** Display tick interval (ms). Display only — completion is decided by timestamps. */
export const TIMER_TICK_MS = 250;
