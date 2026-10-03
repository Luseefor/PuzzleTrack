/**
 * Computed research variables (v0.2). PURE functions, computed on demand —
 * never stored as authoritative raw values. All helpers are null-safe:
 * missing inputs yield null (never misleading zeros), zero elapsed yields
 * null percentages (never Infinity).
 */
import type { Attempt } from '../models/types.js';

/** problem_rating - player_rating_before. Null when either is missing. */
export function relativeDifficulty(a: Pick<Attempt, 'problem_rating' | 'player_rating_before'>): number | null {
  if (a.problem_rating === null || a.player_rating_before === null) return null;
  return a.problem_rating - a.player_rating_before;
}

/**
 * PuzzleTrack elapsed_seconds MINUS ChessTempo time_used_seconds.
 * Validates timer agreement. Null when either is missing.
 */
export function timerDifferenceSeconds(a: Pick<Attempt, 'elapsed_seconds' | 'chesstempo_time_used_seconds'>): number | null {
  if (a.chesstempo_time_used_seconds === null) return null;
  return a.elapsed_seconds - a.chesstempo_time_used_seconds;
}

/** total_time_away_ms / elapsed_ms as a 0..1 fraction. Null when elapsed is 0. */
export function awayTimePercentage(a: Pick<Attempt, 'total_time_away_ms' | 'elapsed_ms'>): number | null {
  if (a.elapsed_ms <= 0) return null;
  return a.total_time_away_ms / a.elapsed_ms;
}

/** True when a finished attempt ended at or before its limit (timeouts excluded). */
export function attemptCompletedWithinLimit(a: Pick<Attempt, 'ended_at' | 'timed_out' | 'elapsed_ms' | 'time_limit_seconds'>): boolean | null {
  if (a.ended_at === null) return null;
  if (a.timed_out) return false;
  return a.elapsed_ms <= a.time_limit_seconds * 1000;
}

export function attemptHadIntegrityInterruption(a: Pick<Attempt, 'integrity_flag'>): boolean {
  return a.integrity_flag;
}

export interface AttemptDerived {
  relative_difficulty: number | null;
  timer_difference_seconds: number | null;
  away_time_percentage: number | null;
  completed_within_limit: boolean | null;
  had_integrity_interruption: boolean;
}

export function deriveAttempt(a: Attempt): AttemptDerived {
  return {
    relative_difficulty: relativeDifficulty(a),
    timer_difference_seconds: timerDifferenceSeconds(a),
    away_time_percentage: awayTimePercentage(a),
    completed_within_limit: attemptCompletedWithinLimit(a),
    had_integrity_interruption: attemptHadIntegrityInterruption(a),
  };
}

function medianOrNull(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid] as number;
  return (((xs[mid - 1] as number) + (xs[mid] as number)) / 2);
}

function meanOrNull(values: number[]): number | null {
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length === 0) return null;
  return (xs.reduce((s, v) => s + v, 0) as number) / xs.length;
}

/** Heuristic: does a raw ChessTempo result string mean "solved correctly"? Documented as heuristic. */
export function isCorrectChessTempoResult(result: string | null): boolean | null {
  if (result === null) return null;
  const t = result.trim().toLowerCase();
  if (t === '') return null;
  if (
    t === 'win' ||
    t === 'won' ||
    t === 'correct' ||
    t === 'solved' ||
    t === 'success' ||
    t === '1' ||
    t === '1-0' ||
    t === 'true' ||
    t === 'yes'
  ) return true;
  if (['loss', 'lost', 'incorrect', 'wrong', 'failed', 'fail', '0', '0-1', 'false', 'no'].includes(t)) return false;
  return null;
}

export interface SessionChessSummary {
  matched: number;
  unmatched: number;
  correct: number | null;
  withResult: number;
  medianProblemRating: number | null;
  medianRelativeDifficulty: number | null;
  averageRatingChange: number | null;
}

export function summarizeChess(attempts: Attempt[]): SessionChessSummary {
  const matched = attempts.filter((a) => a.match_confidence !== null && a.match_confidence !== 'unmatched');
  const correctness = matched.map((a) => isCorrectChessTempoResult(a.chesstempo_result));
  const known = correctness.filter((c): c is boolean => c !== null);
  return {
    matched: matched.length,
    unmatched: attempts.filter((a) => a.ended_at !== null).length - matched.length,
    correct: known.length > 0 ? known.filter(Boolean).length : null,
    withResult: known.length,
    medianProblemRating: medianOrNull(matched.map((a) => a.problem_rating).filter((v): v is number => v !== null)),
    medianRelativeDifficulty: medianOrNull(
      matched.map((a) => relativeDifficulty(a)).filter((v): v is number => v !== null),
    ),
    averageRatingChange: meanOrNull(matched.map((a) => a.rating_change).filter((v): v is number => v !== null)),
  };
}
