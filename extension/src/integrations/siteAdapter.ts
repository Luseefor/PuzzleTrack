/**
 * Study-site adapter interface (v0.3). The contract every training-site
 * adapter implements. Core PuzzleTrack code depends ONLY on this interface
 * plus the semantic types — never on selectors, DOM nodes, or page layout.
 */
import type { AdapterDiagnostics, SiteEvent, SiteParticipantContext, SiteProblem } from './chessTempo/chessTempoTypes.js';

export interface StudySiteAdapter {
  /** True when the current page looks like a supported training page. */
  detectPage(): boolean;

  /** Visible participant context (ratings only, never usernames). */
  getParticipantContext(): SiteParticipantContext | null;

  /** Currently stable visible problem, or null when none is confirmed. */
  getCurrentProblem(): SiteProblem | null;

  /** Calibration diagnostics (field presence + values, never DOM). */
  getDiagnostics(): AdapterDiagnostics;

  /** Informs the adapter that a PuzzleTrack attempt started/ended. */
  notifyAttemptStarted(problemId: string): void;
  notifyAttemptEnded(problemId: string): void;

  /** Subscribe to semantic events. Returns an unsubscribe function. */
  subscribe(listener: (event: SiteEvent) => void): () => void;

  /** Stop observing entirely (disconnect/shutdown). */
  dispose(): void;
}
