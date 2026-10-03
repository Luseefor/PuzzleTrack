/**
 * Automation controller (v0.3). Drives PuzzleTrack session/attempt lifecycle
 * from semantic site events. Consumes ONLY SiteEvent plain data — no DOM, no
 * selectors, no page access. All timing stays timestamp-based; PuzzleTrack's
 * experimental time limit remains authoritative over any site outcome.
 *
 * Invariants (all unit-tested):
 * - Never starts without an active auto-mode session.
 * - Never starts when an attempt is already active.
 * - Never starts beyond the session target count.
 * - Never starts twice for the same problem id (rerender protection).
 * - Never overwrites an experimental timeout with a later site result.
 * - Never guesses results: unknown site outcomes finish the attempt as
 *   completed (the solving run ended) with chesstempo_result "unknown" and
 *   requires_review set. Raw timing is always preserved.
 */
import { nowIso } from '../utils/time.js';
import { Repository } from '../storage/repository.js';
import type { LiveObservation } from '../models/chesstempo.js';
import type { Attempt, PuzzleTrackStore } from '../models/types.js';
import type { SiteEvent, SiteResult } from './chessTempo/chessTempoTypes.js';
import { completeAttempt, startAttempt } from '../session/sessionManager.js';

export interface AutoDirective {
  kind: 'schedule-timeout' | 'clear-timeout' | 'notify-attempt-started' | 'notify-attempt-ended';
  attemptId: string;
  problemId: string;
  deadlineMs?: number;
}

export interface AutoOutcome {
  handled: boolean;
  notes: string[];
  directives: AutoDirective[];
}

function noop(note: string): AutoOutcome {
  return { handled: false, notes: [note], directives: [] };
}

function activeAutoSession(store: PuzzleTrackStore): AutoOutcome | { sessionId: string } {
  const sessionId = store.activeSessionId;
  if (!sessionId) return noop('no-active-session');
  const session = store.sessions[sessionId];
  if (!session || session.status !== 'active') return noop('no-active-session');
  if (!session.auto_mode) return noop('session-not-auto');
  return { sessionId };
}

function sessionAttempts(store: PuzzleTrackStore, sessionId: string): Attempt[] {
  return Repository.attemptsForSession(store, sessionId);
}

/** True when this problem id is already attached to any session attempt. */
function problemSeen(store: PuzzleTrackStore, sessionId: string, problemId: string): boolean {
  const norm = problemId.trim().toLowerCase();
  for (const a of sessionAttempts(store, sessionId)) {
    for (const v of [a.problem_id, a.manual_problem_id]) {
      if (v !== null && v.trim().toLowerCase() === norm) return true;
    }
    const obs = store.liveObservations[a.attempt_id];
    if (obs && obs.problemId.trim().toLowerCase() === norm) return true;
  }
  return false;
}

function makeObservation(attemptId: string, problemId: string, nowMs: number): LiveObservation {
  return {
    attempt_id: attemptId,
    problemId,
    problemRating: null,
    difficultyLabel: null,
    mode: null,
    playerRatingBefore: null,
    siteResult: 'unknown',
    timeUsedSeconds: null,
    movesUsed: null,
    averageMoves: null,
    playerRatingAfter: null,
    ratingChange: null,
    lateArrival: false,
    observedAt: nowIso(nowMs),
  };
}

function fillFromProblem(
  store: PuzzleTrackStore,
  attempt: Attempt,
  event: SiteEvent,
  nowMs: number,
): void {
  const problem = event.problem;
  if (!problem) return;
  attempt.problem_id = problem.problemId;
  attempt.problem_rating = problem.problemRating;
  attempt.difficulty_label = problem.difficultyLabel;
  if (event.context?.displayedRating != null) {
    attempt.player_rating_before = event.context.displayedRating;
  }
  attempt.capture_origin = 'live';
  const obs = makeObservation(attempt.attempt_id, problem.problemId, nowMs);
  obs.problemRating = problem.problemRating;
  obs.difficultyLabel = problem.difficultyLabel;
  obs.mode = problem.mode;
  obs.playerRatingBefore = attempt.player_rating_before;
  store.liveObservations[attempt.attempt_id] = obs;
}

