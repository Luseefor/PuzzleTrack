/**
 * Session / attempt orchestration. Pure-domain logic operating on PuzzleTrackStore.
 * All time comes from an injected clock (nowMs) so tests are deterministic and
 * production uses Date.now(). UI and background layers handle persistence + alarms.
 */
import { newUuid } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';
import { validateParticipantId, validateTargetAttempts, validateTimeLimit } from '../utils/validation.js';
import { finalizeElapsedMs } from '../timer/attemptTimer.js';
import { closeAwayWindow, deriveIntegrity, initialFocusState, applyFocusEvent } from '../integrity/focusTracker.js';
import { Repository } from '../storage/repository.js';
import type {
  Attempt,
  ExperimentalResult,
  IntegrityEvent,
  IntegrityEventType,
  PilotReview,
  PilotVerificationStatus,
  PuzzleTrackStore,
  Session,
} from '../models/types.js';

export interface SessionSummary {
  total: number;
  completed: number;
  timedOut: number;
  aborted: number;
  medianElapsedMs: number;
  totalFocusInterruptions: number;
  attemptsWithIntegrityFlags: number;
}

function recordEvent(
  store: PuzzleTrackStore,
  attemptId: string,
  type: IntegrityEventType,
  atMs: number,
  metadata?: Record<string, unknown>,
): IntegrityEvent {
  const event: IntegrityEvent = {
    event_id: newUuid(),
    attempt_id: attemptId,
    timestamp: nowIso(atMs),
    event_type: type,
  };
  if (metadata !== undefined) event.metadata = metadata;
  Repository.appendEvent(store, event);
  return event;
}

/** Refresh derived integrity fields on an in-progress attempt. */
export function refreshAttemptIntegrity(store: PuzzleTrackStore, attemptId: string, nowMs: number): void {
  const attempt = store.attempts[attemptId];
  if (!attempt || attempt.ended_at !== null) return;
  const session = store.sessions[attempt.session_id];
  const hasStudyTab = session?.study_tab_id != null;
  const events = Repository.eventsForAttempt(store, attemptId);
  const d = deriveIntegrity(events, nowMs, hasStudyTab);
  attempt.focus_loss_count = d.focus_loss_count;
  attempt.total_time_away_ms = d.total_time_away_ms;
  attempt.integrity_flag = d.integrity_flag;
}

export function createSession(
  store: PuzzleTrackStore,
  participantIdRaw: string,
  targetAttemptsRaw: number,
  timeLimitSecondsRaw: number,
  nowMs: number = Date.now(),
): Session {
  const active = store.activeSessionId ? store.sessions[store.activeSessionId] : undefined;
  if (active && active.status === 'active') {
    throw new Error('Only one active session at a time. Finish or abandon the current session first.');
  }
  if (store.activeAttemptId) throw new Error('Only one active attempt at a time.');
  const participant_id = validateParticipantId(participantIdRaw);
  const target_attempts = validateTargetAttempts(targetAttemptsRaw);
  const time_limit_seconds = validateTimeLimit(timeLimitSecondsRaw);

  if (!store.participants[participant_id]) {
    store.participants[participant_id] = { participant_id, created_at: nowIso(nowMs) };
  }
  const session: Session = {
    session_id: newUuid(),
    participant_id,
    target_attempts,
    time_limit_seconds,
    started_at: nowIso(nowMs),
    completed_at: null,
    status: 'active',
    study_tab_id: null,
  };
  Repository.putSession(store, session);
  store.activeSessionId = session.session_id;
  return session;
}

export function nextAttemptNumber(store: PuzzleTrackStore, sessionId: string): number {
  const attempts = Repository.attemptsForSession(store, sessionId);
  return attempts.length + 1;
}

