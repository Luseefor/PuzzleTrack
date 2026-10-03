/**
 * ChessTempo import domain types (v0.2).
 *
 * All ChessTempo data arrives via MANUAL file import (user-downloaded history
 * CSV). No scraping, no network, no DOM access — ever. Raw values are preserved
 * exactly; derived research variables are computed on demand (see analysis/).
 *
 * v0.3 adds LiveObservation for the flag-gated live bridge. Live observations
 * are semantic snapshots (plain data, no DOM) produced ONLY by the isolated
 * site adapter in src/integrations/ — core modules never touch page content.
 */
import type { Attempt } from './types.js';

/** Confidence of a PuzzleTrack <-> ChessTempo match. Never silently guessed. */
export type MatchConfidence = 'exact' | 'high' | 'medium' | 'low' | 'unmatched';

/** Duration observed for one explicit visible progress step; no move text is retained. */
export interface StepDuration {
  step_number: number;
  /** Null means the page skipped an observable transition, so timing is unknown. */
  duration_ms: number | null;
}

/** Normalized ChessTempo history row. Raw source row kept for audit/debug. */
export interface ChessTempoAttempt {
  /** Stable internal id: `${importId}:row:${sourceRow}`. */
  rowId: string;
  importId: string;
  sourceRow: number; // 1-based data-row number in the uploaded file

  problemId: string | null;
  attemptedAt: string | null; // ISO timestamp | null

  problemRating: number | null;
  playerRatingBefore: number | null;
  playerRatingAfter: number | null;

  result: string | null;

  timeUsedSeconds: number | null;

  movesUsed: number | null;
  averageMoves: number | null;

  ratingChange: number | null;
  difficultyLabel: string | null;

  /** Classification — never silently drop malformed rows. */
  validity: 'valid' | 'partial' | 'invalid';
  validityNotes: string[];

  /** Exact raw parsed cells (header -> cell) for debugging/validation. */
  raw: Record<string, string>;
}

/** Provenance record for one manual history-file import. */
export interface ChessTempoImport {
  importId: string; // UUID
  importedAt: string; // ISO
  originalFilename: string;
  /** Explicit offset used for naive source timestamps; never guessed. Legacy imports: unavailable. */
  timezoneOffsetMinutes?: number | null;
  parserVersion?: string;
  /** FNV-1a hash of normalized file bytes — duplicate-import detection. */
  fileFingerprint: string;
  totalRows: number;
  validRows: number;
  partialRows: number;
  invalidRows: number;
  matchedRows: number;
  unmatchedRows: number;
  recognizedFields: string[];
  missingFields: string[];
  unknownHeaders: string[];
}

/**
 * Link between one PuzzleTrack attempt and one ChessTempo row.
 * 1:1 in both directions (enforced by matching/apply logic).
 */
export interface AttemptMatch {
  matchId: string; // UUID
  attemptId: string;
  chessTempoRowId: string;
  importId: string;
  confidence: MatchConfidence;
  reasons: string[];
  /** CT attemptedAt minus PT ended_at (ms). Null when CT timestamp missing. */
  timeDeltaMs: number | null;
  matchedAt: string; // ISO
  matchedBy: 'auto' | 'manual';
  /** True when applied despite a data conflict (researcher chose a side). */
  conflictResolved: boolean;
}

export interface MatchResult {
  attemptId: string;
  chessTempoRowId: string | null;
  confidence: MatchConfidence;
  reasons: string[];
  timeDeltaMs: number | null;
  /** Other plausible rows (ambiguous cases need manual resolution). */
  candidates: { rowId: string; problemId: string | null; attemptedAt: string | null; timeDeltaMs: number | null }[];
}

/** Field-level conflict between existing matched data and a new import row. */
export interface MatchConflict {
  attemptId: string;
  field: keyof Attempt;
  existingValue: unknown;
  incomingValue: unknown;
  incomingRowId: string;
  incomingImportId: string;
}

/** File-level duplicate analysis before applying an import. */
export interface DuplicateReport {
  alreadyImported: number;
  newRecords: number;
  potentialConflicts: number;
  duplicateRowIds: string[];
  newRowIds: string[];
  conflictRowIds: string[];
}

/**
 * Live observation snapshot (v0.3). Plain semantic data captured by the
 * flag-gated site bridge while the participant solves normally. Every field
 * is nullable: unavailable values stay null, never fabricated. Keyed by
 * attempt_id in the store; one observation per attempt at most.
 */
export interface LiveObservation {
  attempt_id: string;
  problemId: string;
  problemRating: number | null;
  difficultyLabel: string | null;
  /** Training mode label as displayed, if any (e.g. "endgame"). */
  mode: string | null;
  /** Displayed player rating captured BEFORE the attempt started. */
  playerRatingBefore: number | null;
  /** Site result as interpreted by the adapter; "unknown" when ambiguous. */
  siteResult: 'correct' | 'incorrect' | 'completed' | 'failed' | 'unknown';
  timeUsedSeconds: number | null;
  movesUsed: number | null;
  averageMoves: number | null;
  playerRatingAfter: number | null;
  ratingChange: number | null;
  /** True when the observation arrived after the experimental attempt ended. */
  lateArrival: boolean;
  observedAt: string; // ISO timestamp of last update
}