function fillFromResult(attempt: Attempt, obs: LiveObservation, result: SiteResult, nowMs: number): void {
  attempt.chesstempo_result = result.result;
  attempt.chesstempo_time_used_seconds = result.timeUsedSeconds ?? attempt.chesstempo_time_used_seconds;
  attempt.moves_used = result.movesUsed ?? attempt.moves_used;
  attempt.average_moves = result.averageMoves ?? attempt.average_moves;
  attempt.player_rating_after = result.playerRatingAfter ?? attempt.player_rating_after;
  attempt.rating_change = result.ratingChange ?? attempt.rating_change;
  obs.siteResult = result.result;
  obs.timeUsedSeconds = result.timeUsedSeconds ?? obs.timeUsedSeconds;
  obs.movesUsed = result.movesUsed ?? obs.movesUsed;
  obs.averageMoves = result.averageMoves ?? obs.averageMoves;
  obs.playerRatingAfter = result.playerRatingAfter ?? obs.playerRatingAfter;
  obs.ratingChange = result.ratingChange ?? obs.ratingChange;
  obs.observedAt = nowIso(nowMs);
}

function handleProblemLoaded(store: PuzzleTrackStore, event: SiteEvent, nowMs: number): AutoOutcome {
  const gate = activeAutoSession(store);
  if (!('sessionId' in gate)) return gate;
  const { sessionId } = gate;
  const session = store.sessions[sessionId];
  if (!session || !event.problem) return noop('problem-loaded-without-problem');
  const problemId = event.problem.problemId;

  const activeId = store.activeAttemptId;
  if (activeId) {
    const active = store.attempts[activeId];
    if (active && active.problem_id !== null && active.problem_id !== problemId) {
      // Stable different problem while an attempt runs: flag, never guess.
      active.requires_review = true;
    }
    return { handled: true, notes: [`attempt-active-ignored:${problemId}`], directives: [] };
  }

  const attempts = sessionAttempts(store, sessionId);
  const finished = attempts.filter((a) => a.ended_at !== null);
  if (finished.length >= session.target_attempts) {
    // Defensive: finish paths normally complete the session first, so the
    // gate above already rejected. Never start past the target regardless.
    return { handled: true, notes: [`target-reached-ignored:${problemId}`], directives: [] };
  }
  if (problemSeen(store, sessionId, problemId)) {
    return { handled: true, notes: [`duplicate-problem-ignored:${problemId}`], directives: [] };
  }

  const attempt = startAttempt(store, sessionId, nowMs);
  fillFromProblem(store, attempt, event, nowMs);
  return {
    handled: true,
    notes: [`auto-started:${attempt.attempt_id}`],
    directives: [
      {
        kind: 'schedule-timeout',
        attemptId: attempt.attempt_id,
        problemId,
        deadlineMs: Date.parse(attempt.started_at) + attempt.time_limit_seconds * 1000,
      },
      { kind: 'notify-attempt-started', attemptId: attempt.attempt_id, problemId },
    ],
  };
}

function findLateTarget(store: PuzzleTrackStore, sessionId: string, problemId: string): Attempt | null {
  const norm = problemId.trim().toLowerCase();
  const finished = sessionAttempts(store, sessionId)
    .filter((a) => a.ended_at !== null)
    .sort((a, b) => ((a.ended_at as string) < (b.ended_at as string) ? 1 : -1));
  for (const a of finished) {
    const obs = store.liveObservations[a.attempt_id];
    const ids = [a.problem_id, a.manual_problem_id, obs?.problemId ?? null];
    if (!ids.some((v) => v !== null && v.trim().toLowerCase() === norm)) continue;
    // Already has a site result → duplicate arrival, not a late target.
    if (a.chesstempo_result !== null || (obs && obs.siteResult !== 'unknown')) continue;
    return a;
  }
  return null;
}