export function startAttempt(store: PuzzleTrackStore, sessionId: string, nowMs: number = Date.now()): Attempt {
  const session = store.sessions[sessionId];
  if (!session) throw new Error('Session not found.');
  if (session.status !== 'active') throw new Error('Completed session cannot receive new attempts.');
  if (store.activeAttemptId) throw new Error('Only one active attempt at a time.');
  if (store.activeSessionId !== sessionId) throw new Error('This session is not the active session.');

  const existing = Repository.attemptsForSession(store, sessionId);
  const attempt_number = existing.length + 1;
  if (attempt_number > session.target_attempts) throw new Error('Cannot exceed target attempt count.');
  if (existing.some((a) => a.attempt_number === attempt_number)) {
    throw new Error('Attempt numbers cannot duplicate inside one session.');
  }

  const attempt: Attempt = {
    attempt_id: newUuid(),
    session_id: sessionId,
    attempt_number,
    started_at: nowIso(nowMs),
    ended_at: null,
    elapsed_ms: 0,
    elapsed_seconds: 0,
    time_limit_seconds: session.time_limit_seconds,
    timed_out: false,
    experimental_result: null,
    focus_loss_count: 0,
    total_time_away_ms: 0,
    integrity_flag: false,
    possibly_interrupted: false,
    problem_id: null,
    problem_rating: null,
    player_rating_before: null,
    player_rating_after: null,
    chesstempo_result: null,
    moves_used: null,
    average_moves: null,
    rating_change: null,
    difficulty_label: null,
    manual_problem_id: null,
    chesstempo_attempted_at: null,
    chesstempo_time_used_seconds: null,
    chesstempo_import_id: null,
    chesstempo_source_row: null,
    match_confidence: null,
  };
  Repository.putAttempt(store, attempt);
  recordEvent(store, attempt.attempt_id, 'attempt_started', nowMs);
  store.activeAttemptId = attempt.attempt_id;
  return attempt;
}

export function recordFocusSignal(
  store: PuzzleTrackStore,
  attemptId: string,
  type:
    | 'tab_hidden'
    | 'tab_visible'
    | 'window_blur'
    | 'window_focus'
    | 'study_tab_inactive'
    | 'study_tab_active',
  atMs: number = Date.now(),
): void {
  const attempt = store.attempts[attemptId];
  if (!attempt || attempt.ended_at !== null) return; // integrity monitoring only while active
  recordEvent(store, attemptId, type, atMs);
  refreshAttemptIntegrity(store, attemptId, atMs);
}

function finishAttemptCommon(
  store: PuzzleTrackStore,
  attemptId: string,
  result: ExperimentalResult,
  endedAtMs: number,
  elapsedMs: number,
  timedOut: boolean,
): Attempt {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  if (attempt.ended_at !== null) throw new Error('Attempt is already finished.');
  if (elapsedMs < 0) throw new Error('Elapsed time cannot be negative.');

  // Close any open away-window exactly at end time (no double counting).
  const events = Repository.eventsForAttempt(store, attemptId);
  const session = store.sessions[attempt.session_id];
  const hasStudyTab = session?.study_tab_id != null;
  let state = initialFocusState(hasStudyTab);
  for (const e of events) state = applyFocusEvent(state, e.event_type, Date.parse(e.timestamp));
  state = closeAwayWindow(state, endedAtMs);

  attempt.ended_at = nowIso(endedAtMs);
  attempt.elapsed_ms = elapsedMs;
  attempt.elapsed_seconds = elapsedMs / 1000;
  attempt.timed_out = timedOut;
  attempt.experimental_result = result;
  attempt.focus_loss_count = state.lossCount;
  attempt.total_time_away_ms = state.totalAwayMs;
  attempt.integrity_flag = state.lossCount > 0;

  const closingType: IntegrityEventType = result === 'completed' ? 'attempt_completed' : result === 'timeout' ? 'timeout' : 'abort';
  recordEvent(store, attemptId, closingType, endedAtMs);

  if (store.activeAttemptId === attemptId) store.activeAttemptId = null;
  maybeCompleteSession(store, attempt.session_id, endedAtMs);
  return attempt;
}

export function completeAttempt(store: PuzzleTrackStore, attemptId: string, nowMs: number = Date.now()): Attempt {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  const elapsedMs = finalizeElapsedMs(Date.parse(attempt.started_at), nowMs);
  return finishAttemptCommon(store, attemptId, 'completed', nowMs, elapsedMs, false);
}

export function abortAttempt(store: PuzzleTrackStore, attemptId: string, nowMs: number = Date.now()): Attempt {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  const elapsedMs = finalizeElapsedMs(Date.parse(attempt.started_at), nowMs);
  return finishAttemptCommon(store, attemptId, 'aborted', nowMs, elapsedMs, false);
}

/** Timeout is deterministic from timestamps: elapsed = full limit, result locked to timeout. */
export function timeoutAttempt(store: PuzzleTrackStore, attemptId: string, nowMs: number = Date.now()): Attempt {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  const deadlineMs = Date.parse(attempt.started_at) + attempt.time_limit_seconds * 1000;
  const endedAtMs = Math.max(nowMs, deadlineMs);
  const elapsedMs = attempt.time_limit_seconds * 1000;
  return finishAttemptCommon(store, attemptId, 'timeout', endedAtMs, elapsedMs, true);
}

