/**
 * PuzzleTrack v0.2 domain models.
 *
 * Design notes:
 * - All timestamps are ISO-8601 strings in UTC (new Date().toISOString()).
 * - Raw timing (elapsed_ms) is never rounded; elapsed_seconds is derived.
 * - ChessTempo fields are filled ONLY by manual history import (v0.2+).
 * - Records are append-only: completed attempts must not be mutated via UI,
 *   except the optional manual_problem_id annotation (audited via event).
 * - Derived research variables are computed on demand, never stored as raw.
 */

import type { FrozenTrainingPool, LocalTrial } from '../trainer/types.js';
import type { AttemptMatch, ChessTempoAttempt, ChessTempoImport, LiveObservation, MatchConfidence, StepDuration } from './chesstempo.js';

export type { AttemptMatch, ChessTempoAttempt, ChessTempoImport, LiveObservation, MatchConfidence, StepDuration };

/** Supported per-puzzle time limits (seconds). Experimental conditions. */
export const SUPPORTED_TIME_LIMITS = [900, 1200, 1800, 2700, 3600] as const;
export type SupportedTimeLimit = (typeof SUPPORTED_TIME_LIMITS)[number];

export const SUPPORTED_TIME_LIMIT_LABELS: Record<SupportedTimeLimit, string> = {
  900: '15 minutes',
  1200: '20 minutes',
  1800: '30 minutes',
  2700: '45 minutes',
  3600: '60 minutes',
};

export interface Participant {
  participant_id: string;
  created_at: string; // ISO timestamp
}

export type SessionStatus = 'active' | 'completed' | 'abandoned';

export interface Session {
  session_id: string; // UUID
  participant_id: string;
  target_attempts: number;
  time_limit_seconds: number;
  started_at: string; // ISO
  completed_at: string | null; // ISO | null
  status: SessionStatus;
  /**
   * Designated study tab id (chrome tab id, number) for this session.
   * Stores ONLY the numeric id — never URL, title, or contents.
   */
  study_tab_id: number | null;
  /**
   * v0.3: automation operating mode. Manual preserves the v0.1/v0.2 workflow
   * exactly; auto lets the (flag-gated) site bridge drive start/completion.
   */
  auto_mode: boolean;
  /** Instrument identity, absent for legacy sessions. */
  collector_version?: string | null;
  protocol_id?: string | null;
  study?: StudyMetadata | null;
}

export interface StudyMetadata {
  protocol_id: string;
  task_source: string;
  skill_rating: number | null;
  skill_rating_source: string | null;
  skill_recorded_at: string | null;
  search_capture_enabled: boolean;
  plan: StudyPlan | null;
  local_pool_sha256?: string;
  excluded_puzzle_ids?: string[];
  excluded_position_keys?: string[];
  practice_report?: { minutes: number | null; notes: string; recorded_at: string; method: 'self-report-since-previous-session-or-24h-first' };
}

export interface StudyPuzzle { id: string; rating: number; rating_source: string; task_type: string }
export interface StudyPlan {
  algorithm: 'sha256-xorshift32-fisher-yates-v1';
  seed: string;
  pool_sha256: string;
  count_min: number;
  count_max: number;
  /** Frozen source reference pool, sufficient to replay the draw; legacy plans may omit it. */
  pool?: StudyPuzzle[];
  ordered_puzzles: StudyPuzzle[];
  /** Independent seeded time-condition draw; absent on legacy/fixed-time plans. */
  time_assignment?: {
    algorithm: 'sha256-xorshift32-time-conditions-v1';
    options_seconds: number[];
    ordered_seconds: number[];
  };
}

/** Explicit input, never inferred from timing; provisional protocol. */
export type ResearchEvent = {
  event_id: string;
  attempt_id: string;
  recorded_at: string;
  method: 'manual-search-v1-provisional' | 'endgame-search-v1-provisional';
  step_number?: number;
} & (
  | { kind: 'candidate'; move: string; elapsed_ms: number }
  | { kind: 'decision'; move: string; elapsed_ms: number; stop_reason: 'satisfied' | 'time_pressure' | 'exhausted_options' | 'other' }
  | { kind: 'benchmark'; best_move: string; engine_name: string; engine_version: string; configuration: string; position_reference: string; chosen_cp: number; best_cp: number; threshold_cp: number; perspective: 'solver'; source: 'researcher_supplied' }
);

export type ExperimentalResult = 'completed' | 'timeout' | 'aborted';

/** Active attempt in progress (ended_at === null). */
export type AttemptStatus = 'in_progress' | 'finished';

export interface Attempt {
  local_trial?: LocalTrial;
  attempt_id: string; // UUID
  session_id: string; // UUID
  attempt_number: number; // 1-based within session

  started_at: string; // ISO
  ended_at: string | null; // ISO | null

  /** Exact measured wall-clock duration. Integer ms, never rounded. */
  elapsed_ms: number;
  /** Derived: elapsed_ms / 1000. For timeouts equals time_limit_seconds exactly. */
  elapsed_seconds: number;

  time_limit_seconds: number;

  timed_out: boolean;
  /** Null while in progress; set exactly once on finish. */
  experimental_result: ExperimentalResult | null;

  focus_loss_count: number;
  total_time_away_ms: number;
  /** True iff >= 1 focus interruption occurred. Means "interrupted", NOT "cheated". */
  integrity_flag: boolean;

  /** True when a browser restart/close was detected mid-attempt. Never auto-fabricates a result. */
  possibly_interrupted: boolean;

