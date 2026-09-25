/**
 * Pilot-instrument validator (read-only).
 *
 * Pure deterministic inspection of stored research data. NEVER modifies
 * records, NEVER repairs anything — it only surfaces errors (integrity
 * violations) and warnings (pilot QA items needing human review).
 *
 * Thresholds for timer agreement are pilot QA indicators, NOT scientific
 * thresholds: GOOD ≤ 2 s, REVIEW ≤ 5 s, WARNING > 5 s.
 */
import { SUPPORTED_TIME_LIMITS, type Attempt, type IntegrityEvent, type PuzzleTrackStore } from '../models/types.js';
import { Repository } from '../storage/repository.js';
import { isUuid } from '../utils/ids.js';
import {
  awayTimePercentage,
  relativeDifficulty,
  summarizeChess,
  timerDifferenceSeconds,
} from '../analysis/derived.js';
import { summarizeSession } from '../session/sessionManager.js';

/** Events landing after attempt end within this window are merge stragglers, not violations. */
export const EVENT_AFTER_END_TOLERANCE_MS = 2000;

export type TimerAgreement = 'good' | 'review' | 'warning' | 'missing';

export function classifyTimerAgreement(diffSeconds: number | null): TimerAgreement {
  if (diffSeconds === null || !Number.isFinite(diffSeconds)) return 'missing';
  const abs = Math.abs(diffSeconds);
  if (abs <= 2) return 'good';
  if (abs <= 5) return 'review';
  return 'warning';
}

export interface ValidationIssue {
  code: string;
  message: string;
  sessionId?: string;
  attemptId?: string;
}

export interface ValidationSummary {
  sessions: number;
  attempts: number;
  events: number;
  chessTempoRows: number;
  matched: number;
  errors: number;
  warnings: number;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  summary: ValidationSummary;
}

function err(issues: ValidationIssue[], code: string, message: string, ids?: { sessionId?: string; attemptId?: string }): void {
  const issue: ValidationIssue = { code, message };
  if (ids?.sessionId !== undefined) issue.sessionId = ids.sessionId;
  if (ids?.attemptId !== undefined) issue.attemptId = ids.attemptId;
  issues.push(issue);
}

function isValidIso(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}

