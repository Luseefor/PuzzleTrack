/**
 * Applying ChessTempo matches to attempts (v0.2).
 *
 * Rules:
 * - Only null -> value transitions for chess fields, OR explicit conflict
 *   resolution by the researcher. Experimental timing/integrity fields are
 *   NEVER touched here.
 * - 1:1 enforced both ways: one attempt <-> one row.
 * - Conflicts never silently overwrite: applyMatch reports them and writes
 *   nothing until the researcher chooses keepExisting | useNew.
 */
import { newUuid } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';
import type { Attempt, PuzzleTrackStore } from '../models/types.js';
import type {
  AttemptMatch,
  ChessTempoAttempt,
  ChessTempoImport,
  LiveObservation,
  MatchConflict,
  MatchConfidence,
} from '../models/chesstempo.js';
import { rowDedupKey } from '../importer/chesstempoImporter.js';

type ChessField = Extract<
  keyof Attempt,
  | 'problem_id'
  | 'problem_rating'
  | 'player_rating_before'
  | 'player_rating_after'
  | 'chesstempo_result'
  | 'moves_used'
  | 'average_moves'
  | 'rating_change'
  | 'difficulty_label'
  | 'chesstempo_attempted_at'
  | 'chesstempo_time_used_seconds'
>;

const CHESS_FIELDS: ChessField[] = [
  'problem_id',
  'problem_rating',
  'player_rating_before',
  'player_rating_after',
  'chesstempo_result',
  'moves_used',
  'average_moves',
  'rating_change',
  'difficulty_label',
  'chesstempo_attempted_at',
  'chesstempo_time_used_seconds',
];

function rowValues(row: ChessTempoAttempt): Record<ChessField, string | number | null> {
  return {
    problem_id: row.problemId,
    problem_rating: row.problemRating,
    player_rating_before: row.playerRatingBefore,
    player_rating_after: row.playerRatingAfter,
    chesstempo_result: row.result,
    moves_used: row.movesUsed,
    average_moves: row.averageMoves,
    rating_change: row.ratingChange,
    difficulty_label: row.difficultyLabel,
    chesstempo_attempted_at: row.attemptedAt,
    chesstempo_time_used_seconds: row.timeUsedSeconds,
  };
}

function valuesDiffer(a: unknown, b: unknown): boolean {
  if (a === null || b === null) return false; // nulls never conflict, they get filled
  if (typeof a === 'number' && typeof b === 'number') return a !== b;
  return String(a).toLowerCase() !== String(b).toLowerCase();
}

const CORRECT_TOKENS = ['win', 'won', 'correct', 'solved', 'success', '1', '1-0', 'true', 'yes'];
const INCORRECT_TOKENS = ['loss', 'lost', 'incorrect', 'wrong', 'fail', 'failed', 'mistake', '0', '0-1', 'false', 'no'];

/**
 * Do two raw result strings agree semantically? Live observations store
 * normalized outcomes ("correct") while history exports carry raw vendor
 * vocabulary ("Win") — a naive string compare would flag false conflicts.
 * Vague outcomes ("completed", "failed", "unknown") agree only on exact match:
 * they neither confirm nor deny a specific history result, so disagreement
 * routes to human review instead of silent confirmation.
 */
export function resultsAgree(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return true; // missing values never disagree
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (x === y) return true;
  const bucket = (t: string): string => {
    if (CORRECT_TOKENS.includes(t)) return 'correct';
    if (INCORRECT_TOKENS.includes(t)) return 'incorrect';
    return `other:${t}`;
  };
  return bucket(x) === bucket(y);
}

export type ConflictResolution = 'keepExisting' | 'useNew';

export interface ApplyMatchInput {
  attemptId: string;
  row: ChessTempoAttempt;
  confidence: MatchConfidence;
  reasons: string[];
  timeDeltaMs: number | null;
  matchedBy: 'auto' | 'manual';
  resolution?: ConflictResolution;
  nowMs?: number;
}