/**
 * Records a site result that arrived after the experimental attempt ended
 * (timeout race or manual fallback finish). Fills ONLY site metadata —
 * experimental_result, timed_out, elapsed_ms, and ended_at are untouchable.
 */
export function recordLateSiteResult(
  store: PuzzleTrackStore,
  attemptId: string,
  result: SiteResult,
  nowMs: number,
): boolean {
  const attempt = store.attempts[attemptId];
  if (!attempt || attempt.ended_at === null) return false;
  if (attempt.chesstempo_result !== null) return false; // duplicate arrival
  fillFromResult(attempt, liveObsFor(store, attemptId, result.problemId, nowMs), result, nowMs);
  const obs = store.liveObservations[attemptId];
  if (obs) obs.lateArrival = true;
  return true;
}

function liveObsFor(store: PuzzleTrackStore, attemptId: string, problemId: string, nowMs: number): LiveObservation {
  const existing = store.liveObservations[attemptId];
  if (existing) return existing;
  const obs = makeObservation(attemptId, problemId, nowMs);
  store.liveObservations[attemptId] = obs;
  return obs;
}

function recordStepDuration(store: PuzzleTrackStore, event: SiteEvent, sessionId: string): AutoOutcome {
  if (!event.problemId || event.stepNumber === undefined || event.durationMs === undefined) return noop('step-event-incomplete');
  const candidates = sessionAttempts(store, sessionId)
    .filter((a) => a.problem_id === event.problemId)
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const active = store.activeAttemptId ? store.attempts[store.activeAttemptId] : undefined;
  const attempt = active?.session_id === sessionId && active.problem_id === event.problemId
    ? active
    : candidates[0];
  if (!attempt) return noop(`no-attempt-for-step:${event.problemId}`);

  const timings = [...(attempt.step_durations_ms ?? [])];
  const index = timings.findIndex((s) => s.step_number === event.stepNumber);
  if (index >= 0) {
    const previous = timings[index];
    if (previous?.duration_ms === null && event.durationMs !== null) {
      timings[index] = { step_number: event.stepNumber, duration_ms: event.durationMs };
    } else if (previous && previous.duration_ms !== event.durationMs) {
      attempt.requires_review = true;
    } else {
      return { handled: true, notes: [`duplicate-step-ignored:${event.stepNumber}`], directives: [] };
    }
  } else {
    timings.push({ step_number: event.stepNumber, duration_ms: event.durationMs });
    timings.sort((a, b) => a.step_number - b.step_number);
  }
  attempt.step_durations_ms = timings;
  if (event.durationMs === null) attempt.requires_review = true;
  return { handled: true, notes: [`step-recorded:${event.stepNumber}`], directives: [] };
}

