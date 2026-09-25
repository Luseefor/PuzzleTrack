import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import type { ChessTempoImport } from '../src/models/chesstempo.js';
import { parseChessTempoCsv } from '../src/importer/chesstempoImporter.js';
import { applyMatch, registerImport, rowClaimedBy } from '../src/matching/applyMatch.js';
import { completeAttempt, createSession, startAttempt } from '../src/session/sessionManager.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');
const CSV = [
  'Problem ID,Date,Problem Rating,Result,Time Used (s)',
  '81496,2026-09-20 13:02:44,1200,Win,43',
  '99213,2026-09-20 13:16:05,1250,Loss,102',
].join('\n');

function setupMatched(): ReturnType<typeof setup> {
  return setup();
}

function setup() {
  const store = emptyStore();
  const session = createSession(store, 'P01', 2, 900, T0);
  const a = startAttempt(store, session.session_id, T0);
  completeAttempt(store, a.attempt_id, T0 + 43_000);
  return { store, attemptId: a.attempt_id };
}

function toImport(store: ReturnType<typeof setup>['store'], csv: string, filename: string): { imp: ChessTempoImport; rows: ReturnType<typeof parseChessTempoCsv>['rows'] } {
  const parsed = parseChessTempoCsv(csv, filename, T0);
  return { imp: parsed.import, rows: parsed.rows };
}

describe('duplicates and conflicts', () => {
  it('importing the same history twice stores no duplicates', () => {
    const { store } = setupMatched();
    const { imp, rows } = toImport(store, CSV, 'h.csv');
    const first = registerImport(store, imp, rows);
    expect(first.storedRows).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    const parsed2 = parseChessTempoCsv(CSV, 'h.csv', T0 + 1000);
    // New import id, same content: rows skipped as duplicates.
    const second = registerImport(store, parsed2.import, parsed2.rows);
    expect(second.storedRows).toBe(0);
    expect(second.skippedDuplicates).toBe(2);
    expect(Object.values(store.importRows).flat()).toHaveLength(2);
  });

  it('overlapping exports keep only genuinely new rows', () => {
    const { store } = setupMatched();
    const { imp, rows } = toImport(store, CSV, 'h1.csv');
    registerImport(store, imp, rows);
    const extended = CSV + '\n77777,2026-09-21 10:00:00,1300,Win,50';
    const p2 = parseChessTempoCsv(extended, 'h2.csv', T0);
    const res = registerImport(store, p2.import, p2.rows);
    expect(res.storedRows).toBe(1);
    expect(res.skippedDuplicates).toBe(2);
  });

  it('conflicting data is reported, never silently overwritten', () => {
    const { store, attemptId } = setupMatched();
    const { imp, rows } = toImport(store, CSV, 'h1.csv');
    registerImport(store, imp, rows);
    const row = rows.find((r) => r.problemId === '81496');
    if (!row) throw new Error('missing row');
    // Existing matched value 704 vs incoming 709 (spec example shape).
    const attempt = store.attempts[attemptId];
    if (!attempt) throw new Error('missing attempt');
    attempt.problem_rating = 704;

    const res = applyMatch(store, {
      attemptId, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 1000, matchedBy: 'manual',
    });
    expect(res.applied).toBe(false);
    expect(res.conflicts.length).toBeGreaterThan(0);
    expect(res.conflicts[0]?.field).toBe('problem_rating');
    expect(res.conflicts[0]?.existingValue).toBe(704);
    // Nothing written.
    expect(store.attempts[attemptId]?.problem_rating).toBe(704);
    expect(store.matches[attemptId]).toBeUndefined();
  });

  it('conflict resolution: keepExisting links without overwriting; useNew overwrites with provenance', () => {
    const { store, attemptId } = setupMatched();
    const { imp, rows } = toImport(store, CSV, 'h1.csv');
    registerImport(store, imp, rows);
    const row = rows.find((r) => r.problemId === '81496');
    if (!row) throw new Error('missing row');
    const attempt = store.attempts[attemptId];
    if (!attempt) throw new Error('missing attempt');
    attempt.problem_rating = 704;

    const kept = applyMatch(store, {
      attemptId, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 1000, matchedBy: 'manual', resolution: 'keepExisting',
    });
    expect(kept.applied).toBe(true);
    expect(kept.match?.conflictResolved).toBe(true);
    expect(store.attempts[attemptId]?.problem_rating).toBe(704); // untouched
    expect(store.attempts[attemptId]?.chesstempo_import_id).toBe(imp.importId); // provenance still linked

    const used = applyMatch(store, {
      attemptId, row, confidence: 'high', reasons: ['t2'], timeDeltaMs: 1000, matchedBy: 'manual', resolution: 'useNew',
    });
    // Same row re-applied: allowed (same match), now overwrites.
    expect(used.applied).toBe(true);
    expect(store.attempts[attemptId]?.problem_rating).toBe(1200);
  });

  it('a row claimed by one attempt cannot be taken by another', () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 3, 900, T0);
    const a1 = startAttempt(store, session.session_id, T0);
    completeAttempt(store, a1.attempt_id, T0 + 43_000);
    const a2 = startAttempt(store, session.session_id, T0 + 100_000);
    completeAttempt(store, a2.attempt_id, T0 + 150_000);
    const { imp, rows } = toImport(store, CSV, 'h.csv');
    registerImport(store, imp, rows);
    const row = rows[0];
    if (!row) throw new Error('missing');
    applyMatch(store, { attemptId: a1.attempt_id, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 1, matchedBy: 'manual' });
    expect(rowClaimedBy(store, row.rowId)).toBe(a1.attempt_id);
    expect(() => applyMatch(store, { attemptId: a2.attempt_id, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 1, matchedBy: 'manual' })).toThrow();
  });
});