export interface ApplyMatchResult {
  applied: boolean;
  match: AttemptMatch | null;
  conflicts: MatchConflict[];
}

export function detectConflicts(
  attempt: Attempt,
  row: ChessTempoAttempt,
  importId: string,
): MatchConflict[] {
  const incoming = rowValues(row);
  const conflicts: MatchConflict[] = [];
  for (const field of CHESS_FIELDS) {
    const existing = attempt[field] as string | number | null;
    const next = incoming[field];
    if (existing !== null && next !== null) {
      const differ = field === 'chesstempo_result'
        ? !resultsAgree(String(existing), String(next))
        : valuesDiffer(existing, next);
      if (differ) {
        conflicts.push({
          attemptId: attempt.attempt_id,
          field,
          existingValue: existing,
          incomingValue: next,
          incomingRowId: row.rowId,
          incomingImportId: importId,
        });
      }
    }
  }
  return conflicts;
}

/** Row already linked to a DIFFERENT attempt (1:1 reverse enforcement). */
export function rowClaimedBy(store: PuzzleTrackStore, rowId: string, exceptAttemptId?: string): string | null {
  for (const [attemptId, m] of Object.entries(store.matches)) {
    if (m.chessTempoRowId === rowId && attemptId !== exceptAttemptId) return attemptId;
  }
  return null;
}

