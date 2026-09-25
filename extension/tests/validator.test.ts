import { describe, expect, it } from 'vitest';
import { emptyStore, type PuzzleTrackStore } from '../src/models/types.js';
import { Repository } from '../src/storage/repository.js';
import {
  EVENT_AFTER_END_TOLERANCE_MS,
  classifyTimerAgreement,
  validateStore,
} from '../src/validation/pilotValidator.js';
import {
  completeAttempt,
  createSession,
  setPilotReview,
  startAttempt,
  timeoutAttempt,
} from '../src/session/sessionManager.js';
import { recordFocusSignal } from '../src/session/sessionManager.js';
import { parseChessTempoCsv } from '../src/importer/chesstempoImporter.js';
import { applyMatch, registerImport } from '../src/matching/applyMatch.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');

/** A clean 2-attempt session: one interrupted completed, one clean completed. */
function cleanStore(): PuzzleTrackStore {
  const store = emptyStore();
  const session = createSession(store, 'P01', 2, 900, T0);
  const a1 = startAttempt(store, session.session_id, T0);
  recordFocusSignal(store, a1.attempt_id, 'window_blur', T0 + 10_000);
  recordFocusSignal(store, a1.attempt_id, 'window_focus', T0 + 18_000);
  completeAttempt(store, a1.attempt_id, T0 + 102_000);
  const a2 = startAttempt(store, session.session_id, T0 + 200_000);
  completeAttempt(store, a2.attempt_id, T0 + 260_000);
  return store;
}

function codes(report: ReturnType<typeof validateStore>, bucket: 'errors' | 'warnings'): string[] {
  return report[bucket].map((i) => i.code);
}

