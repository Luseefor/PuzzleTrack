/**
 * Centralized ChessTempo selectors (v0.3). ALL page-structure knowledge lives
 * in this file — nothing in session/timer/repository/analysis/matching,
 * the auto controller, or the background worker may reference selectors.
 *
 * STATUS: UNCALIBRATED. ChessTempo publishes no documented DOM contract, so
 * these are structural best guesses plus stable `data-pt-*` hooks that a
 * researcher can add to a local calibration harness page. The adapter treats
 * every selector as fallible: missing elements yield null fields (never
 * guesses), and total marker loss drives ADAPTER_ERROR, never bad data.
 *
 * Recalibration procedure lives in docs/CHESSTEMPO_LIVE_BRIDGE.md.
 * Field roles (never collect anything outside these roles):
 * - training marker: proves this is an endgame/tactics training page.
 * - problem id: primary identity signal for problem transitions.
 * - problem rating / difficulty / mode: visible metadata.
 * - player rating: displayed rating continuity (no usernames).
 * - result: visible end-of-problem state.
 * - time used / moves: visible result metadata.
 */
export interface SelectorRole {
  /** Stable key used in diagnostics (e.g. "problem-id"). */
  role: string;
  /** Candidate selectors in preference order. First match wins. */
  candidates: string[];
}

/** Marker proving the page is a training page (all must be absent → not training). */
export const TRAINING_MARKERS: string[] = [
  'ct-clock[data-id="endgames"]',
  'body.ct-body-problems-solve-view-mode',
  '[data-pt-training-page]',
  '#chess-tempo-training',
  '.ct-training-board',
  '#tactics-board',
];

export const FIELD_SELECTORS: SelectorRole[] = [
  { role: 'problem-id', candidates: ['[data-pt-problem-id]', 'a[aria-label^="Problem number"]', '.ct-problem-info-collapsible a[href*="/chess-endgames/"]', '.ct-problem-id', '.problem-number', '#problem-id'] },
  { role: 'problem-rating', candidates: ['[data-pt-problem-rating]', '.ct-problem-info-collapsible .ct-collapsible-header-content', '.ct-problem-rating', '.problem-rating'] },
  { role: 'difficulty', candidates: ['[data-pt-difficulty]', '.ct-difficulty', '.difficulty-label'] },
  { role: 'mode', candidates: ['[data-pt-mode]', '.ct-training-mode', '.training-mode'] },
  { role: 'player-rating', candidates: ['[data-pt-player-rating]', '.ct-player-rating', '.user-rating'] },
  { role: 'result', candidates: ['[data-pt-result]', '.ct-problem-result-output[role="alert"]', '.ct-result', '.puzzle-result', '#puzzle-result'] },
  { role: 'time-used', candidates: ['[data-pt-time-used]', '.ct-problems-clock-to-move ct-clock[role="timer"]', '.ct-time-used', '.time-used'] },
  // Keep this list limited to move-count fields. The generic result output
  // also contains the player's rating on ChessTempo, so parsing it as a move
  // count silently turned ratings (for example 672) into moves.
  { role: 'moves', candidates: ['[data-pt-moves]', '.ct-moves-used', '.moves-used'] },
  { role: 'step-counter', candidates: ['[data-pt-step-counter]', '.ct-step-counter', '.move-counter', '.ply-counter'] },
  { role: 'rating-after', candidates: ['[data-pt-rating-after]', '.ct-rating-after'] },
  { role: 'rating-change', candidates: ['[data-pt-rating-change]', '.ct-rating-change'] },
];

/** Result-state marker: presence means the problem visibly ended. */
export const RESULT_MARKERS: string[] = [
  '.ct-problem-result-output[role="alert"]',
  '.ct-problem-result',
  '[data-pt-result-visible]',
  '.ct-result-visible',
  '.puzzle-complete',
  '#next-puzzle',
];

/** Attribute read for problem identity when present (preferred over text). */
export const PROBLEM_ID_ATTRIBUTE = 'data-pt-problem-id';
