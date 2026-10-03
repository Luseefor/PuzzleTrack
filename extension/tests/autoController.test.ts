import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import { handleSiteEvent, recordLateSiteResult } from '../src/integrations/autoController.js';
import type { SiteEvent } from '../src/integrations/chessTempo/chessTempoTypes.js';
import { completeAttempt, createSession, startAttempt, timeoutAttempt } from '../src/session/sessionManager.js';
import { Repository } from '../src/storage/repository.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');

function autoSession(target = 10) {
  const store = emptyStore();
  const session = createSession(store, 'P01', target, 900, T0, true);
  return { store, session };
}

function loaded(problemId: string, rating: number | null = 702, displayed: number | null = 1507): SiteEvent {
  return {
    kind: 'problem_loaded',
    atMs: T0,
    problem: { problemId, problemRating: rating, difficultyLabel: 'Easy', mode: 'endgame' },
    context: { displayedRating: displayed },
  };
}

function completed(problemId: string, result: 'correct' | 'incorrect' | 'unknown' = 'correct', time = 43): SiteEvent {
  return {
    kind: 'problem_completed',
    atMs: T0 + 60_000,
    result: {
      problemId,
      result,
      timeUsedSeconds: time,
      movesUsed: 12,
      averageMoves: null,
      playerRatingAfter: 1513,
      ratingChange: 6,
    },
  };
}

describe('autoController: automatic start', () => {
  it('new stable problem starts an attempt with live metadata + directives', () => {
    const { store, session } = autoSession();
    const out = handleSiteEvent(store, loaded('81496'), T0);
    expect(out.handled).toBe(true);
    expect(store.activeAttemptId).not.toBeNull();
    const attempt = store.attempts[store.activeAttemptId as string];
    expect(attempt?.problem_id).toBe('81496');
    expect(attempt?.problem_rating).toBe(702);
    expect(attempt?.player_rating_before).toBe(1507);
    expect(attempt?.capture_origin).toBe('live');
    expect(attempt?.experimental_result).toBeNull();
    const obs = store.liveObservations[attempt?.attempt_id as string];
    expect(obs?.problemId).toBe('81496');
    expect(obs?.siteResult).toBe('unknown');
    const kinds = out.directives.map((d) => d.kind);
    expect(kinds).toContain('schedule-timeout');
    expect(kinds).toContain('notify-attempt-started');
    expect(session.session_id).toBe(attempt?.session_id);
  });

  it('no start without an auto session (manual untouched)', () => {
    const store = emptyStore();
    createSession(store, 'P01', 10, 900, T0, false);
    const out = handleSiteEvent(store, loaded('81496'), T0);
    expect(out.handled).toBe(false);
    expect(store.activeAttemptId).toBeNull();
  });

  it('no start while an attempt is already active', () => {
    const { store, session } = autoSession();
    const a = startAttempt(store, session.session_id, T0);
    const out = handleSiteEvent(store, loaded('92142'), T0 + 1000);
    expect(store.activeAttemptId).toBe(a.attempt_id);
    expect(out.notes.some((n) => n.startsWith('attempt-active-ignored'))).toBe(true);
  });

  it('problem switch mid-attempt flags review without guessing', () => {
    const { store, session } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    handleSiteEvent(store, loaded('92142'), T0 + 1000);
    expect(store.activeAttemptId).toBe(id); // no new attempt
    expect(store.attempts[id]?.requires_review).toBe(true);
    expect(store.attempts[id]?.problem_id).toBe('81496'); // unchanged
  });

  it('same problem rerender never duplicates', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId;
    completeAttempt(store, id as string, T0 + 60_000);
    const out = handleSiteEvent(store, loaded('81496'), T0 + 61_000);
    expect(out.notes.some((n) => n.startsWith('duplicate-problem-ignored'))).toBe(true);
    expect(Repository.attemptsForSession(store, Object.keys(store.sessions)[0] as string)).toHaveLength(1);
  });

  it('never starts past the session target (no attempt 11 of 10)', () => {
    const { store } = autoSession(1);
    handleSiteEvent(store, loaded('81496'), T0);
    completeAttempt(store, store.activeAttemptId as string, T0 + 60_000);
    expect(store.sessions[Object.keys(store.sessions)[0] as string]?.status).toBe('completed');
    const out = handleSiteEvent(store, loaded('92142'), T0 + 61_000);
    expect(store.activeAttemptId).toBeNull();
    expect(out.handled).toBe(false); // no auto session left to serve
    expect(Repository.attemptsForSession(store, Object.keys(store.sessions)[0] as string)).toHaveLength(1);
  });
});