function maybeCompleteSession(store: PuzzleTrackStore, sessionId: string, nowMs: number): void {
  const session = store.sessions[sessionId];
  if (!session || session.status !== 'active') return;
  const attempts = Repository.attemptsForSession(store, sessionId);
  const finished = attempts.filter((a) => a.ended_at !== null);
  if (finished.length >= session.target_attempts) {
    session.status = 'completed';
    session.completed_at = nowIso(nowMs);
    if (store.activeSessionId === sessionId) store.activeSessionId = null;
  }
}

export function summarizeSession(store: PuzzleTrackStore, sessionId: string): SessionSummary {
  const attempts = Repository.attemptsForSession(store, sessionId).filter((a) => a.ended_at !== null);
  const elapsed = attempts.map((a) => a.elapsed_ms).sort((a, b) => a - b);
  const mid = Math.floor(elapsed.length / 2);
  const medianElapsedMs =
    elapsed.length === 0 ? 0 : elapsed.length % 2 === 1 ? (elapsed[mid] as number) : (((elapsed[mid - 1] as number) + (elapsed[mid] as number)) / 2);
  return {
    total: attempts.length,
    completed: attempts.filter((a) => a.experimental_result === 'completed').length,
    timedOut: attempts.filter((a) => a.experimental_result === 'timeout').length,
    aborted: attempts.filter((a) => a.experimental_result === 'aborted').length,
    medianElapsedMs,
    totalFocusInterruptions: attempts.reduce((s, a) => s + a.focus_loss_count, 0),
    attemptsWithIntegrityFlags: attempts.filter((a) => a.integrity_flag).length,
  };
}

/** Researcher action after a crash: mark an interrupted in-progress attempt as aborted. Never deletes data. */
export function markInterruptedAborted(store: PuzzleTrackStore, attemptId: string, nowMs: number = Date.now()): Attempt {
  return abortAttempt(store, attemptId, nowMs);
}

/**
 * Designate a browser tab as the session's study tab.
 * Stores ONLY the numeric tab id — never URL, title, or contents.
 */
export function designateStudyTab(store: PuzzleTrackStore, sessionId: string, tabId: number): Session {
  const session = store.sessions[sessionId];
  if (!session) throw new Error('Session not found.');
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab id.');
  session.study_tab_id = tabId;
  return session;
}

export function clearStudyTab(store: PuzzleTrackStore, sessionId: string): Session {
  const session = store.sessions[sessionId];
  if (!session) throw new Error('Session not found.');
  session.study_tab_id = null;
  return session;
}

/**
 * Optional problem-ID annotation (during or after an attempt) to aid later
 * ChessTempo matching. This touches ONLY manual_problem_id and appends an
 * auditable `problem_id_set` event — experimental raw fields stay immutable.
 */
export function setManualProblemId(
  store: PuzzleTrackStore,
  attemptId: string,
  problemIdRaw: string,
  nowMs: number = Date.now(),
): Attempt {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  const id = problemIdRaw.trim().replace(/^#/, '');
  if (id.length === 0) throw new Error('Problem ID cannot be empty.');
  if (id.length > 64) throw new Error('Problem ID must be 64 characters or fewer.');
  attempt.manual_problem_id = id;
  recordEvent(store, attemptId, 'problem_id_set', nowMs, { problem_id: id });
  return attempt;
}

export function deleteSession(store: PuzzleTrackStore, sessionId: string): void {
  if (store.activeSessionId === sessionId) throw new Error('Cannot delete the active session.');
  const attempts = Repository.attemptsForSession(store, sessionId);
  if (attempts.some((a) => a.attempt_id === store.activeAttemptId)) {
    throw new Error('Cannot delete a session with an active attempt.');
  }
  for (const a of attempts) {
    delete store.attempts[a.attempt_id];
    delete store.events[a.attempt_id];
    delete store.matches[a.attempt_id];
    delete store.pilotReview[a.attempt_id];
  }
  delete store.sessions[sessionId];
}

/**
 * Pilot ground-truth review marker. Writes ONLY the separate pilotReview map —
 * raw attempts, events, and chess fields are never touched. Note length capped
 * to keep the local store small.
 */
export function setPilotReview(
  store: PuzzleTrackStore,
  attemptId: string,
  status: PilotVerificationStatus,
  noteRaw: string = '',
  nowMs: number = Date.now(),
): PilotReview {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  if (status !== 'unreviewed' && status !== 'verified' && status !== 'needs_review') {
    throw new Error('Invalid verification status.');
  }
  const note = noteRaw.trim().slice(0, 500);
  const entry: PilotReview = { attempt_id: attemptId, status, note, updated_at: nowIso(nowMs) };
  store.pilotReview[attemptId] = entry;
  return entry;
}
