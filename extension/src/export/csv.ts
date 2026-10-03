/**
 * CSV export — one row per attempt. ISO-8601 timestamps, exact raw ms,
 * RFC-4180 escaping (quotes/commas/newlines). Null -> empty cell.
 *
 * Columns are grouped: EXPERIMENT (raw) | CHESS RAW (manual import only,
 * preserved exactly) | PROVENANCE | DERIVED (computed on demand at export;
 * see analysis/derived.ts — never stored as authoritative raw values).
 */
import type { Attempt, Session, PuzzleTrackStore } from '../models/types.js';
import { firstMoveBenchmark } from '../trainer/benchmark.js';
import { summarizeSearch } from '../research/searchCapture.js';
import { awayTimePercentage, relativeDifficulty, timerDifferenceSeconds } from '../analysis/derived.js';

export const ATTEMPT_CSV_COLUMNS = [
  'participant_id',
  'session_id',
  'attempt_id',
  'attempt_number',
  'started_at',
  'ended_at',
  'elapsed_ms',
  'elapsed_seconds',
  'time_limit_seconds',
  'timed_out',
  'experimental_result',
  'focus_loss_count',
  'total_time_away_ms',
  'integrity_flag',
  'problem_id',
  'problem_rating',
  'player_rating_before',
  'player_rating_after',
  'chesstempo_result',
  'moves_used',
  'average_moves',
  'rating_change',
  'difficulty_label',
  // v0.2 CHESS RAW (manual ChessTempo import, preserved exactly)
  'chesstempo_attempted_at',
  'chesstempo_time_used_seconds',
  'step_durations_ms',
  // v0.2 PROVENANCE
  'match_confidence',
  'chesstempo_import_id',
  'chesstempo_source_row',
  // v0.3 LIVE-BRIDGE PROVENANCE (null unless the live bridge captured data)
  'capture_origin',
  'cross_validation',
  // v0.2 DERIVED (computed at export; null when inputs missing)
  'relative_difficulty',
  'timer_difference_seconds',
  'away_time_percentage',
  'manual_problem_id', 'possibly_interrupted', 'requires_review',
  'collector_version', 'protocol_id', 'auto_mode', 'task_source',
  'participant_skill_rating', 'participant_skill_rating_source', 'participant_skill_recorded_at',
  'randomization_seed', 'pool_sha256', 'randomization_algorithm', 'planned_count',
  'planned_problem_id', 'planned_problem_rating', 'planned_rating_source',
  'first_candidate', 'first_candidate_elapsed_ms', 'final_choice', 'final_choice_elapsed_ms',
  'stop_reason', 'candidate_count', 'evaluation_gap_cp', 'missed_better_option',
  'research_events', 'integrity_events', 'live_observation', 'pilot_review',
  'session_target_attempts', 'problem_rating_source', 'player_rating_source',
  'local_trial', 'task_outcome', 'source_pool_sha256', 'presented_at',
  'first_move_solver_wdl', 'first_move_best_wdl', 'first_move_wdl_regret',
  'study_phase', 'schedule_sha256', 'schedule_day', 'batch_code', 'difficulty_band',
  'schedule_opens_at', 'schedule_closes_at', 'schedule_json',
  'prior_chess_practice_minutes', 'prior_chess_practice_notes', 'practice_reported_at',
] as const;

export type AttemptCsvColumn = (typeof ATTEMPT_CSV_COLUMNS)[number];

export function escapeCsvCell(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return escapeCsvCell(String(v));
}

export interface ExportRow {
  participant_id: string;
  attempt: Attempt;
}

