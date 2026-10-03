import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import { liveAgreesWithRow, applyMatch, registerImport, unmatchAttempt } from '../src/matching/applyMatch.js';
import { parseChessTempoCsv } from '../src/importer/chesstempoImporter.js';
import { handleSiteEvent } from '../src/integrations/autoController.js';
import { completeAttempt, createSession } from '../src/session/sessionManager.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');

function liveSession() {
  const store = emptyStore();
  const session = createSession(store, 'P01', 2, 900, T0, true);
  return { store, session };
}

function loadProblem(store: ReturnType<typeof liveSession>['store'], id: string, t: number): string {
  const out = handleSiteEvent(store, {
    kind: 'problem_loaded',
    atMs: t,
    problem: { problemId: id, problemRating: 702, difficultyLabel: 'Easy', mode: 'endgame' },
    context: { displayedRating: 1507 },
  }, t);
  expect(out.handled).toBe(true);
  return store.activeAttemptId as string;
}

function historyRow(sourceRow = 1) {
  const parsed = parseChessTempoCsv(
    'Problem ID,Date,Problem Rating,Player Rating,Result,Time Used (s)\n81496,2026-09-20 13:03:50,702,1507,Win,43',
    'history.csv', T0,
  );
  return { imp: parsed.import, rows: parsed.rows, sourceRow };
}

describe('live + history cross-validation', () => {
  it('agreement confirms: live observation + matching history row', () => {
    const { store } = liveSession();
    const id = loadProblem(store, '81496', T0);
    handleSiteEvent(store, {
      kind: 'problem_completed',
      atMs: T0 + 43_000,
      result: { problemId: '81496', result: 'correct', timeUsedSeconds: 43, movesUsed: 12, averageMoves: null, playerRatingAfter: 1513, ratingChange: 6 },
    }, T0 + 43_000);

    const { imp, rows } = historyRow();
    registerImport(store, imp, rows);
    const row = rows[0];
    if (!row) throw new Error('missing row');
    const res = applyMatch(store, { attemptId: id, row, confidence: 'exact', reasons: ['id+time'], timeDeltaMs: 1000, matchedBy: 'auto' });
    expect(res.applied).toBe(true);
    const attempt = store.attempts[id];
    expect(attempt?.capture_origin).toBe('live+history');
    expect(attempt?.cross_validation).toBe('confirmed');
  });

  it('disagreement surfaces a conflict, never silently reconciles', () => {
    const { store } = liveSession();
    const id = loadProblem(store, '81496', T0);
    handleSiteEvent(store, {
      kind: 'problem_completed',
      atMs: T0 + 43_000,
      result: { problemId: '81496', result: 'correct', timeUsedSeconds: 43, movesUsed: 12, averageMoves: null, playerRatingAfter: 1513, ratingChange: 6 },
    }, T0 + 43_000);

    // History says a DIFFERENT problem for the same time window.
    const parsed = parseChessTempoCsv(
      'Problem ID,Date,Problem Rating,Result,Time Used (s)\n92142,2026-09-20 13:03:50,715,Loss,102',
      'history.csv', T0,
    );
    registerImport(store, parsed.import, parsed.rows);
    const row = parsed.rows[0];
    if (!row) throw new Error('missing row');
    // Field conflicts surface first; the researcher explicitly overrides.
    const blocked = applyMatch(store, { attemptId: id, row, confidence: 'low', reasons: ['manual'], timeDeltaMs: 1000, matchedBy: 'manual' });
    expect(blocked.applied).toBe(false);
    expect(blocked.conflicts.length).toBeGreaterThan(0);
    const res = applyMatch(store, { attemptId: id, row, confidence: 'low', reasons: ['manual override'], timeDeltaMs: 1000, matchedBy: 'manual', resolution: 'useNew' });
    expect(res.applied).toBe(true); // researcher explicitly applied
    expect(store.attempts[id]?.cross_validation).toBe('conflict');
    // Live values were overwritten only via explicit manual apply; the live
    // observation itself is preserved for audit.
    expect(store.liveObservations[id]?.problemId).toBe('81496');
  });

  it('unmatch restores live values instead of erasing the run', () => {
    const { store } = liveSession();
    const id = loadProblem(store, '81496', T0);
    completeAttempt(store, id, T0 + 43_000);
    const { imp, rows } = historyRow();
    registerImport(store, imp, rows);
    const row = rows[0];
    if (!row) throw new Error('missing row');
    applyMatch(store, { attemptId: id, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 1, matchedBy: 'manual' });
    unmatchAttempt(store, id);
    const attempt = store.attempts[id];
    expect(attempt?.problem_id).toBe('81496');
    expect(attempt?.capture_origin).toBe('live');
    expect(attempt?.cross_validation).toBeNull();
    expect(store.matches[id]).toBeUndefined();
  });

  it('liveAgreesWithRow tolerates clock rounding, rejects real divergence', () => {
    const obs = {
      attempt_id: 'a', problemId: '81496', problemRating: 702, difficultyLabel: null, mode: null,
      playerRatingBefore: 1507, siteResult: 'correct' as const, timeUsedSeconds: 43, movesUsed: null,
      averageMoves: null, playerRatingAfter: null, ratingChange: null, lateArrival: false, observedAt: new Date(T0).toISOString(),
    };
    const { rows } = historyRow();
    const row = rows[0];
    if (!row) throw new Error('missing');
    expect(liveAgreesWithRow(obs, row)).toBe(true);
    expect(liveAgreesWithRow({ ...obs, timeUsedSeconds: 45 }, row)).toBe(true); // ±2 s rounding
    expect(liveAgreesWithRow({ ...obs, timeUsedSeconds: 60 }, row)).toBe(false);
    expect(liveAgreesWithRow({ ...obs, problemId: '92142' }, row)).toBe(false);
    expect(liveAgreesWithRow({ ...obs, siteResult: 'incorrect' }, row)).toBe(false);
  });
});
