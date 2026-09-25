/**
 * Integrity / focus monitoring — pure state machine.
 *
 * Tracked signals (only whether OUR study context lost focus + how long):
 *   - document visibilitychange  -> tab_hidden / tab_visible
 *   - window blur/focus          -> window_blur / window_focus
 *   - chrome.windows.onFocusChanged (background) -> window_blur / window_focus
 *   - study-tab tracking (v0.2)  -> study_tab_inactive / study_tab_active
 *     (stores ONLY the numeric tab id; never URL, title, or contents)
 *
 * We NEVER record URLs, titles, app names, keys, or contents — only the
 * fact + duration of the interruption. integrity_flag means "one or more
 * focus interruptions occurred", never "cheated".
 *
 * Overlap problem: a tab switch typically fires window_blur AND tab_hidden
 * (and study_tab_inactive) within milliseconds. Naively summing each signal
 * would double/triple-count. Solution: a single `awaySinceMs` — the first
 * loss-signal opens ONE away-window; any further loss-signals while already
 * away are ignored; the window closes only when EVERY tracked axis is
 * present again.
 *
 * Away (v0.2) = study tab is not active OR browser window is not focused
 * (document visibility is folded into the same union). When no study tab is
 * designated (v0.1 sessions), that axis is ignored so v0.1 derivations are
 * bit-for-bit reproducible.
 */

import type { IntegrityEvent, IntegrityEventType } from '../models/types.js';

export type FocusLossType = 'tab_hidden' | 'window_blur';
export type FocusRegainType = 'tab_visible' | 'window_focus';

export interface FocusState {
  visible: boolean;
  focused: boolean;
  /**
   * Study-tab axis. null = no study tab designated for this session
   * (v0.1 data): axis ignored, preserving v0.1 derivations exactly.
   */
  studyTabActive: boolean | null;
  /** ms epoch when the current away-window opened, or null when present. */
  awaySinceMs: number | null;
  totalAwayMs: number;
  lossCount: number;
}

export function initialFocusState(hasStudyTab = false): FocusState {
  return {
    visible: true,
    focused: true,
    studyTabActive: hasStudyTab ? true : null,
    awaySinceMs: null,
    totalAwayMs: 0,
    lossCount: 0,
  };
}

export function isLossEvent(t: IntegrityEventType): boolean {
  return t === 'tab_hidden' || t === 'window_blur' || t === 'study_tab_inactive';
}

export function isRegainEvent(t: IntegrityEventType): boolean {
  return t === 'tab_visible' || t === 'window_focus' || t === 'study_tab_active';
}

/**
 * Apply one integrity event to the state. Pure + deterministic.
 * Each *transition* present -> away increments lossCount once.
 */
export function applyFocusEvent(state: FocusState, eventType: IntegrityEventType, atMs: number): FocusState {
  const next: FocusState = { ...state };
  const wasAway = next.awaySinceMs !== null;

  if (eventType === 'tab_hidden') next.visible = false;
  else if (eventType === 'tab_visible') next.visible = true;
  else if (eventType === 'window_blur') next.focused = false;
  else if (eventType === 'window_focus') next.focused = true;
  else if (eventType === 'study_tab_inactive') {
    // Only meaningful when a study tab is designated; otherwise ignore
    // so stray events can never perturb v0.1 derivations.
    if (next.studyTabActive === null) return next;
    next.studyTabActive = false;
  } else if (eventType === 'study_tab_active') {
    // Only meaningful when a study tab is designated; otherwise ignore
    // so stray events can never perturb v0.1 derivations.
    if (next.studyTabActive !== null) next.studyTabActive = true;
    else return next;
  } else return next; // lifecycle events (attempt_started/completed/...) don't affect focus

  const studyAway = next.studyTabActive === false;
  const isAway = !next.visible || !next.focused || studyAway;
  if (!wasAway && isAway) {
    next.awaySinceMs = atMs;
    next.lossCount += 1;
  } else if (wasAway && !isAway) {
    const since = next.awaySinceMs as number;
    next.totalAwayMs += Math.max(0, atMs - since);
    next.awaySinceMs = null;
  }
  // already-away + another loss signal: ignore (no double count, no extra lossCount)
  // present + redundant regain signal: ignore
  return next;
}

export interface DerivedIntegrity {
  focus_loss_count: number;
  total_time_away_ms: number;
  integrity_flag: boolean;
}

/**
 * Recompute derived attempt fields from the raw event log.
 * If the attempt is still open (away window unclosed), away time is
 * measured up to `nowMs` without mutating stored events.
 * Pass hasStudyTab=true when the session designated a study tab.
 */
export function deriveIntegrity(events: IntegrityEvent[], nowMs: number, hasStudyTab = false): DerivedIntegrity {
  const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let state = initialFocusState(hasStudyTab);
  for (const e of sorted) {
    state = applyFocusEvent(state, e.event_type, Date.parse(e.timestamp));
  }
  let total = state.totalAwayMs;
  if (state.awaySinceMs !== null) total += Math.max(0, nowMs - state.awaySinceMs);
  return {
    focus_loss_count: state.lossCount,
    total_time_away_ms: total,
    integrity_flag: state.lossCount > 0,
  };
}

/** Close an open away-window at attempt end so stored total_time_away_ms is exact. */
export function closeAwayWindow(state: FocusState, endedAtMs: number): FocusState {
  if (state.awaySinceMs === null) return { ...state };
  return {
    ...state,
    visible: true,
    focused: true,
    studyTabActive: state.studyTabActive === null ? null : true,
    totalAwayMs: state.totalAwayMs + Math.max(0, endedAtMs - (state.awaySinceMs as number)),
    awaySinceMs: null,
  };
}
