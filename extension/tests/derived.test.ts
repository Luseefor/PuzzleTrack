import { describe, expect, it } from 'vitest';
import {
  attemptCompletedWithinLimit,
  attemptHadIntegrityInterruption,
  awayTimePercentage,
  deriveAttempt,
  isCorrectChessTempoResult,
  relativeDifficulty,
  summarizeChess,
  timerDifferenceSeconds,
} from '../src/analysis/derived.js';
import type { Attempt } from '../src/models/types.js';

function base(partial: Partial<Attempt> = {}): Attempt {
  return {
    attempt_id: 'a', session_id: 's', attempt_number: 1,
    started_at: '2026-01-01T12:00:00.000Z', ended_at: '2026-01-01T12:02:00.000Z',
    elapsed_ms: 120_000, elapsed_seconds: 120, time_limit_seconds: 900,
    timed_out: false, experimental_result: 'completed',
    focus_loss_count: 0, total_time_away_ms: 0, integrity_flag: false,
    possibly_interrupted: false,
    problem_id: null, problem_rating: null, player_rating_before: null,
    player_rating_after: null, chesstempo_result: null, moves_used: null,
    average_moves: null, rating_change: null, difficulty_label: null,
    manual_problem_id: null, chesstempo_attempted_at: null,
    chesstempo_time_used_seconds: null, chesstempo_import_id: null,
    step_durations_ms: null,
    chesstempo_source_row: null, match_confidence: null,
    capture_origin: null,
    cross_validation: null,
    requires_review: false,
    ...partial,
  };
}

describe('derived variables', () => {
  it('relative difficulty: 1200 problem - 1000 player = +200', () => {
    expect(relativeDifficulty(base({ problem_rating: 1200, player_rating_before: 1000 }))).toBe(200);
  });

  it('null ratings yield null, never misleading zeros', () => {
    expect(relativeDifficulty(base({ problem_rating: 1200 }))).toBeNull();
    expect(relativeDifficulty(base({ player_rating_before: 1000 }))).toBeNull();
    expect(relativeDifficulty(base())).toBeNull();
  });

  it('timer difference compares PuzzleTrack vs ChessTempo timing', () => {
    expect(timerDifferenceSeconds(base({ elapsed_seconds: 102, chesstempo_time_used_seconds: 100 }))).toBe(2);
    expect(timerDifferenceSeconds(base())).toBeNull();
  });

  it('away percentage handles zero elapsed safely', () => {
    expect(awayTimePercentage(base({ elapsed_ms: 120_000, total_time_away_ms: 30_000 }))).toBeCloseTo(0.25);
    expect(awayTimePercentage(base({ elapsed_ms: 0, total_time_away_ms: 5000 }))).toBeNull();
  });

  it('completed-within-limit and interruption flags', () => {
    expect(attemptCompletedWithinLimit(base())).toBe(true);
    expect(attemptCompletedWithinLimit(base({ timed_out: true }))).toBe(false);
    expect(attemptCompletedWithinLimit(base({ ended_at: null }))).toBeNull();
    expect(attemptHadIntegrityInterruption(base({ integrity_flag: true }))).toBe(true);
  });

  it('deriveAttempt bundles all derived fields', () => {
    const d = deriveAttempt(base({ problem_rating: 1200, player_rating_before: 1000, chesstempo_time_used_seconds: 100 }));
    expect(d.relative_difficulty).toBe(200);
    expect(d.timer_difference_seconds).toBe(20);
  });

  it('correctness heuristic is conservative', () => {
    expect(isCorrectChessTempoResult('Win')).toBe(true);
    expect(isCorrectChessTempoResult('loss')).toBe(false);
    expect(isCorrectChessTempoResult(null)).toBeNull();
    expect(isCorrectChessTempoResult('')).toBeNull();
    expect(isCorrectChessTempoResult('mysterious-future-value')).toBeNull();
  });

  it('chess summary ignores missing values instead of misleading', () => {
    const attempts = [
      base({ match_confidence: 'high', problem_rating: 1200, player_rating_before: 1000, chesstempo_result: 'Win', rating_change: 16 }),
      base({ attempt_id: 'b', match_confidence: 'high', problem_rating: 1400, player_rating_before: 1000, chesstempo_result: 'Loss', rating_change: -12 }),
      base({ attempt_id: 'c' }), // unmatched
    ];
    const s = summarizeChess(attempts);
    expect(s.matched).toBe(2);
    expect(s.unmatched).toBe(1);
    expect(s.correct).toBe(1);
    expect(s.medianProblemRating).toBe(1300);
    expect(s.medianRelativeDifficulty).toBe(300);
    expect(s.averageRatingChange).toBe(2);
  });

  it('chess summary with no data yields nulls, not zeros', () => {
    const s = summarizeChess([base()]);
    expect(s.matched).toBe(0);
    expect(s.correct).toBeNull();
    expect(s.medianProblemRating).toBeNull();
    expect(s.averageRatingChange).toBeNull();
  });
});
