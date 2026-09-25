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

import type { AttemptMatch, ChessTempoAttempt, ChessTempoImport, MatchConfidence } from './chesstempo.js';

export type { AttemptMatch, ChessTempoAttempt, ChessTempoImport, MatchConfidence };

/** Supported per-puzzle time limits (seconds). Experimental conditions. */
export const SUPPORTED_TIME_LIMITS = [900, 1800, 2700, 3600] as const;
export type SupportedTimeLimit = (typeof SUPPORTED_TIME_LIMITS)[number];

export const SUPPORTED_TIME_LIMIT_LABELS: Record<SupportedTimeLimit, string> = {
  900: '15 minutes',
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
}

export type ExperimentalResult = 'completed' | 'timeout' | 'aborted';

/** Active attempt in progress (ended_at === null). */
export type AttemptStatus = 'in_progress' | 'finished';

export interface Attempt {
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
  chesstempo_import_id: string | null;
  /** 1-based data-row number in the imported file. */
  chesstempo_source_row: number | null;
  match_confidence: MatchConfidence | null;
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
export const SCHEMA_VERSION = 2;

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
  };
}