/** Build CSV text for attempts (optionally scoped to one session). */
export function attemptsToCsv(participantBySession: Map<string, string>, attempts: Attempt[], context?: PuzzleTrackStore): string {
  const lines: string[] = [];
  lines.push(ATTEMPT_CSV_COLUMNS.join(','));
  const sorted = [...attempts].sort((a, b) =>
    a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.attempt_number - b.attempt_number,
  );
  for (const a of sorted) {
    const participant_id = participantBySession.get(a.session_id) ?? '';
    const session = context?.sessions[a.session_id];
    const study = session?.study;
    const assigned = study?.plan?.ordered_puzzles[a.attempt_number - 1];
    const source=context?.localPools?.[study?.local_pool_sha256??'']?.data.source;
    let band: string | null=null;
    try {const bands=JSON.parse(source?.schedule_json??'null')?.bands as {id:string;min:number;max:number}[] | undefined; band=bands?.find(b=>a.local_trial && a.local_trial.rating>=b.min && a.local_trial.rating<=b.max)?.id??null;} catch { /* Invalid provenance remains unavailable; never guess a band. */ }
    const search = context?.researchEvents?.[a.attempt_id] ?? [];
    const row: Record<AttemptCsvColumn, unknown> = {
      participant_id,
      study_phase: source?.study_phase??null, schedule_sha256: source?.schedule_sha256??null,
      schedule_day: source?.schedule_day??null, batch_code: source?.batch_code??null, difficulty_band: band,
      schedule_opens_at: source?.schedule_opens_at??null, schedule_closes_at: source?.schedule_closes_at??null, schedule_json: source?.schedule_json??null,
      prior_chess_practice_minutes: study?.practice_report?.minutes??null, prior_chess_practice_notes: study?.practice_report?.notes??null, practice_reported_at: study?.practice_report?.recorded_at??null,
      ...firstMoveBenchmark(a.local_trial),
      session_target_attempts: session?.target_attempts ?? null,
      problem_rating_source: a.local_trial?.rating_source ?? (a.problem_rating !== null ? 'chesstempo' : null),
      local_trial: a.local_trial ? JSON.stringify(a.local_trial) : null,
      task_outcome: a.local_trial?.outcome ?? null,
      source_pool_sha256: a.local_trial?.pool_sha256 ?? null,
      presented_at: a.local_trial?.presented_at ?? null,
      player_rating_source: a.player_rating_before !== null || a.player_rating_after !== null ? 'chesstempo' : null,
      session_id: a.session_id,
      attempt_id: a.attempt_id,
      attempt_number: a.attempt_number,
      started_at: a.started_at,
      ended_at: a.ended_at ?? '',
      elapsed_ms: a.elapsed_ms,
      // Do NOT round: full double precision of elapsed_ms/1000.
      elapsed_seconds: a.elapsed_seconds,
      time_limit_seconds: a.time_limit_seconds,
      timed_out: a.timed_out,
      experimental_result: a.experimental_result ?? '',
      focus_loss_count: a.focus_loss_count,
      total_time_away_ms: a.total_time_away_ms,
      integrity_flag: a.integrity_flag,
      problem_id: a.local_trial?.puzzle_id ?? a.problem_id,
      problem_rating: a.local_trial?.rating ?? a.problem_rating,
      player_rating_before: a.player_rating_before,
      player_rating_after: a.player_rating_after,
      chesstempo_result: a.chesstempo_result,
      moves_used: a.moves_used,
      average_moves: a.average_moves,
      rating_change: a.rating_change,
      difficulty_label: a.difficulty_label,
      chesstempo_attempted_at: a.chesstempo_attempted_at,
      chesstempo_time_used_seconds: a.chesstempo_time_used_seconds,
      step_durations_ms: a.step_durations_ms === null ? null : JSON.stringify(a.step_durations_ms),
      match_confidence: a.match_confidence,
      chesstempo_import_id: a.chesstempo_import_id,
      chesstempo_source_row: a.chesstempo_source_row,
      capture_origin: a.capture_origin,
      cross_validation: a.cross_validation,
      relative_difficulty: relativeDifficulty(a),
      timer_difference_seconds: timerDifferenceSeconds(a),
      away_time_percentage: awayTimePercentage(a),
      manual_problem_id: a.manual_problem_id,
      possibly_interrupted: a.possibly_interrupted,
      requires_review: a.requires_review,
      collector_version: session?.collector_version ?? null,
      protocol_id: session?.protocol_id ?? null,
      auto_mode: session?.auto_mode ?? null,
      task_source: study?.task_source ?? null,
      participant_skill_rating: study?.skill_rating ?? null,
      participant_skill_rating_source: study?.skill_rating_source ?? null,
      participant_skill_recorded_at: study?.skill_recorded_at ?? null,
      randomization_seed: study?.plan?.seed ?? null,
      pool_sha256: study?.plan?.pool_sha256 ?? null,
      randomization_algorithm: study?.plan?.algorithm ?? null,
      planned_count: study?.plan?.ordered_puzzles.length ?? null,
      planned_problem_id: assigned?.id ?? null,
      planned_problem_rating: assigned?.rating ?? null,
      planned_rating_source: assigned?.rating_source ?? null,
      ...summarizeSearch(search),
      candidate_count: study?.search_capture_enabled ? summarizeSearch(search).candidate_count : null,
      research_events: context ? JSON.stringify(search) : null,
      integrity_events: context ? JSON.stringify(context.events[a.attempt_id] ?? []) : null,
      live_observation: context?.liveObservations[a.attempt_id] ? JSON.stringify(context.liveObservations[a.attempt_id]) : null,
      pilot_review: context?.pilotReview[a.attempt_id] ? JSON.stringify(context.pilotReview[a.attempt_id]) : null,
    };
    lines.push(ATTEMPT_CSV_COLUMNS.map((c) => cell(row[c])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function downloadFilename(scope: string, whenIso: string): string {
  const safe = whenIso.replace(/[:.]/g, '-');
  return `puzzletrack-${scope}-${safe}.csv`;
}

export type { Session };