  // --- ChessTempo fields: filled ONLY by manual history import (v0.2+) ---
  problem_id: string | null;
  problem_rating: number | null;
  player_rating_before: number | null;
  player_rating_after: number | null;
  chesstempo_result: string | null;
  moves_used: number | null;
  average_moves: number | null;
  rating_change: number | null;
  difficulty_label: string | null;

  // --- v0.2 provenance + raw ChessTempo values (never derived) ---
  /** Optional researcher/participant annotation to aid matching. Audited via event. */
  manual_problem_id: string | null;
  /** Raw ChessTempo attempt timestamp, preserved exactly. */
  chesstempo_attempted_at: string | null;
  /** Raw ChessTempo time-used, preserved exactly. */
  chesstempo_time_used_seconds: number | null;
  /** Per-step elapsed time from visible step-counter changes; null when unsupported. */
  step_durations_ms: StepDuration[] | null;
  chesstempo_import_id: string | null;
  /** 1-based data-row number in the imported file. */
  chesstempo_source_row: number | null;
  match_confidence: MatchConfidence | null;

  // --- v0.3 live-bridge provenance (all null unless the live bridge captured data) ---
  /** Where the chess metadata originated: manual entry, live observation, history import, or both. */
  capture_origin: 'manual' | 'live' | 'history' | 'live+history' | null;
  /** Cross-validation of live observation against official history export. */
  cross_validation: 'confirmed' | 'conflict' | null;
  /** True when automation could not interpret the site result confidently. Raw timing still preserved. */
  requires_review: boolean;
}

export type IntegrityEventType =
  | 'attempt_started'
  | 'tab_hidden'
  | 'tab_visible'
  | 'window_blur'
  | 'window_focus'
  | 'study_tab_inactive'
  | 'study_tab_active'
  | 'problem_id_set'
  | 'attempt_completed'
  | 'timeout'
  | 'abort';

export interface IntegrityEvent {
  event_id: string; // UUID
  attempt_id: string; // UUID
  timestamp: string; // ISO
  event_type: IntegrityEventType;
  metadata?: Record<string, unknown>;
}

/**
 * Pilot ground-truth review metadata (validation pass, §7).
 * Stored SEPARATELY from raw observations: changing review status must never
 * touch attempt/chess fields. Excluded from CSV export; included in JSON backup.
 */
export type PilotVerificationStatus = 'unreviewed' | 'verified' | 'needs_review';

export interface PilotReview {
  attempt_id: string;
  status: PilotVerificationStatus;
  /** Optional researcher note. Free text, local only. */
  note: string;
  updated_at: string; // ISO timestamp
}

/** Current schema version. v1 = original release shape (no version field). */
export const SCHEMA_VERSION = 3;
export const COLLECTOR_VERSION = '0.6.0';

/**
 * Ephemeral live-bridge connection state (v0.3) for the adapter status UI.
 * Persisted only so popup/side-panel/dataset poll it through storage like all
 * other UI state. Contains NO page content — numeric ids and parsed metadata
 * only. Excluded from CSV export.
 */
export interface BridgeStatus {
  connected: boolean;
  /** Active study tab id while connected (numeric only). */
  tabId: number | null;
  problemId: string | null;
  problemRating: number | null;
  playerRating: number | null;
  lastEvent: string | null;
  error: string | null;
  updatedAt: string | null; // ISO timestamp
}

/** Persisted extension state (chrome.storage.local). */
export interface PuzzleTrackStore {
  schemaVersion: number;
  participants: Record<string, Participant>;
  sessions: Record<string, Session>;
  attempts: Record<string, Attempt>;
  /** attempt_id -> events (append-only). */
  events: Record<string, IntegrityEvent[]>;
  activeSessionId: string | null;
  activeAttemptId: string | null;
  /** Last background heartbeat (ms epoch). Used to detect restart gaps. */
  lastHeartbeatMs: number | null;
  /** v0.2: manual ChessTempo history imports (provenance). */
  imports: Record<string, ChessTempoImport>;
  /** v0.2: normalized imported rows per import (for re-matching/audit). */
  importRows: Record<string, ChessTempoAttempt[]>;
  /** v0.2: active matches keyed by attempt_id (1:1 enforced). */
  matches: Record<string, AttemptMatch>;
  /**
   * Pilot review metadata keyed by attempt_id. Separate from raw data:
   * verification status changes never modify attempts, events, or chess fields.
   */
  pilotReview: Record<string, PilotReview>;
  /** v0.3: live-bridge observations keyed by attempt_id (at most one each). */
  liveObservations: Record<string, LiveObservation>;
  /** v0.3: ephemeral live-bridge connection state for the status UI. */
  bridgeStatus: BridgeStatus;
  localPools?: Record<string, FrozenTrainingPool>;
  researchEvents?: Record<string, ResearchEvent[]>;
  bridgeReceipts?: Record<string, string>;
}

export function emptyBridgeStatus(): BridgeStatus {
  return {
    connected: false,
    tabId: null,
    problemId: null,
    problemRating: null,
    playerRating: null,
    lastEvent: null,
    error: null,
    updatedAt: null,
  };
}

export function emptyStore(): PuzzleTrackStore {
  return {
    schemaVersion: SCHEMA_VERSION,
    participants: {},
    sessions: {},
    attempts: {},
    events: {},
    activeSessionId: null,
    activeAttemptId: null,
    lastHeartbeatMs: null,
    imports: {},
    importRows: {},
    matches: {},
    pilotReview: {},
    liveObservations: {},
    bridgeStatus: emptyBridgeStatus(),
    localPools: {},
    researchEvents: {},
    bridgeReceipts: {},
  };
}
