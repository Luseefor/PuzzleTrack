/**
 * CSV export — one row per attempt. ISO-8601 timestamps, exact raw ms,
 * RFC-4180 escaping (quotes/commas/newlines). Null -> empty cell.
 *
 * Columns are grouped: EXPERIMENT (raw) | CHESS RAW (manual import only,
 * preserved exactly) | PROVENANCE | DERIVED (computed on demand at export;
 * see analysis/derived.ts — never stored as authoritative raw values).
 */
import type { Attempt, Session } from '../models/types.js';
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
  // v0.2 PROVENANCE
  'match_confidence',
  'chesstempo_import_id',
  'chesstempo_source_row',
  // v0.2 DERIVED (computed at export; null when inputs missing)
  'relative_difficulty',
  'timer_difference_seconds',
  'away_time_percentage',
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
export function attemptsToCsv(participantBySession: Map<string, string>, attempts: Attempt[]): string {
  const lines: string[] = [];
  lines.push(ATTEMPT_CSV_COLUMNS.join(','));
  const sorted = [...attempts].sort((a, b) =>
    a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.attempt_number - b.attempt_number,
  );
  for (const a of sorted) {
    const participant_id = participantBySession.get(a.session_id) ?? '';
    const row: Record<AttemptCsvColumn, unknown> = {
      participant_id,
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
      problem_id: a.problem_id,
      problem_rating: a.problem_rating,
      player_rating_before: a.player_rating_before,
      player_rating_after: a.player_rating_after,
      chesstempo_result: a.chesstempo_result,
      moves_used: a.moves_used,
      average_moves: a.average_moves,
      rating_change: a.rating_change,
      difficulty_label: a.difficulty_label,
      chesstempo_attempted_at: a.chesstempo_attempted_at,
      chesstempo_time_used_seconds: a.chesstempo_time_used_seconds,
      match_confidence: a.match_confidence,
      chesstempo_import_id: a.chesstempo_import_id,
      chesstempo_source_row: a.chesstempo_source_row,
      relative_difficulty: relativeDifficulty(a),
      timer_difference_seconds: timerDifferenceSeconds(a),
      away_time_percentage: awayTimePercentage(a),
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