function checkSession(store: PuzzleTrackStore, sessionId: string, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const session = store.sessions[sessionId];
  if (!session) return;
  const ids = { sessionId };
  if (!store.participants[session.participant_id]) {
    err(errors, 'session-missing-participant', `Session ${sessionId.slice(0, 8)} references unknown participant "${session.participant_id}".`, ids);
  }
  if (!isValidIso(session.started_at)) err(errors, 'session-bad-start', `Session ${sessionId.slice(0, 8)} has invalid started_at.`, ids);
  if (!Number.isInteger(session.target_attempts) || session.target_attempts < 1 || session.target_attempts > 100) {
    err(errors, 'session-bad-target', `Session ${sessionId.slice(0, 8)} has invalid target_attempts (${session.target_attempts}).`, ids);
  }
  if (!(SUPPORTED_TIME_LIMITS as readonly number[]).includes(session.time_limit_seconds)) {
    err(errors, 'session-bad-limit', `Session ${sessionId.slice(0, 8)} has unsupported time_limit_seconds (${session.time_limit_seconds}).`, ids);
  }
  if (session.status === 'completed' && session.completed_at === null) {
    err(errors, 'session-missing-completed-at', `Completed session ${sessionId.slice(0, 8)} has no completed_at.`, ids);
  }
  if (session.status === 'active' && session.completed_at !== null) {
    err(errors, 'session-active-with-completed-at', `Active session ${sessionId.slice(0, 8)} unexpectedly has completed_at set.`, ids);
  }

  const attempts = Repository.attemptsForSession(store, sessionId);
  const numbers = attempts.map((a) => a.attempt_number);
  if (new Set(numbers).size !== numbers.length) {
    err(errors, 'session-duplicate-numbers', `Session ${sessionId.slice(0, 8)} has duplicate attempt numbers.`, ids);
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  if (!sorted.every((n, i) => n === i + 1)) {
    err(errors, 'session-non-sequential', `Session ${sessionId.slice(0, 8)} attempt numbers are not sequential from 1.`, ids);
  }
  const finished = attempts.filter((a) => a.ended_at !== null);
  if (session.status === 'completed') {
    if (finished.length !== session.target_attempts) {
      err(errors, 'session-count-mismatch', `Completed session ${sessionId.slice(0, 8)} has ${finished.length} finished attempts for target ${session.target_attempts}.`, ids);
    }
    if (attempts.some((a) => a.ended_at === null)) {
      err(errors, 'session-completed-with-active', `Completed session ${sessionId.slice(0, 8)} still has an unfinished attempt.`, ids);
    }
    if (store.activeAttemptId && attempts.some((a) => a.attempt_id === store.activeAttemptId)) {
      err(errors, 'session-completed-with-active-pointer', `Completed session ${sessionId.slice(0, 8)} still owns the active attempt pointer.`, ids);
    }
  } else if (finished.length > session.target_attempts) {
    err(errors, 'session-over-target', `Session ${sessionId.slice(0, 8)} exceeds its target attempt count.`, ids);
  }

  // Cross-check the displayed summary against raw inputs (must be derived, never cached).
  const summary = summarizeSession(store, sessionId);
  if (summary.total !== finished.length || summary.completed + summary.timedOut + summary.aborted !== summary.total) {
    err(errors, 'summary-inconsistent', `Session ${sessionId.slice(0, 8)} summary totals do not reconcile with raw attempts.`, ids);
  }
  const chess = summarizeChess(attempts);
  if (chess.matched + chess.unmatched !== finished.length) {
    err(errors, 'summary-match-mismatch', `Session ${sessionId.slice(0, 8)} matched+unmatched does not equal finished attempts.`, ids);
  }

  const unmatched = finished.filter((a) => !store.matches[a.attempt_id]).length;
  if (unmatched > 0 && finished.length > 0) {
    err(warnings, 'session-unmatched', `Session ${sessionId.slice(0, 8)} contains ${unmatched} unmatched attempt(s).`, ids);
  }
}

function checkAttempt(store: PuzzleTrackStore, a: Attempt, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  const ids = { sessionId: a.session_id, attemptId: a.attempt_id };
  const short = a.attempt_id.slice(0, 8);
  if (!isUuid(a.attempt_id)) err(errors, 'attempt-bad-uuid', `Attempt ${short} is not a valid UUID.`, ids);
  if (!store.sessions[a.session_id]) {
    err(errors, 'attempt-orphan-session', `Attempt ${short} references missing session.`, ids);
    return;
  }
  if (!isValidIso(a.started_at)) {
    err(errors, 'attempt-bad-start', `Attempt ${short} has invalid started_at.`, ids);
    return;
  }
  const startMs = Date.parse(a.started_at);
  if (a.elapsed_ms < 0) err(errors, 'attempt-negative-elapsed', `Attempt ${short} has negative elapsed_ms (${a.elapsed_ms}).`, ids);
  if (!Number.isFinite(a.elapsed_seconds) || !Number.isFinite(a.elapsed_ms)) {
    err(errors, 'attempt-nonfinite-timing', `Attempt ${short} has non-finite timing values.`, ids);
  }
  if (a.time_limit_seconds <= 0) err(errors, 'attempt-bad-limit', `Attempt ${short} has non-positive time_limit_seconds.`, ids);

  const finished = a.ended_at !== null;
  if (finished) {
    if (!isValidIso(a.ended_at as string)) {
      err(errors, 'attempt-bad-end', `Attempt ${short} has invalid ended_at.`, ids);
    } else if (Date.parse(a.ended_at as string) < startMs) {
      err(errors, 'attempt-end-before-start', `Attempt ${short} ended before it started.`, ids);
    }
    if (Math.abs(a.elapsed_seconds - a.elapsed_ms / 1000) > 1e-6) {
      err(errors, 'attempt-elapsed-mismatch', `Attempt ${short} elapsed_seconds does not match elapsed_ms.`, ids);
    }
    if (a.experimental_result === null) {
      err(errors, 'attempt-finished-no-result', `Finished attempt ${short} has no experimental_result.`, ids);
    }
    if (a.timed_out) {
      if (a.experimental_result !== 'timeout') {
        err(errors, 'attempt-timeout-result', `Attempt ${short} timed_out but result is "${a.experimental_result}".`, ids);
      }
      if (a.elapsed_ms !== a.time_limit_seconds * 1000) {
        err(errors, 'attempt-timeout-elapsed', `Timeout attempt ${short} elapsed_ms does not equal the configured limit.`, ids);
      }
    } else if (a.experimental_result === 'completed' || a.experimental_result === 'aborted') {
      // Consistent: non-timeout results must not carry the timeout flag.
    } else if (a.experimental_result === 'timeout') {
      err(errors, 'attempt-timeout-flag', `Attempt ${short} result is timeout but timed_out is false.`, ids);
    }
  } else if (a.experimental_result !== null) {
    err(errors, 'attempt-active-with-result', `Unfinished attempt ${short} already has a result.`, ids);
  }

  // Events.
  const events = Repository.eventsForAttempt(store, a.attempt_id);
  const types = new Set(events.map((e) => e.event_type));
  if (!types.has('attempt_started')) {
    err(errors, 'events-missing-start', `Attempt ${short} has no attempt_started event.`, ids);
  }
  const terminal = ['attempt_completed', 'timeout', 'abort'].filter((t) => types.has(t as IntegrityEvent['event_type']));
  if (finished && terminal.length === 0) {
    err(errors, 'events-missing-terminal', `Finished attempt ${short} has no terminal event.`, ids);
  }
  if (!finished && terminal.length > 0) {
    err(errors, 'events-terminal-while-active', `Unfinished attempt ${short} already has a terminal event.`, ids);
  }
  const seenEventIds = new Set<string>();
  for (const e of events) {
    if (seenEventIds.has(e.event_id)) {
      err(errors, 'events-duplicate-id', `Attempt ${short} contains duplicate event id ${e.event_id.slice(0, 8)}.`, ids);
    }
    seenEventIds.add(e.event_id);
    if (!isValidIso(e.timestamp)) {
      err(errors, 'events-bad-timestamp', `Attempt ${short} has an event with invalid timestamp.`, ids);
      continue;
    }
    const t = Date.parse(e.timestamp);
    if (t < startMs) {
      err(errors, 'events-before-start', `Attempt ${short} has an event timestamped before attempt start.`, ids);
    }
    if (finished && t > Date.parse(a.ended_at as string) + EVENT_AFTER_END_TOLERANCE_MS) {
      err(errors, 'events-after-end', `Attempt ${short} has an event well after attempt end (beyond merge tolerance).`, ids);
    }
  }

  // Integrity coherence.
  if (a.focus_loss_count < 0) err(errors, 'integrity-negative-losses', `Attempt ${short} has negative focus_loss_count.`, ids);
  if (a.integrity_flag !== a.focus_loss_count > 0) {
    err(errors, 'integrity-flag-mismatch', `Attempt ${short} integrity_flag disagrees with focus_loss_count.`, ids);
  }
  if (finished && a.total_time_away_ms > a.elapsed_ms) {
    err(errors, 'integrity-away-exceeds-elapsed', `Attempt ${short} away time exceeds total elapsed time.`, ids);
  }

  // Derived recomputation (validates the pure functions against stored raw inputs).
  const rel = relativeDifficulty(a);
  if ((a.problem_rating !== null && a.player_rating_before !== null && (rel === null || !Number.isFinite(rel))) ||
      ((a.problem_rating === null || a.player_rating_before === null) && rel !== null)) {
    err(errors, 'derived-relative-difficulty', `Attempt ${short} relative difficulty does not recompute from raw ratings.`, ids);
  }
  const awayPct = awayTimePercentage(a);
  if (awayPct !== null && (!Number.isFinite(awayPct) || awayPct < 0 || awayPct > 1)) {
    err(errors, 'derived-away-percentage', `Attempt ${short} away percentage out of [0,1] or non-finite.`, ids);
  }
  const diff = timerDifferenceSeconds(a);
  if (diff !== null && !Number.isFinite(diff)) {
    err(errors, 'derived-timer-difference', `Attempt ${short} timer difference is non-finite.`, ids);
  }

  // Timer agreement QA (matched attempts only; thresholds are pilot QA, not science).
  if (a.match_confidence !== null && diff !== null) {
    const tier = classifyTimerAgreement(diff);
    if (tier === 'review' || tier === 'warning') {
      err(
        warnings,
        tier === 'review' ? 'timer-agreement-review' : 'timer-agreement-warning',
        `Attempt ${short} has a ${Math.abs(Math.round(diff * 10) / 10)} s PuzzleTrack/ChessTempo timer difference.`,
        ids,
      );
    }
  }
}

function checkChess(store: PuzzleTrackStore, errors: ValidationIssue[]): void {
  const rowToAttempts = new Map<string, string[]>();
  for (const [attemptId, m] of Object.entries(store.matches)) {
    const ids = { attemptId };
    const attempt = store.attempts[attemptId];
    if (!attempt) {
      err(errors, 'match-orphan-attempt', `Match references missing attempt ${attemptId.slice(0, 8)}.`, ids);
      continue;
    }
    const rows = store.importRows[m.importId] ?? [];
    if (!rows.some((r) => r.rowId === m.chessTempoRowId)) {
      err(errors, 'match-orphan-row', `Match for attempt ${attemptId.slice(0, 8)} references missing ChessTempo row.`, ids);
    }
    if (!store.imports[m.importId]) {
      err(errors, 'match-orphan-import', `Match for attempt ${attemptId.slice(0, 8)} references missing import record.`, ids);
    }
    if (attempt.chesstempo_import_id === null || attempt.chesstempo_source_row === null || attempt.match_confidence === null) {
      err(errors, 'match-missing-provenance', `Matched attempt ${attemptId.slice(0, 8)} lacks provenance fields.`, ids);
    }
    if ((m.confidence === 'exact' || m.confidence === 'high') && m.reasons.length === 0) {
      err(errors, 'match-missing-reasons', `Exact/high match for attempt ${attemptId.slice(0, 8)} has no reasons.`, ids);
    }
    const list = rowToAttempts.get(m.chessTempoRowId) ?? [];
    list.push(attemptId);
    rowToAttempts.set(m.chessTempoRowId, list);
  }
  for (const [rowId, ids] of rowToAttempts) {
    if (ids.length > 1) {
      err(errors, 'match-duplicate-row', `ChessTempo row ${rowId} is actively matched to ${ids.length} attempts.`);
    }
  }
  // Silent partial overwrite check: chess values present but no match link.
  for (const a of Object.values(store.attempts)) {
    const hasChess = a.problem_id !== null || a.problem_rating !== null || a.chesstempo_result !== null;
    if (hasChess && !store.matches[a.attempt_id]) {
      err(errors, 'chess-without-match', `Attempt ${a.attempt_id.slice(0, 8)} has chess values but no active match (possible silent overwrite).`, { sessionId: a.session_id, attemptId: a.attempt_id });
    }
  }
}

/** Read-only validation of the full local dataset. Pure and deterministic. */
export function validateStore(store: PuzzleTrackStore): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const sessionId of Object.keys(store.sessions)) checkSession(store, sessionId, errors, warnings);
  for (const attempt of Object.values(store.attempts)) checkAttempt(store, attempt, errors, warnings);
  checkChess(store, errors);
  for (const [attemptId, review] of Object.entries(store.pilotReview)) {
    if (!store.attempts[attemptId]) {
      err(warnings, 'review-orphan', `Pilot review exists for missing attempt ${attemptId.slice(0, 8)}.`, { attemptId });
    }
    if (review.status !== 'unreviewed' && review.status !== 'verified' && review.status !== 'needs_review') {
      err(errors, 'review-bad-status', `Pilot review for attempt ${attemptId.slice(0, 8)} has invalid status.`, { attemptId });
    }
  }
  const eventCount = Object.values(store.events).reduce((n, list) => n + list.length, 0);
  const rowCount = Object.values(store.importRows).reduce((n, rows) => n + rows.length, 0);
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    summary: {
      sessions: Object.keys(store.sessions).length,
      attempts: Object.keys(store.attempts).length,
      events: eventCount,
      chessTempoRows: rowCount,
      matched: Object.keys(store.matches).length,
      errors: errors.length,
      warnings: warnings.length,
    },
  };
}