describe('autoController: automatic completion', () => {
  it('site result completes the attempt with exact elapsed + metadata', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    const out = handleSiteEvent(store, completed('81496'), T0 + 102_000);
    const attempt = store.attempts[id];
    expect(attempt?.experimental_result).toBe('completed');
    expect(attempt?.elapsed_ms).toBe(102_000);
    expect(attempt?.chesstempo_result).toBe('correct');
    expect(attempt?.chesstempo_time_used_seconds).toBe(43);
    expect(attempt?.moves_used).toBe(12);
    expect(attempt?.player_rating_after).toBe(1513);
    expect(attempt?.rating_change).toBe(6);
    expect(store.liveObservations[id]?.siteResult).toBe('correct');
    expect(out.directives.some((d) => d.kind === 'clear-timeout')).toBe(true);
  });

  it('stores each step duration against the matching problem and ignores duplicates', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    const step: SiteEvent = {
      kind: 'step_completed', atMs: T0 + 5000, problemId: '81496', stepNumber: 1, durationMs: 5000,
    };
    handleSiteEvent(store, step, T0 + 5000);
    handleSiteEvent(store, step, T0 + 5100);
    expect(store.attempts[id]?.step_durations_ms).toEqual([{ step_number: 1, duration_ms: 5000 }]);
  });

  it('unknown site result preserves timing and flags review', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    handleSiteEvent(store, completed('81496', 'unknown', 50), T0 + 50_000);
    const attempt = store.attempts[id];
    expect(attempt?.experimental_result).toBe('completed');
    expect(attempt?.elapsed_ms).toBe(50_000);
    expect(attempt?.chesstempo_result).toBe('unknown');
    expect(attempt?.requires_review).toBe(true);
  });

  it('timeout stays authoritative when the site result arrives late', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    timeoutAttempt(store, id, T0 + 900_000);
    const before = { ...(store.attempts[id] as object) };
    const out = handleSiteEvent(store, completed('81496'), T0 + 905_000);
    const attempt = store.attempts[id];
    // Experimental record untouched:
    expect(attempt?.experimental_result).toBe('timeout');
    expect(attempt?.timed_out).toBe(true);
    expect(attempt?.elapsed_ms).toBe((before as { elapsed_ms: number }).elapsed_ms);
    // Site outcome recorded separately:
    expect(attempt?.chesstempo_result).toBe('correct');
    expect(store.liveObservations[id]?.lateArrival).toBe(true);
    expect(out.notes.some((n) => n.startsWith('late-site-result'))).toBe(true);
  });

  it('duplicate late result is ignored, not double-applied', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    timeoutAttempt(store, id, T0 + 900_000);
    handleSiteEvent(store, completed('81496'), T0 + 905_000);
    const out = handleSiteEvent(store, completed('81496'), T0 + 906_000);
    expect(out.notes.some((n) => n.startsWith('result-no-target-ignored'))).toBe(true);
  });

  it('result for a different problem than the active one is ignored + flagged', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    const out = handleSiteEvent(store, completed('99999'), T0 + 60_000);
    expect(store.attempts[id]?.ended_at).toBeNull(); // still running
    expect(store.attempts[id]?.requires_review).toBe(true);
    expect(out.notes.some((n) => n.startsWith('result-mismatch-ignored'))).toBe(true);
  });

  it('late site result after a manual fallback finish fills metadata only', () => {
    const { store, session } = autoSession();
    const a = startAttempt(store, session.session_id, T0); // manual start in auto session
    completeAttempt(store, a.attempt_id, T0 + 70_000);
    const ok = recordLateSiteResult(store, a.attempt_id, {
      problemId: '81496',
      result: 'correct',
      timeUsedSeconds: 65,
      movesUsed: 10,
      averageMoves: null,
      playerRatingAfter: 1510,
      ratingChange: 4,
    }, T0 + 75_000);
    expect(ok).toBe(true);
    const attempt = store.attempts[a.attempt_id];
    expect(attempt?.experimental_result).toBe('completed');
    expect(attempt?.elapsed_ms).toBe(70_000);
    expect(attempt?.chesstempo_time_used_seconds).toBe(65);
  });

  it('problem_changed flags the active attempt for review', () => {
    const { store } = autoSession();
    handleSiteEvent(store, loaded('81496'), T0);
    const id = store.activeAttemptId as string;
    handleSiteEvent(store, { kind: 'problem_changed', atMs: T0 + 1000, previousProblemId: '81496' }, T0 + 1000);
    expect(store.attempts[id]?.requires_review).toBe(true);
    expect(store.attempts[id]?.ended_at).toBeNull();
  });
});
