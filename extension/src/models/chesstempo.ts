/**
 * ChessTempo import domain types (v0.2).
 *
 * All ChessTempo data arrives via MANUAL file import (user-downloaded history
 * CSV). No scraping, no network, no DOM access — ever. Raw values are preserved
 * exactly; derived research variables are computed on demand (see analysis/).
 */
import type { Attempt } from './types.js';

/** Confidence of a PuzzleTrack <-> ChessTempo match. Never silently guessed. */
export type MatchConfidence = 'exact' | 'high' | 'medium' | 'low' | 'unmatched';

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