describe('pilot validator', () => {
  it('clean session passes with zero errors', () => {
    const report = validateStore(cleanStore());
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.summary.sessions).toBe(1);
    expect(report.summary.attempts).toBe(2);
    expect(report.summary.events).toBeGreaterThan(0);
  });

  it('negative elapsed fails', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    attempt.elapsed_ms = -5;
    const report = validateStore(store);
    expect(report.valid).toBe(false);
    expect(codes(report, 'errors')).toContain('attempt-negative-elapsed');
  });

  it('missing terminal event fails', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    store.events[attempt.attempt_id] = (store.events[attempt.attempt_id] ?? []).filter(
      (e) => e.event_type !== 'attempt_completed',
    );
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('events-missing-terminal');
  });

  it('timeout consistency: good timeout passes, wrong elapsed fails', () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 1, 900, T0);
    const a = startAttempt(store, session.session_id, T0);
    // Simulate timeout path via public API.
    timeoutAttempt(store, a.attempt_id, T0 + 900_000);
    expect(validateStore(store).valid).toBe(true);

    const stored = store.attempts[a.attempt_id];
    if (!stored) throw new Error('missing');
    stored.elapsed_ms = 899_000; // tamper: no longer equals limit
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('attempt-timeout-elapsed');
  });

  it('duplicate event ids fail', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    const list = store.events[attempt.attempt_id];
    if (!list || !list[0]) throw new Error('missing events');
    list.push({ ...list[0] });
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('events-duplicate-id');
  });

  it('away time greater than elapsed fails', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    attempt.total_time_away_ms = attempt.elapsed_ms + 1;
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('integrity-away-exceeds-elapsed');
  });

  it('integrity flag disagreeing with loss count fails', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    attempt.integrity_flag = false; // loss count is 1
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('integrity-flag-mismatch');
  });

  it('unmatched finished attempts produce warnings, not errors', () => {
    const report = validateStore(cleanStore());
    expect(report.valid).toBe(true);
    expect(codes(report, 'warnings')).toContain('session-unmatched');
  });

  it('chess values without a match link fail as silent-overwrite suspects', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    attempt.problem_id = '81496'; // no match entry
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('chess-without-match');
  });

  it('exact/high match without reasons fails', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    store.matches[attempt.attempt_id] = {
      matchId: 'm1',
      attemptId: attempt.attempt_id,
      chessTempoRowId: 'imp:row:1',
      importId: 'imp',
      confidence: 'exact',
      reasons: [],
      timeDeltaMs: 1,
      matchedAt: new Date(T0).toISOString(),
      matchedBy: 'auto',
      conflictResolved: false,
    };
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('match-missing-reasons');
  });

  it('timer agreement tiers: good silent, review/warning surfaced', () => {
    expect(classifyTimerAgreement(1.5)).toBe('good');
    expect(classifyTimerAgreement(-2)).toBe('good');
    expect(classifyTimerAgreement(2.1)).toBe('review');
    expect(classifyTimerAgreement(5)).toBe('review');
    expect(classifyTimerAgreement(5.1)).toBe('warning');
    expect(classifyTimerAgreement(null)).toBe('missing');
    expect(classifyTimerAgreement(Number.NaN)).toBe('missing');
  });

  it('matched timer differences appear as warnings with seconds in message', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    const parsed = parseChessTempoCsv(
      'Problem ID,Date,Problem Rating,Player Rating,Result,Time Used (s)\n81496,2026-09-20 13:03:50,1200,1000,Win,90',
      'h.csv', T0,
    );
    registerImport(store, parsed.import, parsed.rows);
    const row = parsed.rows[0];
    if (!row) throw new Error('missing row');
    // PT elapsed 102 s vs CT 90 s -> 12 s difference -> WARNING tier.
    const res = applyMatch(store, { attemptId: attempt.attempt_id, row, confidence: 'high', reasons: ['manual check'], timeDeltaMs: 8000, matchedBy: 'manual' });
    expect(res.applied).toBe(true);
    const report = validateStore(store);
    expect(report.valid).toBe(true);
    expect(codes(report, 'warnings')).toContain('timer-agreement-warning');
    const w = report.warnings.find((i) => i.code === 'timer-agreement-warning');
    expect(w?.message).toMatch(/12/);
  });

  it('events after end beyond tolerance fail; stragglers within tolerance pass', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt || !attempt.ended_at) throw new Error('missing');
    const endMs = Date.parse(attempt.ended_at);
    Repository.appendEvent(store, {
      event_id: 'straggler-1',
      attempt_id: attempt.attempt_id,
      timestamp: new Date(endMs + EVENT_AFTER_END_TOLERANCE_MS - 1).toISOString(),
      event_type: 'window_focus',
    });
    expect(validateStore(store).valid).toBe(true);
    Repository.appendEvent(store, {
      event_id: 'late-1',
      attempt_id: attempt.attempt_id,
      timestamp: new Date(endMs + 60_000).toISOString(),
      event_type: 'window_focus',
    });
    expect(codes(validateStore(store), 'errors')).toContain('events-after-end');
  });

  it('summary reconciliation catches corrupted result tallies', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    attempt.experimental_result = null; // finished but resultless: totals no longer reconcile
    const report = validateStore(store);
    expect(codes(report, 'errors')).toContain('summary-inconsistent');
  });

  it('orphan pilot review warns without invalidating', () => {
    const store = cleanStore();
    store.pilotReview['nope'] = { attempt_id: 'nope', status: 'verified', note: '', updated_at: new Date(T0).toISOString() };
    const report = validateStore(store);
    expect(report.valid).toBe(true);
    expect(codes(report, 'warnings')).toContain('review-orphan');
  });

  it('pilot review marking does not mutate raw data', () => {
    const store = cleanStore();
    const attempt = Object.values(store.attempts)[0];
    if (!attempt) throw new Error('missing');
    const before = JSON.stringify({ a: attempt, e: store.events[attempt.attempt_id] });
    setPilotReview(store, attempt.attempt_id, 'verified', 'looks good', T0);
    const after = JSON.stringify({ a: attempt, e: store.events[attempt.attempt_id] });
    expect(after).toBe(before);
    expect(store.pilotReview[attempt.attempt_id]?.status).toBe('verified');
    expect(validateStore(store).valid).toBe(true);
  });
});