function handleProblemCompleted(store: PuzzleTrackStore, event: SiteEvent, nowMs: number): AutoOutcome {
  const result = event.result;
  if (!result) return noop('problem-completed-without-result');
  const gate = activeAutoSession(store);
  if (!('sessionId' in gate)) {
    // Last timeout clears activeSessionId. Accept only one unambiguous auto trial.
    const candidates = Object.values(store.attempts).filter(a => a.ended_at !== null &&
      store.sessions[a.session_id]?.auto_mode && a.problem_id === result.problemId &&
      store.sessions[a.session_id]?.study_tab_id === store.bridgeStatus.tabId);
    if (candidates.length !== 1) return gate;
    const a = candidates[0]!;
    if (recordLateSiteResult(store, a.attempt_id, result, nowMs)) return { handled: true, notes: [`late-site-result:${a.attempt_id}`], directives: [] };
    return gate;
  }
  const { sessionId } = gate;

  const activeId = store.activeAttemptId;
  const active = activeId ? store.attempts[activeId] : undefined;
  if (active && active.ended_at === null && active.session_id === sessionId) {
    if (active.problem_id !== null && active.problem_id !== result.problemId) {
      active.requires_review = true;
      return { handled: true, notes: [`result-mismatch-ignored:${result.problemId}`], directives: [] };
    }
    if (active.problem_id === null) active.problem_id = result.problemId;
    const obs = liveObsFor(store, active.attempt_id, result.problemId, nowMs);
    if (obs.problemId !== result.problemId) {
      active.requires_review = true;
      return { handled: true, notes: [`result-mismatch-ignored:${result.problemId}`], directives: [] };
    }
    completeAttempt(store, active.attempt_id, nowMs);
    const finished = store.attempts[active.attempt_id];
    if (!finished) throw new Error('Attempt vanished during auto-completion.');
    fillFromResult(finished, obs, result, nowMs);
    if (event.problem?.problemRating != null) {
      finished.problem_rating ??= event.problem.problemRating;
      obs.problemRating ??= event.problem.problemRating;
    }
    if (result.result === 'unknown') finished.requires_review = true;
    return {
      handled: true,
      notes: [`auto-completed:${finished.attempt_id}:${result.result}`],
      directives: [{ kind: 'clear-timeout', attemptId: finished.attempt_id, problemId: result.problemId }],
    };
  }

  // No active attempt: late arrival (timeout race or manual fallback finish).
  const late = findLateTarget(store, sessionId, result.problemId);
  if (late && recordLateSiteResult(store, late.attempt_id, result, nowMs)) {
    return { handled: true, notes: [`late-site-result:${late.attempt_id}`], directives: [] };
  }
  return { handled: true, notes: [`result-no-target-ignored:${result.problemId}`], directives: [] };
}

/** Semantic-event entry point. Pure store transition; background persists + acts on directives. */
export function handleSiteEvent(store: PuzzleTrackStore, event: SiteEvent, nowMs: number = Date.now()): AutoOutcome {
  switch (event.kind) {
    case 'result_updated': {
      if (!event.result) return noop('result-update-without-result');
      const candidates = Object.values(store.attempts).filter(a => a.problem_id === event.result!.problemId && a.capture_origin?.includes('live') && store.sessions[a.session_id]?.study_tab_id === store.bridgeStatus.tabId);
      if (candidates.length !== 1) return noop('ambiguous-result-update');
      const a = candidates[0]!, obs = store.liveObservations[a.attempt_id];
      if (!obs || nowMs < Date.parse(obs.observedAt)) return noop('stale-result-update');
      if (a.chesstempo_result !== event.result.result) { a.requires_review = true; return noop('result-update-conflict'); }
      fillFromResult(a, obs, event.result, nowMs);
      a.problem_rating ??= event.problem?.problemRating ?? null;
      obs.problemRating ??= event.problem?.problemRating ?? null;
      return { handled: true, notes: ['result-metadata-updated'], directives: [] };
    }
    case 'step_completed': {
      const sessionId = store.activeSessionId;
      if (!sessionId || store.sessions[sessionId]?.auto_mode !== true) return noop('session-not-auto');
      return recordStepDuration(store, event, sessionId);
    }
    case 'problem_loaded':
      return handleProblemLoaded(store, event, nowMs);
    case 'problem_completed':
      return handleProblemCompleted(store, event, nowMs);
    case 'problem_changed': {
      const gate = activeAutoSession(store);
      if (!('sessionId' in gate)) return gate;
      const active = store.activeAttemptId ? store.attempts[store.activeAttemptId] : undefined;
      if (active && active.ended_at === null) active.requires_review = true;
      return { handled: true, notes: ['problem-changed-flagged'], directives: [] };
    }
    default:
      return noop(`ignored:${event.kind}`);
  }
}
