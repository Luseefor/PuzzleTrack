/**
 * ChessTempo adapter semantic types (v0.3). Plain data only — no DOM, no
 * selectors, no page references leak past the adapter boundary. Core modules
 * (session/timer/repository/analysis/matching) communicate with the bridge
 * exclusively through these types.
 */

/** Minimum visible problem metadata the adapter may extract. */
export interface SiteProblem {
  problemId: string;
  problemRating: number | null;
  difficultyLabel: string | null;
  /** Training mode label as displayed, if any. */
  mode: string | null;
}

/** Minimum participant context. Usernames are NEVER collected. */
export interface SiteParticipantContext {
  displayedRating: number | null;
}

/** Visible result metadata. Nulls where the page shows nothing usable. */
export interface SiteResult {
  problemId: string;
  result: 'correct' | 'incorrect' | 'completed' | 'failed' | 'unknown';
  timeUsedSeconds: number | null;
  movesUsed: number | null;
  averageMoves: number | null;
  playerRatingAfter: number | null;
  ratingChange: number | null;
}

export type SiteEventKind =
  | 'site_ready'
  | 'problem_loaded'
  | 'problem_completed'
  | 'result_updated'
  | 'step_completed'
  | 'problem_changed'
  | 'participant_context_changed'
  | 'adapter_lost'
  | 'adapter_recovered';

export interface SiteEvent {
  kind: SiteEventKind;
  atMs: number;
  problem?: SiteProblem;
  result?: SiteResult;
  /** One visible step counter transition. Null duration represents a missed transition. */
  stepNumber?: number;
  problemId?: string;
  durationMs?: number | null;
  context?: SiteParticipantContext;
  /** Previous problem id for problem_changed. */
  previousProblemId?: string;
  /** Human-readable cause for adapter_lost. */
  reason?: string;
}

/**
 * Adapter lifecycle states. The adapter mirrors the page — attempt timing
 * stays owned by the PuzzleTrack auto controller in the background worker.
 * - NO_PROBLEM: no stable training problem visible.
 * - PROBLEM_READY: a new problem is stable and was reported once.
 * - ATTEMPT_ACTIVE: background confirmed a PuzzleTrack attempt started.
 * - RESULT_DETECTED: a result was reported for the active problem.
 * - WAITING_FOR_NEXT: result UI cleared, same problem still shown.
 * - ADAPTER_ERROR: required page markers vanished; no data recorded.
 */
export type AdapterState =
  | 'NO_PROBLEM'
  | 'PROBLEM_READY'
  | 'ATTEMPT_ACTIVE'
  | 'RESULT_DETECTED'
  | 'WAITING_FOR_NEXT'
  | 'ADAPTER_ERROR';

/** A single parsed observation of the page (produced by the observer). */
export interface PageReading {
  /** False when the page is not (or no longer) a training page. */
  trainingPage: boolean;
  problemId: string | null;
  problemRating: number | null;
  difficultyLabel: string | null;
  mode: string | null;
  displayedRating: number | null;
  /** Non-null only when a result state is visibly reported. */
  result: SiteResult['result'] | null;
  timeUsedSeconds: number | null;
  movesUsed: number | null;
  /** Explicit visible step counter; step text itself is never retained. */
  stepNumber: number | null;
  stepTotal: number | null;
  playerRatingAfter: number | null;
  ratingChange: number | null;
  /** Which semantic fields were found vs missing (diagnostics only). */
  foundFields: string[];
  missingFields: string[];
}

/** Field-presence diagnostics for calibration mode. Values included, DOM never. */
export interface AdapterDiagnostics {
  connected: boolean;
  state: AdapterState;
  problemId: string | null;
  problemRating: number | null;
  playerRating: number | null;
  result: SiteResult['result'] | null;
  stepNumber: number | null;
  stepTotal: number | null;
  foundFields: string[];
  missingFields: string[];
}