export function applyMatch(store: PuzzleTrackStore, input: ApplyMatchInput): ApplyMatchResult {
  const attempt = store.attempts[input.attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  const existingMatch = store.matches[input.attemptId];
  if (existingMatch && existingMatch.chessTempoRowId !== input.row.rowId) {
    throw new Error('This attempt already has an active match. Unmatch first to replace it.');
  }
  const claimed = rowClaimedBy(store, input.row.rowId, input.attemptId);
  if (claimed !== null) {
    throw new Error('This ChessTempo row is already matched to another attempt. One row cannot match two attempts.');
  }

  const conflicts = detectConflicts(attempt, input.row, input.row.importId);
  const nowMs = input.nowMs ?? Date.now();

  if (conflicts.length > 0 && input.resolution === undefined) {
    return { applied: false, match: null, conflicts };
  }

  const incoming = rowValues(input.row);
  if (input.resolution === undefined || input.resolution === 'useNew') {
    for (const field of CHESS_FIELDS) {
      const next = incoming[field];
      if (next !== null) (attempt[field] as string | number | null) = next;
    }
  }
  // keepExisting: chess values untouched; provenance link still recorded.

  attempt.chesstempo_import_id = input.row.importId;
  attempt.chesstempo_source_row = input.row.sourceRow;
  attempt.match_confidence = input.confidence;

  // v0.3 cross-validation: a live observation plus an official history row is
  // stronger than either alone. Agreement confirms; disagreement is surfaced
  // through the existing conflict flow, never silently reconciled.
  const live = store.liveObservations[attempt.attempt_id];
  if (live) {
    attempt.capture_origin = 'live+history';
    attempt.cross_validation = liveAgreesWithRow(live, input.row) ? 'confirmed' : 'conflict';
  } else {
    if (attempt.capture_origin === null) attempt.capture_origin = 'history';
    // cross_validation untouched: no live claim to confirm.
  }

  const match: AttemptMatch = {
    matchId: existingMatch?.matchId ?? newUuid(),
    attemptId: attempt.attempt_id,
    chessTempoRowId: input.row.rowId,
    importId: input.row.importId,
    confidence: input.confidence,
    reasons: input.reasons,
    timeDeltaMs: input.timeDeltaMs,
    matchedAt: nowIso(nowMs),
    matchedBy: input.matchedBy,
    conflictResolved: conflicts.length > 0,
  };
  store.matches[attempt.attempt_id] = match;
  refreshImportCounts(store, input.row.importId);
  return { applied: true, match, conflicts };
}

/** Remove a match link and clear history-sourced fields (researcher correction). */
export function unmatchAttempt(store: PuzzleTrackStore, attemptId: string): void {
  const attempt = store.attempts[attemptId];
  if (!attempt) throw new Error('Attempt not found.');
  const match = store.matches[attemptId];
  for (const field of CHESS_FIELDS) (attempt[field] as string | number | null) = null;
  attempt.chesstempo_import_id = null;
  attempt.chesstempo_source_row = null;
  attempt.match_confidence = null;
  // v0.3: live-captured values belong to the observation, not the match —
  // restore them instead of erasing the participant's live run.
  const live = store.liveObservations[attemptId];
  if (live) {
    attempt.problem_id = live.problemId;
    attempt.problem_rating = live.problemRating;
    attempt.player_rating_before = live.playerRatingBefore;
    attempt.chesstempo_result = live.siteResult === 'unknown' ? null : live.siteResult;
    attempt.moves_used = live.movesUsed;
    attempt.average_moves = live.averageMoves;
    attempt.player_rating_after = live.playerRatingAfter;
    attempt.rating_change = live.ratingChange;
    attempt.chesstempo_time_used_seconds = live.timeUsedSeconds;
    attempt.capture_origin = 'live';
  } else if (attempt.capture_origin === 'history') {
    attempt.capture_origin = null;
  }
  attempt.cross_validation = null;
  if (match) {
    delete store.matches[attemptId];
    refreshImportCounts(store, match.importId);
  }
}

/**
 * v0.3: does a live observation agree with an official history row?
 * Compares identity + measurable fields with small tolerances for clock
 * rounding (time-used ±2 s). Missing values on either side never disagree.
 */
export function liveAgreesWithRow(live: LiveObservation, row: ChessTempoAttempt): boolean {
  if (row.problemId !== null && row.problemId.trim().toLowerCase() !== live.problemId.trim().toLowerCase()) return false;
  if (row.problemRating !== null && live.problemRating !== null && row.problemRating !== live.problemRating) return false;
  if (row.timeUsedSeconds !== null && live.timeUsedSeconds !== null && Math.abs(row.timeUsedSeconds - live.timeUsedSeconds) > 2) return false;
  if (row.result !== null && live.siteResult !== 'unknown' && !resultsAgree(live.siteResult, row.result)) return false;
  return true;
}

export function refreshImportCounts(store: PuzzleTrackStore, importId: string): void {
  const imp = store.imports[importId];
  if (!imp) return;
  const rows = store.importRows[importId] ?? [];
  const claimedRowIds = new Set(Object.values(store.matches).filter((m) => m.importId === importId).map((m) => m.chessTempoRowId));
  imp.matchedRows = rows.filter((r) => claimedRowIds.has(r.rowId)).length;
  imp.unmatchedRows = rows.length - imp.matchedRows;
}

export interface RegisterImportResult {
  skippedDuplicates: number;
  storedRows: number;
}

/**
 * Persist an import + its rows. Exact dedup-key duplicates of already-stored
 * rows are skipped (never duplicated); the report tells the researcher what
 * was already imported.
 */
export function registerImport(
  store: PuzzleTrackStore,
  imp: ChessTempoImport,
  rows: ChessTempoAttempt[],
): RegisterImportResult {
  if (store.imports[imp.importId]) throw new Error('This import is already registered.');
  const knownKeys = new Set<string>();
  for (const existing of Object.values(store.importRows).flat()) knownKeys.add(rowDedupKey(existing));

  const fresh: ChessTempoAttempt[] = [];
  let skippedDuplicates = 0;
  for (const r of rows) {
    const k = rowDedupKey(r);
    if (knownKeys.has(k)) {
      skippedDuplicates++;
      continue;
    }
    knownKeys.add(k);
    fresh.push(r);
  }
  store.imports[imp.importId] = { ...imp };
  store.importRows[imp.importId] = fresh;
  refreshImportCounts(store, imp.importId);

  return { skippedDuplicates, storedRows: fresh.length };
}

/** All normalized rows across imports (matching candidate pool). */
export function allImportedRows(store: PuzzleTrackStore): ChessTempoAttempt[] {
  return Object.values(store.importRows).flat();
}
