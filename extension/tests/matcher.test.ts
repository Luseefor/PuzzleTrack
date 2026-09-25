import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import type { ChessTempoAttempt } from '../src/models/chesstempo.js';
import { assignMatches, isAutoAppliable, scoreAttempt, type MatchableAttempt } from '../src/matching/matcher.js';
import { applyMatch, registerImport, unmatchAttempt } from '../src/matching/applyMatch.js';
import { completeAttempt, createSession, setManualProblemId, startAttempt } from '../src/session/sessionManager.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');

function pt(attemptId: string, startMs: number, endMs: number, manualProblemId: string | null = null): MatchableAttempt {
  return {
    attemptId,
    startedAtMs: startMs,
    endedAtMs: endMs,
    elapsedSeconds: (endMs - startMs) / 1000,
    manualProblemId,
  };
}

function ct(partial: Partial<ChessTempoAttempt> & { rowId: string }): ChessTempoAttempt {
  return {
    importId: 'imp1',
    sourceRow: 1,
    problemId: null,
    attemptedAt: null,
    problemRating: null,
    playerRatingBefore: null,
    playerRatingAfter: null,
    result: null,
    timeUsedSeconds: null,
    movesUsed: null,
    averageMoves: null,
    ratingChange: null,
    difficultyLabel: null,
    validity: 'valid',
    validityNotes: [],
    raw: {},
    ...partial,
  };
}

describe('matcher', () => {
  it('clear timestamp match: CT 1s after PT end is exact/high and auto-appliable', () => {
    // PT 13:02:00 -> 13:02:43, CT 13:02:44 (spec example).
    const rows = [ct({ rowId: 'r1', attemptedAt: new Date(T0 + 44_000).toISOString(), timeUsedSeconds: 43 })];
    const r = scoreAttempt(pt('a1', T0, T0 + 43_000), rows);
    expect(r.chessTempoRowId).toBe('r1');
    expect(['exact', 'high']).toContain(r.confidence);
    expect(r.timeDeltaMs).toBe(1000);
    expect(isAutoAppliable(r)).toBe(true);
  });

  it('exact problem-ID match wins even with supporting timestamp', () => {
    const rows = [
      ct({ rowId: 'r1', problemId: '81496', attemptedAt: new Date(T0 + 44_000).toISOString(), timeUsedSeconds: 43 }),
      ct({ rowId: 'r2', problemId: '99999', attemptedAt: new Date(T0 + 50_000).toISOString() }),
    ];
    const r = scoreAttempt(pt('a1', T0, T0 + 43_000, '81496'), rows);
    expect(r.confidence).toBe('exact');
    expect(r.chessTempoRowId).toBe('r1');
    expect(isAutoAppliable(r)).toBe(true);
  });

  it('ambiguous: two records near one attempt require manual resolution', () => {
    // Spec section 5: A #81496 @1:16:05, B #99213 @1:16:12 for attempt ending 1:16:04.
    const end = Date.parse('2026-09-20T13:16:04.000Z');
    const rows = [
      ct({ rowId: 'rA', problemId: '81496', attemptedAt: new Date(end + 1000).toISOString() }),
      ct({ rowId: 'rB', problemId: '99213', attemptedAt: new Date(end + 8000).toISOString() }),
    ];
    const r = scoreAttempt(pt('a4', end - 102_000, end), rows);
    expect(r.confidence).toBe('low');
    expect(r.chessTempoRowId).toBeNull();
    expect(r.candidates).toHaveLength(2);
    expect(isAutoAppliable(r)).toBe(false);
  });

  it('no match when nothing is near', () => {
    const rows = [ct({ rowId: 'r1', attemptedAt: new Date(T0 + 3_600_000).toISOString() })];
    const r = scoreAttempt(pt('a1', T0, T0 + 43_000), rows);
    expect(r.confidence).toBe('unmatched');
    expect(r.chessTempoRowId).toBeNull();
  });

  it('timestamp far outside window is not auto-matched (6 min after end)', () => {
    // PT 13:02 -> 13:05, CT 13:11 (spec example): must NOT auto-match.
    const rows = [ct({ rowId: 'r1', attemptedAt: new Date(T0 + 9 * 60_000).toISOString() })];
    const r = scoreAttempt(pt('a1', T0, T0 + 3 * 60_000), rows);
    expect(isAutoAppliable(r)).toBe(false);
  });

  it('one ChessTempo row cannot match two attempts (greedy 1:1)', () => {
    const rows = [ct({ rowId: 'r1', attemptedAt: new Date(T0 + 44_000).toISOString() })];
    const results = assignMatches([
      scoreAttempt(pt('a1', T0, T0 + 43_000), rows),
      scoreAttempt(pt('a2', T0 + 10_000, T0 + 50_000), rows),
    ]);
    const winners = results.filter((r) => r.chessTempoRowId === 'r1');
    expect(winners).toHaveLength(1);
  });

  it('one attempt cannot receive two active matches', () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 2, 900, T0);
    const a = startAttempt(store, session.session_id, T0);
    completeAttempt(store, a.attempt_id, T0 + 43_000);
    const r1 = ct({ rowId: 'imp1:row:1', problemId: '81496', attemptedAt: new Date(T0 + 44_000).toISOString() });
    const r2 = ct({ rowId: 'imp1:row:2', problemId: '99213', attemptedAt: new Date(T0 + 50_000).toISOString() });
    registerImport(store, {
      importId: 'imp1', importedAt: new Date(T0).toISOString(), originalFilename: 'h.csv',
      fileFingerprint: 'x', totalRows: 2, validRows: 2, partialRows: 0, invalidRows: 0,
      matchedRows: 0, unmatchedRows: 2, recognizedFields: [], missingFields: [], unknownHeaders: [],
    }, [r1, r2]);
    const first = applyMatch(store, { attemptId: a.attempt_id, row: r1, confidence: 'high', reasons: ['t'], timeDeltaMs: 1000, matchedBy: 'manual' });
    expect(first.applied).toBe(true);
    expect(() => applyMatch(store, { attemptId: a.attempt_id, row: r2, confidence: 'high', reasons: ['t'], timeDeltaMs: 7000, matchedBy: 'manual' })).toThrow();
    unmatchAttempt(store, a.attempt_id);
    const second = applyMatch(store, { attemptId: a.attempt_id, row: r2, confidence: 'high', reasons: ['t'], timeDeltaMs: 7000, matchedBy: 'manual' });
    expect(second.applied).toBe(true);
  });

  it('manual problem ID drives an exact match', () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 2, 900, T0);
    const a = startAttempt(store, session.session_id, T0);
    setManualProblemId(store, a.attempt_id, '81496', T0 + 1000);
    completeAttempt(store, a.attempt_id, T0 + 43_000);
    const rows = [ct({ rowId: 'r1', problemId: '81496', attemptedAt: new Date(T0 + 44_000).toISOString(), timeUsedSeconds: 44 })];
    const attempt = store.attempts[a.attempt_id];
    if (!attempt) throw new Error('missing');
    const r = scoreAttempt(
      { attemptId: attempt.attempt_id, startedAtMs: Date.parse(attempt.started_at), endedAtMs: Date.parse(attempt.ended_at as string), elapsedSeconds: attempt.elapsed_seconds, manualProblemId: attempt.manual_problem_id },
      rows,
    );
    expect(r.confidence).toBe('exact');
  });
});
