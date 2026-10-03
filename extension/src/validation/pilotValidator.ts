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
import { isSupportedTimeLimit } from '../utils/validation.js';
import type { AdapterDiagnostics } from '../integrations/chessTempo/chessTempoTypes.js';
import { mapHeaders } from '../importer/chesstempoImporter.js';
import { Repository } from '../storage/repository.js';
import { isUuid } from '../utils/ids.js';
import {
  awayTimePercentage,
  relativeDifficulty,
  summarizeChess,
  timerDifferenceSeconds,
} from '../analysis/derived.js';
import { deriveIntegrity } from '../integrity/focusTracker.js';
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
  if (!isSupportedTimeLimit(session.time_limit_seconds)) {
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
  if (unmatched > 0 && finished.some(a => !a.local_trial)) {
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
    if (Date.parse(a.ended_at as string) - startMs !== a.elapsed_ms) {
      err(errors, 'attempt-timestamp-duration', `Attempt ${short} elapsed_ms disagrees with its timestamp interval.`, ids);
    }
    if (!a.timed_out && a.elapsed_ms >= a.time_limit_seconds * 1000) {
      err(errors, 'attempt-overdue-finish', `Attempt ${short} finished at or beyond its deadline without a timeout.`, ids);
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

  if (finished) {
    const endMs = Date.parse(a.ended_at as string);
    const replay = deriveIntegrity(events.filter(e => Date.parse(e.timestamp) <= endMs), endMs, store.sessions[a.session_id]?.study_tab_id != null);
    if (replay.focus_loss_count !== a.focus_loss_count || replay.total_time_away_ms !== a.total_time_away_ms || replay.integrity_flag !== a.integrity_flag) {
      err(errors, 'integrity-log-mismatch', `Attempt ${short} integrity totals disagree with the raw event log.`, ids);
    }
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
  // Detect the pre-0.3.1 signed-decimal import bug without rewriting history.
  for (const rows of Object.values(store.importRows)) {
    for (const row of rows) {
      const headers = Object.keys(row.raw);
      const index = mapHeaders(headers).mapped.ratingChange;
      const text = index === undefined ? '' : row.raw[headers[index]!]!.trim().replace(/,/g, '');
      const signed = text.match(/^(-\d+(?:\.\d+)?)\s*(?:pts?|points?)?$/i);
      if (signed && row.ratingChange !== null && Number(signed[1]) !== row.ratingChange) err(errors, 'import-signed-change-mismatch', `Import ${row.importId.slice(0, 8)} row ${row.sourceRow}: normalized rating change disagrees with the original negative raw cell. Re-review the source; no automatic repair was made.`);
    }
  }
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
      // Live-captured values are legitimate without a history match.
      if (a.capture_origin === 'live' && store.liveObservations[a.attempt_id]) continue;
      err(errors, 'chess-without-match', `Attempt ${a.attempt_id.slice(0, 8)} has chess values but no active match (possible silent overwrite).`, { sessionId: a.session_id, attemptId: a.attempt_id });
    }
    // v0.3 live-bridge provenance coherence.
    if (a.cross_validation !== null && !store.matches[a.attempt_id]) {
      err(errors, 'cross-validation-without-match', `Attempt ${a.attempt_id.slice(0, 8)} has cross-validation status but no active match.`, { sessionId: a.session_id, attemptId: a.attempt_id });
    }
    if (a.cross_validation !== null && !store.liveObservations[a.attempt_id]) {
      err(errors, 'cross-validation-without-live', `Attempt ${a.attempt_id.slice(0, 8)} has cross-validation status but no live observation.`, { sessionId: a.session_id, attemptId: a.attempt_id });
    }
    if (typeof a.requires_review !== 'boolean') {
      err(errors, 'requires-review-type', `Attempt ${a.attempt_id.slice(0, 8)} has non-boolean requires_review.`, { sessionId: a.session_id, attemptId: a.attempt_id });
    }
  }
  for (const attemptId of Object.keys(store.liveObservations)) {
    if (!store.attempts[attemptId]) {
      err(errors, 'live-orphan-attempt', `Live observation references missing attempt ${attemptId.slice(0, 8)}.`, { attemptId });
    }
  }
}


function checkResearch(store: PuzzleTrackStore, errors: ValidationIssue[], warnings: ValidationIssue[]): void {
  for (const session of Object.values(store.sessions)) {
    const ids = { sessionId: session.session_id };
    const study = session.study;
    if (!session.collector_version) err(warnings, 'legacy-collector-version', 'Collector version was not recorded; original timing/parser behavior may differ.', ids);
    if (!study) continue;
    if(study.practice_report && (study.practice_report.minutes!==null && (!Number.isInteger(study.practice_report.minutes)||study.practice_report.minutes<0)||!isValidIso(study.practice_report.recorded_at)))err(errors,'practice-report-invalid','Practice report has an invalid minutes value or timestamp.',ids);
    const sourcePool=store.localPools?.[study.local_pool_sha256??'']?.data;
    const source=sourcePool?.source;
    if(source?.schedule_sha256){
      try{
        const config=JSON.parse(source.schedule_json!) as {bands:{id:string;min:number;max:number}[];days:{seconds:number;quotas:Record<string,number>}[]};
        const day=config.days[Number(source.schedule_day)-1];
        if(!day || session.target_attempts!==10 || session.time_limit_seconds!==day.seconds || source.participant_id!==session.participant_id || sourcePool!.puzzles.length!==10 || sourcePool!.puzzles.some(row=>config.bands.filter(b=>Number(row.Rating)>=b.min&&Number(row.Rating)<=b.max).length!==1) || config.bands.some(b=>sourcePool!.puzzles.filter(row=>Number(row.Rating)>=b.min&&Number(row.Rating)<=b.max).length!==day.quotas[b.id]))err(errors,'scheduled-assignment-mismatch','Participant, count, time or difficulty quotas disagree with the frozen scheduled assignment.',ids);
        if(source.study_phase==='main_study' && (Date.parse(session.started_at)<Date.parse(source.schedule_opens_at!) || Date.parse(session.started_at)>=Date.parse(source.schedule_closes_at!)))err(errors,'scheduled-session-outside-window','Session began outside its archived study window.',ids);
      }catch{err(errors,'scheduled-provenance-invalid','Scheduled configuration is missing or invalid.',ids);}
    }
    if (study.local_pool_sha256 && !store.localPools?.[study.local_pool_sha256]) err(errors, 'local-pool-missing', 'Local session references a missing frozen source pool.', ids);
    if (!study.protocol_id || study.protocol_id !== session.protocol_id) err(errors, 'study-protocol-mismatch', 'Study and session protocol revisions disagree.', ids);
    if (study.skill_rating !== null && (!Number.isFinite(study.skill_rating) || study.skill_rating < 0 || !study.skill_rating_source || !study.skill_recorded_at)) err(errors, 'study-skill-provenance', 'Skill rating lacks a valid value, source/scale or timestamp.', ids);
    if (study.plan && study.plan.ordered_puzzles.length !== session.target_attempts) err(errors, 'study-plan-count', 'Assigned puzzle count differs from session target.', ids);
    if (study.plan && !study.plan.pool) err(warnings, 'study-plan-missing-pool', 'Archive the original pool to replay this legacy draw.', ids);
    if (study.excluded_puzzle_ids && study.plan?.pool?.some(p => study.excluded_puzzle_ids!.includes(p.id))) err(errors, 'study-excluded-pool', 'Eligible reference pool contains a previously excluded puzzle ID.', ids);
    const times = study.plan?.time_assignment;
    if (times && (times.algorithm !== 'sha256-xorshift32-time-conditions-v1' || !times.options_seconds.length || times.options_seconds.some(t => !(SUPPORTED_TIME_LIMITS as readonly number[]).includes(t)) || new Set(times.options_seconds).size !== times.options_seconds.length || times.ordered_seconds.length !== session.target_attempts || times.ordered_seconds.some(t => !times.options_seconds.includes(t)))) err(errors, 'study-plan-times', 'Time assignment must use supported conditions and cover every planned attempt.', ids);
    for (const a of Repository.attemptsForSession(store, session.session_id)) {
      const attemptIds = { ...ids, attemptId: a.attempt_id };
      if (times && a.time_limit_seconds !== times.ordered_seconds[a.attempt_number - 1]) err(errors, 'study-time-mismatch', 'Attempt time limit differs from its saved assignment.', attemptIds);
      const list = store.researchEvents?.[a.attempt_id] ?? [];
      if (a.local_trial) {
        const t = a.local_trial, frozen = store.localPools?.[t.pool_sha256];
        if (study.excluded_puzzle_ids?.includes(t.puzzle_id) || study.excluded_position_keys?.includes(t.presented_fen.split(' ').slice(0,4).join(' '))) err(errors, 'study-repeated-exposure', 'Local attempt presents a position excluded by saved participant history.', attemptIds);
        const source = frozen?.data.puzzles.find(p => p.PuzzleId === t.puzzle_id);
        if (study.local_pool_sha256 !== t.pool_sha256 || !source || source.FEN !== t.initial_fen || Number(source.Rating) !== t.rating || source.Moves?.trim().split(/\s+/).slice(1).join(' ') !== t.solution_uci.join(' ')) err(errors, 'local-source-mismatch', 'Local trial differs from its frozen source ID, rating, position or reference moves.', attemptIds);
        if (a.ended_at !== null && (t.outcome === null || (a.timed_out && t.outcome !== 'timeout'))) err(errors, 'local-outcome-mismatch', 'Local outcome is missing or disagrees with the experimental timeout.', attemptIds);
        let fen = t.presented_fen;
        for (const ply of t.plies) {
          if (ply.fen_before !== fen || ply.elapsed_ms !== Date.parse(ply.recorded_at) - Date.parse(a.started_at) || ply.elapsed_ms < 0 || (a.ended_at && Date.parse(ply.recorded_at) > Date.parse(a.ended_at))) err(errors, 'local-ply-timing', 'Local move log has discontinuous positions or inconsistent timing.', attemptIds);
          fen = ply.fen_after;
        }
        if (fen !== t.current_fen) err(errors, 'local-position-mismatch', 'Current local position does not match its move log.', attemptIds);
      }
      if (study.search_capture_enabled && a.ended_at && (!list.some(e => e.kind === 'candidate' && (e.step_number ?? 1) === 1) || !list.some(e => e.kind === 'decision' && (e.step_number ?? 1) === 1))) err(warnings, 'search-measures-missing', 'Search capture was enabled but an initial-position candidate or decision is missing; do not impute.', attemptIds);
      const assigned = study.plan?.ordered_puzzles[a.attempt_number - 1];
      const actual = a.problem_id ?? a.manual_problem_id;
      if (assigned && actual !== assigned.id) err(warnings, 'study-assignment-unverified', 'Observed/annotated puzzle ID does not confirm the assigned puzzle. A plan does not control the external site.', attemptIds);
      if (a.ended_at && (a.local_trial ? (study.skill_rating === null) : (a.problem_rating === null || a.player_rating_before === null))) err(warnings, 'ratings-missing', 'Participant skill rating is absent for a local trial, or problem/pre-attempt player rating is unavailable for ChessTempo; cross-platform scales must remain separate.', attemptIds);
    }
  }
  const seen = new Set<string>();
  for (const [id, list] of Object.entries(store.researchEvents ?? {})) {
    const a = store.attempts[id];
    if (!a) { err(errors, 'research-orphan', 'Search events reference a missing attempt.', { attemptId: id }); continue; }
    const decisions = new Map<number, number>();
    for (const event of list) {
      const ids = { attemptId: id, sessionId: a.session_id };
      if (seen.has(event.event_id)) err(errors, 'research-duplicate-id', 'Duplicate research event ID.', ids);
      seen.add(event.event_id);
      if (event.attempt_id !== id || !isValidIso(event.recorded_at)) err(errors, 'research-event-identity', 'Research event has inconsistent identity or timestamp.', ids);
      if (event.kind === 'benchmark') {
        if (a.ended_at === null || Date.parse(event.recorded_at) < Date.parse(a.ended_at) || ![event.best_cp, event.chosen_cp, event.threshold_cp].every(Number.isFinite) || event.best_cp < event.chosen_cp || event.threshold_cp < 0) err(errors, 'research-benchmark-invalid', 'Benchmark must follow the trial and contain valid solver-perspective scores.', ids);
      } else {
        if (event.kind === 'decision') { const step = event.step_number ?? 1; decisions.set(step, (decisions.get(step) ?? 0) + 1); }
        const elapsed = Date.parse(event.recorded_at) - Date.parse(a.started_at);
        if (!Number.isFinite(event.elapsed_ms) || event.elapsed_ms !== elapsed || elapsed < 0 || elapsed >= a.time_limit_seconds * 1000 || (a.ended_at && Date.parse(event.recorded_at) > Date.parse(a.ended_at))) err(errors, 'research-choice-timing', 'Search choice timing is outside the trial or disagrees with its timestamp.', ids);
      }
    }
    if ([...decisions.values()].some(count => count > 1)) err(errors, 'research-multiple-decisions', 'Trial has multiple final decisions for one search step.', { attemptId: id });
  }
}

/** Read-only validation of the full local dataset. Pure and deterministic. */
export function validateStore(store: PuzzleTrackStore): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  for (const sessionId of Object.keys(store.sessions)) checkSession(store, sessionId, errors, warnings);
  for (const attempt of Object.values(store.attempts)) checkAttempt(store, attempt, errors, warnings);
  checkChess(store, errors);
  checkResearch(store, errors, warnings);
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

/* ---------------------------------------------------------------------------
 * Pilot readiness (v0.3 calibration pass). Pure assessment of whether the
 * instrument is READY for the 10-puzzle pilot. READY requires every REQUIRED
 * check to pass; desired-field pendings are informational. Intended to run
 * after the TEST01 loop + history import: pre-session runs will show pending
 * items explaining exactly what remains (connect, observe a result, import).
 * ------------------------------------------------------------------------- */

export type ReadinessStatus = 'pass' | 'fail' | 'pending';

export interface ReadinessCheck {
  key: string;
  label: string;
  required: boolean;
  status: ReadinessStatus;
  detail: string;
}

export interface ReadinessReport {
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface ReadinessInput {
  /** Whether this build has the live bridge compiled in. */
  bridgeBuild: boolean;
  /** Live adapter diagnostics, or null when not connected. */
  diagnostics: AdapterDiagnostics | null;
  validation: ValidationReport;
}

function liveValues(store: PuzzleTrackStore): {
  problemIds: boolean;
  problemRatings: boolean;
  playerRatings: boolean;
  results: boolean;
  timeUsed: boolean;
  moves: boolean;
  ratingChange: boolean;
  stepTimes: boolean;
} {
  const obs = Object.values(store.liveObservations);
  return {
    problemIds: obs.length > 0,
    problemRatings: obs.some((o) => o.problemRating !== null),
    playerRatings: obs.some((o) => o.playerRatingBefore !== null),
    results: obs.some((o) => o.siteResult !== 'unknown'),
    timeUsed: obs.some((o) => o.timeUsedSeconds !== null),
    moves: obs.some((o) => o.movesUsed !== null),
    ratingChange: obs.some((o) => o.ratingChange !== null),
    stepTimes: Object.values(store.attempts).some((a) => (a.step_durations_ms ?? []).some((s) => s.duration_ms !== null)),
  };
}

export function computeReadiness(store: PuzzleTrackStore, input: ReadinessInput): ReadinessReport {
  const checks: ReadinessCheck[] = [];
  const req = (key: string, label: string, status: ReadinessStatus, detail: string): void => {
    checks.push({ key, label, required: true, status, detail });
  };
  const des = (key: string, label: string, status: ReadinessStatus, detail: string): void => {
    checks.push({ key, label, required: false, status, detail });
  };

  req(
    'bridge-build',
    'Live bridge build',
    input.bridgeBuild ? 'pass' : 'fail',
    input.bridgeBuild ? 'calibration build active' : 'production build has the bridge disabled — rebuild with PT_LIVE_BRIDGE=1',
  );

  const connected = store.bridgeStatus.connected;
  req(
    'bridge-connected',
    'Live bridge connected',
    connected ? 'pass' : 'fail',
    connected
      ? `study tab #${store.bridgeStatus.tabId ?? '?'}`
      : (store.bridgeStatus.error ?? 'not connected — connect the study tab'),
  );

  const d = input.diagnostics;
  const ever = liveValues(store);
  req(
    'adapter-state',
    'Adapter state machine',
    d ? 'pass' : 'pending',
    d ? `state ${d.state}` : 'connect to assess',
  );

  const fieldCheck = (
    key: string,
    label: string,
    visible: boolean,
    observed: boolean,
    value: string | null,
  ): void => {
    if (visible || observed) {
      req(key, label, 'pass', visible && value !== null ? `visible now (${value})` : 'observed during this study');
    } else if (d) {
      req(key, label, 'fail', 'adapter cannot see this required field — recalibrate selectors');
    } else {
      req(key, label, 'pending', 'connect to assess');
    }
  };
  fieldCheck('req-problem-id', 'Problem ID', d?.problemId != null, ever.problemIds, d?.problemId ?? null);
  fieldCheck(
    'req-problem-rating',
    'Problem rating',
    d?.problemRating != null,
    ever.problemRatings,
    d?.problemRating != null ? String(d.problemRating) : null,
  );
  fieldCheck(
    'req-step-counter',
    'Visible step counter',
    d?.stepNumber != null,
    ever.stepTimes,
    d?.stepNumber != null ? (d.stepTotal === null ? String(d.stepNumber) : `${d.stepNumber} of ${d.stepTotal}`) : null,
  );
  fieldCheck(
    'req-player-rating',
    'Player rating',
    d?.playerRating != null,
    ever.playerRatings,
    d?.playerRating != null ? String(d.playerRating) : null,
  );

  // Result detection can only be proven by an observed result (TEST01 attempt 1).
  if (d?.result != null || ever.results) {
    req('req-result', 'Result detection', 'pass', d?.result != null ? `visible now (${d.result})` : 'observed during this study');
  } else if (d) {
    req('req-result', 'Result detection', 'pending', 'solve one problem to verify result capture');
  } else {
    req('req-result', 'Result detection', 'pending', 'connect to assess');
  }

  const desiredCheck = (key: string, label: string, visible: boolean, observed: boolean): void => {
    if (visible || observed) des(key, label, 'pass', 'observed');
    else if (d) des(key, label, 'pending', 'not yet observed — optional');
    else des(key, label, 'pending', 'connect to assess');
  };
  desiredCheck('des-time-used', 'Time used', (d?.foundFields ?? []).includes('time-used') || ever.timeUsed, ever.timeUsed);
  desiredCheck('des-moves', 'Moves used', (d?.foundFields ?? []).includes('moves') || ever.moves, ever.moves);
  desiredCheck('des-rating-change', 'Rating change', (d?.foundFields ?? []).includes('rating-change') || ever.ratingChange, ever.ratingChange);
  req('step-durations', 'Step durations', ever.stepTimes ? 'pass' : d ? 'pending' : 'pending', ever.stepTimes ? 'recorded' : 'complete a multi-step problem to verify');

  const errors = input.validation.summary.errors;
  req(
    'validation-errors',
    'Dataset validation',
    errors === 0 ? 'pass' : 'fail',
    `${errors} errors, ${input.validation.summary.warnings} warnings`,
  );

  const attempts = Object.values(store.attempts);
  const confirmed = attempts.filter((a) => a.cross_validation === 'confirmed').length;
  const conflicted = attempts.filter((a) => a.cross_validation === 'conflict').length;
  const matched = Object.keys(store.matches).length;
  if (conflicted > 0) {
    req('history', 'History cross-validation', 'fail', `${conflicted} conflict(s) — resolve before piloting`);
  } else if (matched > 0) {
    req('history', 'History cross-validation', 'pass', `${confirmed} / ${matched} confirmed`);
  } else {
    req('history', 'History cross-validation', 'pending', 'import official history to confirm');
  }

  return { ready: checks.filter((c) => c.required).every((c) => c.status === 'pass'), checks };
}
